import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

test("legal routes render anonymously without session effects or API calls, with public links", async () => {
  const result = await build({ entryPoints: [new URL("../app.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    plugins: [{ name: "legal-render", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: { importer: string }) =>
        args.importer.includes("/src/client/") ? { path: "hooks", namespace: "legal-render" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "legal-render" }, () => ({ contents: `
        export const useState = (initial) => {
          const state = globalThis.__legalRender;
          const index = state.index++;
          return [index in state.values ? state.values[index] : typeof initial === 'function' ? initial() : initial, () => {}];
        };
        export const useEffect = (fn) => { globalThis.__legalRender.effects.push(fn); };
        export const useMemo = (fn) => fn();
        export const useRef = (value) => ({ current: value });
        export const useCallback = (fn) => fn;
        export const useLayoutEffect = () => {};
        export const useContext = () => ({});
        export const useId = () => 'test-id';
      ` }));
    } }],
  });
  const { App } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const globals = globalThis as any;
  const previous = { window: globals.window, document: globals.document, fetch: globals.fetch, state: globals.__legalRender };
  const links: string[] = [];
  // Resolve actual component trees, following the existing node render harness.
  // Effects are captured, not silently run as though this were a browser.
  function text(node: any): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join(" ");
    if (typeof node.type === "function") return text(node.type(node.props));
    if (node.props?.href) links.push(node.props.href);
    return text(node.props?.children);
  }
  function render(path: string, values: Record<number, unknown> = {}) {
    links.length = 0;
    globals.window = { location: { pathname: path, search: "" } };
    globals.__legalRender = { index: 0, values, effects: [] };
    return text(App());
  }
  function assertLegalLinks() {
    assert.ok(links.includes("/privacidad"));
    assert.ok(links.includes("/terminos"));
  }
  try {
    globals.document = { title: "" };
    globals.fetch = () => { throw new Error("Legal pages must not fetch sessions or APIs"); };
    for (const path of ["/privacidad", "/privacidad/", "/terminos", "/terminos/"]) {
      const content = render(path);
      assert.match(content, /YouTurno · Janus314/);
      assert.match(content, /1 de noviembre de 2026/);
      assert.match(content, /san\.cayetano\.314@gmail\.com/);
      assert.match(content, /validación jurídica.*pendientes/);
      assert.ok(links.includes("mailto:san.cayetano.314@gmail.com"));
      assertLegalLinks();
      assert.equal(globals.__legalRender.index, 0, "No staff/customer session state is initialized");
      assert.equal(globals.__legalRender.effects.length, 1, "Only the document title effect is registered");
      globals.__legalRender.effects[0]();
      assert.equal(globals.document.title, `${path.startsWith("/privacidad") ? "Política de privacidad" : "Términos de uso"} | YouTurno`);
      assert.doesNotMatch(content, /AUTH_SECRET|GOOGLE_CLIENT_SECRET|Contraseña inicial/);
    }
    assert.match(render("/privacidad"), /no solicita acceso a la bandeja de Gmail/);
    assert.match(render("/terminos"), /ni garantiza notificaciones automáticas/);
    assert.match(render("/", { 1: false }), /Ingresar a Youturno/);
    assertLegalLinks();
    const overview = { google_sign_in: true, company: { name: "Agenda pública" }, services: [], staff: [] };
    assert.match(render("/book/agenda-publica", { 0: "ready", 1: overview }), /Agenda pública/);
    assertLegalLinks();
  } finally {
    for (const [key, value] of Object.entries({ window: previous.window, document: previous.document, fetch: previous.fetch, __legalRender: previous.state })) {
      if (value === undefined) delete globals[key]; else globals[key] = value;
    }
  }
});
