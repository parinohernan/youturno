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

test("customer trust control labels all states and explains public-only blocking/manual override", async () => {
  const result = await build({ entryPoints: [new URL("../components/customer-trust.tsx", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false });
  const { CustomerTrustBadge, CustomerTrustControl } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  let selected = "new";
  const tree = nodes(CustomerTrustControl({ value: selected, onChange: (value: string) => { selected = value; } }));
  const select = tree.find((n) => n.type === "select");
  assert.equal(tree.find((n) => n.type === "label").props.htmlFor, select.props.id);
  assert.equal(select.props["aria-describedby"], "customer-trust-help");
  assert.deepEqual(tree.filter((n) => n.type === "option").map((n) => [n.props.value, n.props.children]), [["new", "Nuevo"], ["returning", "Recurrente"], ["blocked", "Bloqueado"]]);
  assert.match(tree.find((n) => n.props?.id === "customer-trust-help").props.children, /turnos existentes se conservan.*reservar manualmente/);
  select.props.onChange({ target: { value: "blocked" } }); assert.equal(selected, "blocked");
  assert.equal(CustomerTrustBadge({ state: "blocked" }).props["aria-label"], "Estado del cliente: Bloqueado");
  for (const [state, color, label] of [["new", "yellow", "Nuevo"], ["returning", "green", "Recurrente"], ["blocked", "red", "Bloqueado"]]) {
    const badge = CustomerTrustBadge({ state });
    assert.equal(badge.props.children, label);
    assert.match(badge.props.className, new RegExp(`bg-${color}-100 text-${color}-900`));
    assert.match(badge.props.className, new RegExp(`dark:bg-${color}-950 dark:text-${color}-200`));
  }
});

test("editing contact cannot silently reset promoted trust; only explicit selector changes write it and failed saves preserve the draft", async () => {
  const result = await build({ entryPoints: [new URL("../components/client-detail.tsx", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false,
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    plugins: [{ name: "client-trust-hooks", setup(builder: any) {
      builder.onResolve({ filter: /^\.\.\/context$/ }, () => ({ path: "context", namespace: "client-trust-hooks" }));
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: any) => args.importer.endsWith("/client-detail.tsx") ? { path: "hooks", namespace: "client-trust-hooks" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "client-trust-hooks" }, (args: any) => ({ contents: args.path === "context"
        ? "export const useApp=()=>globalThis.__clientTrustContext;"
        : "export function useState(initial){const s=globalThis.__clientTrustHooks,i=s.index++;if(!(i in s.values))s.values[i]=initial;return[s.values[i],v=>{s.values[i]=typeof v==='function'?v(s.values[i]):v}];}" }));
    } }] });
  const { ClientDetail } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const global = globalThis as any;
  const writes: any[] = []; let fail = false;
  global.__clientTrustHooks = { index: 0, values: [] };
  global.__clientTrustContext = { selectedClient: { id: 1, name: "Fixture", email: "fixture@example.invalid", phone: "", notes: "", created_at: "2037-11-01", trust_state: "new" }, selectedClientAppointments: [],
    updateClient: async (_id: number, body: any) => { writes.push(body); if (fail) throw new Error("Save failed"); } };
  const draw = () => { global.__clientTrustHooks.index = 0; return nodes(ClientDetail()); };
  const click = async (label: string) => { const node = draw().find((n) => n.props?.onClick && nodes(n).includes(label)); assert.ok(node); await node.props.onClick(); };
  try {
    await click("Editar");
    global.__clientTrustContext.selectedClient.trust_state = "returning"; // A completion elsewhere promoted the customer while this profile draft was open.
    await click("Guardar"); assert.equal(Object.hasOwn(writes.at(-1), "trust_state"), false);
    await click("Editar");
    let control = draw().find((n) => n.props?.onChange && n.props?.value === "returning"); assert.ok(control);
    control.props.onChange("blocked"); await click("Guardar"); assert.equal(writes.at(-1).trust_state, "blocked");
    await click("Editar"); control = draw().find((n) => n.props?.onChange && n.props?.value === "returning"); control.props.onChange("new");
    fail = true; await click("Guardar"); assert.equal(writes.at(-1).trust_state, "new");
    assert.ok(draw().includes("Save failed")); assert.ok(draw().find((n) => n.props?.onChange && n.props?.value === "new"));
  } finally { delete global.__clientTrustContext; delete global.__clientTrustHooks; }
});
