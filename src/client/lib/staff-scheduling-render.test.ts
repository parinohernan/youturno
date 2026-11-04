import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

test("staff editor switches methods without losing interval, hours, qualifications or identity", async () => {
  const result = await build({ entryPoints: [new URL("../components/create-staff.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    plugins: [{ name: "staff-render", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: { importer: string }) => args.importer.endsWith("/create-staff.tsx")
        ? { path: "hooks", namespace: "staff-render" } : undefined);
      builder.onResolve({ filter: /^\.\.\/context$/ }, (args: { importer: string }) => args.importer.endsWith("/create-staff.tsx")
        ? { path: "context", namespace: "staff-render" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "staff-render" }, (args: { path: string }) => ({ contents: args.path === "context"
        ? "export const useApp = () => globalThis.__staffRender.context;"
        : `export const useState = initial => {
          const state = globalThis.__staffRender, index = state.index++;
          if (!(index in state.values)) state.values[index] = initial;
          return [state.values[index], value => { state.values[index] = typeof value === 'function' ? value(state.values[index]) : value; }];
        };` }));
    } }],
  });
  const { CreateStaff } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const globals = globalThis as any;
  const previous = globals.__staffRender;
  const saved: any[] = [];
  const context = { services: [{ id: 4, name: "Fixture service", active: 1 }], setError: () => {},
    addStaff: async (data: unknown) => saved.push(data), updateStaff: async (id: number, data: unknown) => saved.push({ id, ...data as object }) };
  let state = { index: 0, values: [] as unknown[], context };
  let nodes: any[] = [];
  function visit(node: any) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    nodes.push(node); visit(node.props?.children);
  }
  let staff: any;
  function render() {
    globals.__staffRender = state; state.index = 0; nodes = [];
    visit(CreateStaff({ onClose() {}, staff }));
  }
  const byId = (id: string) => nodes.find((node) => node.props?.id === id);
  const changeMode = (value: string) => { byId("scheduling-mode").props.onChange({ currentTarget: { value } }); render(); };
  const save = async () => { await nodes.find((node) => node.props?.children === "Guardar cambios" || node.props?.children === "Agregar integrante" && node.props?.onClick).props.onClick(); render(); };
  try {
    render();
    assert.equal(byId("scheduling-mode").props.value, "fixed");
    assert.equal(byId("scheduling-interval").props.value, 30);
    staff = { id: 7, name: "Fixture professional", email: "fictional@example.invalid", phone: "", title: "Fixture", color: "#123456",
      service_ids: [4], working_hours: { mon: [["09:10", "13:00"]] }, scheduling_mode: "fixed", scheduling_interval: 17 };
    state = { index: 0, values: [], context }; render();
    for (const mode of ["consecutive", "service_duration"]) {
      changeMode(mode);
      assert.equal(byId("scheduling-interval"), undefined);
      await save();
      assert.deepEqual(saved.at(-1), { id: 7, name: staff.name, email: staff.email, phone: "", title: "Fixture", color: "#123456",
        service_ids: [4], working_hours: staff.working_hours, scheduling_mode: mode, scheduling_interval: 17 });
    }
    changeMode("fixed");
    assert.equal(byId("scheduling-interval").props.value, 17);
    byId("scheduling-interval").props.onChange({ currentTarget: { value: "10" } }); render();
    await save();
    assert.equal(saved.at(-1).scheduling_interval, 10);
    const count = saved.length;
    byId("scheduling-interval").props.onChange({ currentTarget: { value: "0" } }); render();
    await save();
    assert.equal(saved.length, count);
    assert.ok(nodes.some((node) => node.props?.role === "alert"));
    changeMode("consecutive");
    await save();
    assert.equal(saved.length, count + 1);
    assert.equal(saved.at(-1).scheduling_interval, 17, "Invalid hidden draft falls back to the saved interval");
  } finally {
    if (previous === undefined) delete globals.__staffRender; else globals.__staffRender = previous;
  }
});
