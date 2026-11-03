import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

test("platform login preserves semantics, branding, legal access and the auth submit flow", async () => {
  const result = await build({ entryPoints: [new URL("../app.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    plugins: [{ name: "login-render", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: { importer: string }) =>
        args.importer.includes("/src/client/") ? { path: "hooks", namespace: "login-render" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "login-render" }, () => ({ contents: `
        export const useState = (initial) => {
          const state = globalThis.__loginRender, index = state.index++;
          return [index in state.values ? state.values[index] : initial, value => state.updates.push([index, value])];
        };
        export const useEffect = () => {};
        export const useMemo = fn => fn();
        export const useRef = value => ({current:value});
        export const useCallback = fn => fn;
        export const useLayoutEffect = () => {};
        export const useContext = () => ({});
        export const useId = () => 'test-id';
      ` }));
    } }],
  });
  const { App } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const globals = globalThis as any;
  const previous = { window: globals.window, fetch: globals.fetch, FormData: globals.FormData, __loginRender: globals.__loginRender };
  const nodes: any[] = [];
  function visit(node: any): void {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node.type === "function") { visit(node.type(node.props)); return; }
    nodes.push(node); visit(node.props?.children);
  }
  function render(error = "") {
    nodes.length = 0;
    globals.__loginRender = { index: 0, values: { 1: false, 2: error }, updates: [] };
    visit(App());
  }
  try {
    globals.window = { location: { pathname: "/", search: "" } };
    render();
    assert.equal(nodes.find(n => n.type === "img").props.src, "/brand/youturno-logo.jpg");
    assert.equal(nodes.find(n => n.type === "img").props.alt, "");
    assert.equal(nodes.find(n => n.type === "section").props["aria-labelledby"], "login-title");
    assert.equal(nodes.find(n => n.type === "h1").props.id, "login-title");
    const labels = nodes.filter(n => n.type === "label");
    assert.deepEqual(labels.map(n => n.props.children[0]), ["Correo electrónico", "Contraseña"]);
    const inputs = nodes.filter(n => n.type === "input");
    assert.deepEqual(inputs.map(n => [n.props.name, n.props.type, n.props.autoComplete, n.props.required]),
      [["email", "email", "username", true], ["password", "password", "current-password", true]]);
    assert.equal(nodes.find(n => n.type === "button").props.type, "submit");
    assert.deepEqual(nodes.filter(n => n.type === "a").map(n => n.props.href), ["/privacidad", "/terminos"]);
    assert.equal(nodes.find(n => n.props.className === "platform-login__decoration").props["aria-hidden"], "true");
    assert.equal(nodes.some(n => n.props.role === "alert"), false);
    render("Acceso de ejemplo rechazado");
    assert.equal(nodes.find(n => n.props.role === "alert").props.children, "Acceso de ejemplo rechazado");

    const requests: any[] = [];
    let fail = false;
    globals.FormData = class { get(key: string) { return key === "email" ? "fictional@example.invalid" : "fictional-test-only"; } };
    globals.fetch = async (path: string, options: any) => {
      requests.push([path, options]);
      return new Response(JSON.stringify(fail ? { error: "Mock rejection" } : { csrf: "fictional-csrf" }), { status: fail ? 401 : 200 });
    };
    let prevented = 0;
    const submit = nodes.find(n => n.type === "form").props.onSubmit;
    await submit({ preventDefault() { prevented++; }, currentTarget: {} });
    assert.equal(prevented, 1);
    assert.deepEqual(requests.map(([path, options]) => [path, options.method]), [["/api/auth/login", "POST"], ["/api/auth/session", "GET"]]);
    assert.deepEqual(JSON.parse(requests[0][1].body), { email: "fictional@example.invalid", password: "fictional-test-only" });
    fail = true;
    await submit({ preventDefault() {}, currentTarget: {} });
    assert.equal(requests.length, 3, "A rejected login must not refresh the session");
    assert.deepEqual(globals.__loginRender.updates.at(-1), [2, "Mock rejection"]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globals[key]; else globals[key] = value;
    }
  }
});
