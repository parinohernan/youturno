import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { after, mock, test } from "node:test";

mock.timers.enable({ apis: ["Date"], now: new Date("2030-06-03T12:00:00Z") });
after(() => mock.timers.reset());

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const built = await build({ entryPoints: [new URL("../components/customer-bookings.tsx", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false,
  alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
  plugins: [{ name: "customer-hooks", setup(builder: any) {
    builder.onResolve({ filter: /^preact\/hooks$/ }, (args: any) => args.importer.endsWith("/customer-bookings.tsx") ? { path: "hooks", namespace: "customer-hooks" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "customer-hooks" }, () => ({ contents: `
      const h=()=>globalThis.__customerHooks;
      export function useState(initial){const s=h(),i=s.index++;if(!(i in s.values))s.values[i]=typeof initial==='function'?initial():initial;
        return [s.values[i],v=>{s.values[i]=typeof v==='function'?v(s.values[i]):v}];}
      export function useRef(initial){return useState({current:initial})[0];}
      export function useEffect(fn,deps){const s=h(),i=s.index++,old=s.deps[i];if(!old||deps.some((v,j)=>v!==old[j])){s.deps[i]=deps;s.pending.push(()=>{s.cleanups[i]?.();s.cleanups[i]=fn()});}}
    ` }));
  } }] });
const { CustomerBookings } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const appointment = { id: 1, identifier: "APT-FICTION", status: "confirmed", scheduled_date: "2037-11-02", start_time: "14:00", end_time: "15:30",
  staff_name: "Fictional professional", services: ["First service", "Second service"], duration: 90, total_price: 139,
  can_cancel: true, can_reschedule: true, version: "a".repeat(64) };
function nodes(node: any): any[] {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
function harness(t: any, options: { route?: string; appointments?: any[]; appointment?: any; readStatus?: number; slotStatus?: number; saveStatus?: number; save?: () => Promise<Response>; read?: () => Promise<Response>; isCurrent?: () => boolean } = {}) {
  const original = globalThis.fetch, calls: { path: string; init: RequestInit }[] = [];
  const state = { index: 0, values: [] as any[], deps: [] as any[], pending: [] as any[], cleanups: [] as any[] };
  let route = options.route ?? "1", tree: any[] = [], changed = 0, expired = 0;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input); calls.push({ path, init });
    if (init.method === "POST") return options.save ? options.save() : Response.json({ error: "Fixture save failure", appointment }, { status: options.saveStatus ?? 200 });
    if (path.includes("/slots?")) return Response.json({ slots: ["09:00", "10:30"], error: "Fixture unavailable" }, { status: options.slotStatus ?? 200 });
    return options.read ? options.read() : Response.json({ appointment: options.appointment ?? appointment, appointments: options.appointments ?? [appointment], error: "Fixture read failure" }, { status: options.readStatus ?? 200 });
  };
  const draw = () => { (globalThis as any).__customerHooks = state; state.index = 0;
    tree = nodes(CustomerBookings({ slug: "fiction", route, navigate: (value: string) => { route = value; }, onChanged: () => changed++, onExpired: () => expired++, isCurrent: options.isCurrent }));
    state.pending.splice(0).forEach((fn) => fn()); return tree; };
  const settle = async () => { for (let i = 0; i < 4; i++) { draw(); await setImmediate(); } return draw(); };
  const find = (label: string) => tree.find((node) => typeof node.props?.onClick === "function" && nodes(node).includes(label));
  const click = (label: string) => { const button = find(label); assert.ok(button, label); assert.ok(!button.props.disabled, `${label} enabled`); button.props.onClick(); draw(); };
  t.after(() => { state.cleanups.forEach((fn) => fn?.()); globalThis.fetch = original; delete (globalThis as any).__customerHooks; });
  draw();
  return { draw, settle, find, click, calls, get tree() { return tree; }, get changed() { return changed; }, get expired() { return expired; }, get route() { return route; } };
}
test("customer list renders every pending service, read-only in-progress, empty CTA and detail navigation", async (t) => {
  const h = harness(t, { route: "lista", appointments: [appointment, { ...appointment, id: 2, status: "in_progress", can_cancel: false, can_reschedule: false }] });
  await h.settle();
  assert.equal(h.tree.filter((n) => n.type === "li").length, 2);
  assert.ok(h.tree.includes("First service · Second service"));
  assert.ok(!h.find("Cancelar turno"));
  h.click("Ver turno"); await h.settle(); assert.equal(h.route, "1"); assert.ok(h.find("Reprogramar"));
});
test("ongoing confirmed appointment is visibly in course and read-only using server action permissions", async (t) => {
  const h = harness(t, { appointment: { ...appointment, scheduled_date: "2030-06-03", start_time: "11:30", end_time: "12:30", can_cancel: false, can_reschedule: false } });
  await h.settle();
  assert.ok(h.tree.includes("En curso. Solo la empresa puede modificarlo; contacte a la empresa si necesita asistencia."));
  assert.ok(!h.find("Cancelar turno")); assert.ok(!h.find("Reprogramar"));
  assert.equal(h.calls.filter((call) => call.init.method === "POST").length, 0);
});
test("cancel requires explicit named confirmation, suppresses duplicates and refreshes parent/list after success", async (t) => {
  let release!: (value: Response) => void;
  const h = harness(t, { save: () => new Promise((resolve) => { release = resolve; }) });
  await h.settle(); h.click("Confirmar cancelación"); assert.equal(h.calls.filter((c) => c.init.method === "POST").length, 0);
  h.click("Cancelar turno");
  assert.ok(h.tree.includes("¿Cancelar "));
  h.click("Confirmar cancelación"); h.find("Cancelando…").props.onClick();
  assert.equal(h.calls.filter((c) => c.init.method === "POST").length, 1);
  release(Response.json({ appointment: { ...appointment, status: "cancelled" } }));
  await h.settle(); assert.equal(h.changed, 1); assert.equal(h.route, "lista");
});
test("reschedule fetches OWN slots, reviews old/new without auto-submit, preserves every service and posts only fixed-scope input", async (t) => {
  const h = harness(t); await h.settle(); h.click("Reprogramar"); await h.settle();
  assert.equal(h.calls.filter((c) => c.path.includes("/slots?")).length, 1);
  assert.ok(h.calls.some((c) => c.path.includes("/appointments/1/slots?date=2037-11-02")));
  h.click("10:30"); h.click("Revisar cambio");
  assert.equal(h.calls.filter((c) => c.init.method === "POST").length, 0);
  assert.ok(h.tree.includes("First service · Second service")); assert.ok(h.find("Confirmar nuevo horario"));
  h.click("Confirmar nuevo horario"); await h.settle();
  const post = h.calls.find((c) => c.init.method === "POST")!;
  assert.deepEqual(JSON.parse(post.init.body as string), { action: "reschedule", version: appointment.version, date: "2037-11-02", start_time: "10:30" });
  assert.equal(h.changed, 1);
});
test("reschedule 409 keeps original appointment/day, reloads slots, clears stale time and requires a new review", async (t) => {
  const h = harness(t, { saveStatus: 409 }); await h.settle(); h.click("Reprogramar"); await h.settle();
  h.click("09:00"); h.click("Revisar cambio"); h.click("Confirmar nuevo horario"); await h.settle();
  assert.equal(h.changed, 0); assert.equal(h.route, "1"); assert.equal(h.find("Revisar cambio").props.disabled, true);
  assert.equal(h.tree.find((n) => n.type === "input").props.value, "2037-11-02");
  assert.ok(h.calls.filter((c) => c.path.includes("/slots?")).length >= 2);
});
test("customer read/action 401 asks parent for customer reauthentication without successful mutation", async (t) => {
  const h = harness(t, { saveStatus: 401 }); await h.settle(); h.click("Cancelar turno"); h.click("Confirmar cancelación"); await h.settle();
  assert.equal(h.expired, 1); assert.equal(h.changed, 0); assert.equal(h.route, "1");
});
test("in-progress detail never offers customer cancellation/rescheduling", async (t) => {
  const h = harness(t, { appointment: { ...appointment, status: "in_progress", can_cancel: false, can_reschedule: false } });
  await h.settle(); assert.ok(!h.find("Reprogramar")); assert.ok(!h.find("Cancelar turno"));
  assert.ok(h.tree.some((n) => typeof n === "string" && n.includes("Solo la empresa puede modificarlo")));
});
test("empty customer list and network error provide honest reserve/retry states", async (t) => {
  const h = harness(t, { route: "lista", appointments: [] }); await h.settle();
  assert.ok(h.tree.includes("No tiene próximos turnos en esta empresa.")); assert.ok(h.find("Reservar un turno"));
});

test("invalidated customer session ignores delayed private reads and their 401 errors", async (t) => {
  for (const status of [200, 401]) {
    let current = true, release!: (response: Response) => void;
    const h = harness(t, { route: "lista", isCurrent: () => current, read: () => new Promise((resolve) => { release = resolve; }) });
    current = false;
    release(Response.json({ appointments: [appointment], error: "Expired" }, { status })); await h.settle();
    assert.ok(!h.tree.includes(appointment.identifier)); assert.equal(h.expired, 0);
  }
});

test("invalidated customer ignores delayed saves and never refreshes or navigates the next account", async (t) => {
  let current = true, release!: (response: Response) => void;
  const h = harness(t, { isCurrent: () => current, save: () => new Promise((resolve) => { release = resolve; }) });
  await h.settle(); h.click("Cancelar turno"); h.click("Confirmar cancelación"); current = false;
  release(Response.json({ appointment })); await h.settle();
  assert.equal(h.changed, 0); assert.equal(h.route, "1"); assert.equal(h.expired, 0);
});
