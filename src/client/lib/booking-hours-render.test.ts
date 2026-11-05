import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

test("public schedule card re-renders with current service and professional selection", async () => {
  // Replace hooks only: exercise the actual component's render with successive states,
  // without claiming browser interaction or running network/session effects.
  const result = await build({ entryPoints: [new URL("../components/book-public.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    plugins: [{ name: "render-state", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: { importer: string }) =>
        args.importer.endsWith("/book-public.tsx") ? { path: "hooks", namespace: "render-state" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "render-state" }, () => ({ contents: `
        export const useState = (initial) => {
          const state = globalThis.__bookingRender;
          const index = state.index++;
          return [index in state.values ? state.values[index] : typeof initial === 'function' ? initial() : initial, () => {}];
        };
        export const useEffect = () => {};
        export const useMemo = (fn) => fn();
        export const useRef = (value) => ({ current: value });
        export const useCallback = (fn) => fn;
        export const useLayoutEffect = () => {};
        export const useContext = () => ({});
        export const useId = () => 'test-id';
      ` }));
    } }],
  });
  const { BookPublic } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const overview = { company: { name: "Salon", business_hours: { mon: [["00:00", "23:59"]] } },
    services: [{ id: 10, name: "Cut" }, { id: 20, name: "Color" }],
    staff: [{ id: 1, name: "Ana", service_ids: [10], effective_hours: { mon: [["09:00", "12:00"]] } },
      { id: 2, name: "Ben", service_ids: [20], effective_hours: { mon: [["15:00", "18:00"]] } }] };
  const globals = globalThis as any;
  const previous = globals.__bookingRender;
  function text(node: any): string {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join(" ");
    return text(node.props?.children);
  }
  function scheduleCard(node: any): any {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) return node.map(scheduleCard).find(Boolean);
    if (node.type?.displayName === "Card" && text(node).includes("Horarios de atención")) return node;
    return scheduleCard(node.props?.children);
  }
  const render = (serviceId: number | null, staffId: number | null) => {
    globals.__bookingRender = { index: 0, values: { 0: "ready", 1: overview, 2: serviceId, 3: staffId, 9: true, 12: false } };
    const tree = BookPublic({ slug: "salon" });
    const card = scheduleCard(tree);
    assert.ok(card, "find the schedule card independently of presentation wrappers");
    return text(card);
  };
  try {
    assert.match(render(null, null), /09:00 a 12:00 · 15:00 a 18:00/);
    const selected = render(null, 1);
    assert.match(selected, /Ana/);
    assert.match(selected, /09:00 a 12:00/);
    assert.doesNotMatch(selected, /15:00|00:00/);
    const service = render(20, null);
    assert.match(service, /Profesionales que realizan Color/);
    assert.match(service, /15:00 a 18:00/);
    assert.doesNotMatch(service, /09:00|00:00/);
    assert.match(render(99, null), /No hay profesionales habilitados/);
  } finally {
    if (previous === undefined) delete globals.__bookingRender;
    else globals.__bookingRender = previous;
  }
});
