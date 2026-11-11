import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
function nodes(node: any): any[] {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}

async function harness() {
  const result = await build({ entryPoints: [new URL("../components/customer-trust-action.tsx", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false,
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    plugins: [{ name: "trust-action-hooks", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: any) => args.importer.endsWith("/customer-trust-action.tsx") ? { path: "hooks", namespace: "trust-action-hooks" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "trust-action-hooks" }, () => ({ contents: `
        export function useState(initial){const s=globalThis.__trustActionHooks,i=s.index++;if(!(i in s.values))s.values[i]=initial;return[s.values[i],v=>{s.values[i]=typeof v==='function'?v(s.values[i]):v}];}
        export function useRef(initial){const s=globalThis.__trustActionHooks,i=s.index++;if(!(i in s.values))s.values[i]={current:initial};return s.values[i];}` }));
    } }] });
  const { CustomerTrustAction } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const global = globalThis as any;
  const hooks = { index: 0, values: [] };
  const client = { id: 1, name: "Fixture with a long name", trust_state: "new" };
  const writes: any[] = [];
  let complete: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  let disabled = false;
  const updateClient = (id: number, body: any) => { writes.push({ id, ...body }); return new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; }); };
  const draw = () => { global.__trustActionHooks = hooks; hooks.index = 0; return nodes(CustomerTrustAction({ client, updateClient, disabled })); };
  const select = (state: string) => draw().find((n) => n.props?.onValueChange).props.onValueChange(state);
  const button = (label: string) => draw().find((n) => n.props?.onClick && n.props?.className === "min-h-11" && nodes(n).includes(label));
  const dialog = () => draw().find((n) => n.props?.onOpenChange && "open" in n.props);
  const trigger = () => draw().find((n) => n.type === "button");
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { draw, select, button, dialog, trigger, client, writes, hooks, settle,
    complete: () => complete(), fail: () => fail(new Error("Fixture failure")), disable: () => { disabled = true; },
    cleanup: () => { delete global.__trustActionHooks; } };
}

test("status action exposes all options, accessible target and stops pointer/keyboard row navigation", async () => {
  const h = await harness();
  try {
    const tree = h.draw();
    assert.deepEqual(tree.filter((n) => n.props?.value && n.props?.className === "min-h-11").map((n) => [n.props.value, n.props.children]), [["new", "Nuevo"], ["returning", "Recurrente"], ["blocked", "Bloqueado"]]);
    assert.match(h.trigger().props["aria-label"], /Cambiar estado de Fixture.*Estado actual: Nuevo/);
    assert.match(h.trigger().props.className, /min-h-11 min-w-11.*focus-visible:ring-2/);
    assert.equal(tree.find((n) => n.props?.onValueChange).props.value, "new");
    for (const eventName of ["onClick", "onPointerDown", "onKeyDown", "onKeyUp"]) {
      let stopped = false, navigations = 0;
      tree[0].props[eventName]({ stopPropagation() { stopped = true; } });
      if (!stopped) navigations++;
      assert.equal(navigations, 0, eventName);
    }
    h.select("new"); assert.equal(h.writes.length, 0);
    h.disable(); h.select("returning"); assert.equal(h.writes.length, 0); assert.equal(h.trigger().props.disabled, true);
  } finally { h.cleanup(); }
});

test("direct status selection waits for server, guards repeated submission, and busy state is per row", async () => {
  const h = await harness();
  try {
    const staleSelect = h.draw().find((n) => n.props?.onValueChange).props.onValueChange;
    staleSelect("returning"); staleSelect("returning"); h.select("blocked");
    assert.deepEqual(h.writes, [{ id: 1, trust_state: "returning" }]);
    assert.equal(h.client.trust_state, "new"); assert.equal(h.trigger().props.disabled, true);
    assert.equal(h.trigger().props["aria-busy"], true); assert.ok(h.draw().includes("Guardando estado…"));
    const other = await harness();
    try { assert.equal(other.trigger().props.disabled, false); } finally { other.cleanup(); }
    h.client.trust_state = "returning"; h.complete(); await h.settle();
    assert.equal(h.trigger().props.disabled, false); assert.ok(h.draw().includes("Estado actualizado: Recurrente."));
    h.select("returning"); assert.equal(h.writes.length, 1);
    h.select("new"); assert.equal(h.writes.at(-1).trust_state, "new"); h.complete(); await h.settle();
  } finally { h.cleanup(); }
});

test("blocking requires named confirmation, cancel never writes, success restores status-trigger focus", async () => {
  const h = await harness();
  try {
    h.select("blocked"); assert.equal(h.writes.length, 0); assert.equal(h.dialog().props.open, true);
    const text = h.draw().filter((n) => typeof n === "string").join(" ");
    assert.match(text, /¿Bloquear a.*Fixture/); assert.match(text, /turnos existentes se conservan y no se cancelan.*administración.*manualmente/);
    h.button("Cancelar").props.onClick(); assert.equal(h.dialog().props.open, false); assert.equal(h.writes.length, 0);
    h.select("blocked"); const confirm = h.button("Confirmar bloqueo"); confirm.props.onClick(); confirm.props.onClick();
    assert.deepEqual(h.writes, [{ id: 1, trust_state: "blocked" }]); assert.equal(h.client.trust_state, "new");
    h.dialog().props.onOpenChange(false); assert.equal(h.dialog().props.open, true);
    h.client.trust_state = "blocked"; h.complete(); await h.settle(); assert.equal(h.dialog().props.open, false);
    let focused = false; h.trigger().ref.current = { focus() { focused = true; } };
    h.draw().find((n) => n.props?.onOpenAutoFocus).props.onCloseAutoFocus({ preventDefault() {} }); assert.equal(focused, true);
  } finally { h.cleanup(); }
});

test("failed changes retain server state with actionable errors and allow explicit retry", async () => {
  const h = await harness();
  try {
    h.select("returning"); h.fail(); await h.settle();
    assert.equal(h.client.trust_state, "new"); assert.equal(h.trigger().props.disabled, false);
    assert.match(h.draw().find((n) => n.props?.role === "alert").props.children, /conexión y sus permisos.*vuelva a intentarlo/);
    h.select("blocked"); h.button("Confirmar bloqueo").props.onClick(); h.fail(); await h.settle();
    assert.equal(h.dialog().props.open, true); assert.equal(h.client.trust_state, "new");
    assert.ok(h.draw().find((n) => n.props?.role === "alert"));
    h.button("Confirmar bloqueo").props.onClick(); assert.equal(h.writes.length, 3); h.complete(); await h.settle();
  } finally { h.cleanup(); }
});
