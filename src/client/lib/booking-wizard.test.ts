import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { after, mock, test } from "node:test";
import { today } from "./dates.ts";

mock.timers.enable({ apis: ["Date"], now: new Date("2030-06-03T12:00:00Z") });
after(() => mock.timers.reset());

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const pure = await build({ entryPoints: [new URL("./booking-wizard.ts", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false });
const { bookingDraftKey, bookingEndTime, bookingStep, readBookingDraft, validBookingService } = await import(`data:text/javascript;base64,${Buffer.from(pure.outputFiles[0].text).toString("base64")}`);
const overview = { google_sign_in: true, company: { name: "Fictional Salon", slug: "fiction", appearance: {}, phone: "Example contact" },
  services: [{ id: 10, name: "Cut example", duration: 45, price: 1000 }, { id: 20, name: "Color example", duration: 90, price: 2000 }],
  staff: [{ id: 1, name: "Ana example", service_ids: [10], effective_hours: {} }, { id: 2, name: "Ben example", service_ids: [20], effective_hours: {} }] };
const customer = { sub: "fiction", name: "Fictional customer", email: "example@example.invalid" };
function nodes(node: any): any[] {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
let component: any;
async function load() {
  if (component) return component;
  const result = await build({ entryPoints: [new URL("../components/book-public.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    plugins: [{ name: "wizard-hooks", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: any) => args.importer.endsWith("/book-public.tsx") ? { path: "hooks", namespace: "wizard-hooks" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "wizard-hooks" }, () => ({ contents: `
        const h = () => globalThis.__wizardHooks;
        export function useState(initial) { const s=h(), i=s.index++; if (!(i in s.values)) s.values[i]=typeof initial==='function'?initial():initial;
          return [s.values[i], value=>{s.values[i]=typeof value==='function'?value(s.values[i]):value}]; }
        export function useRef(initial) { return useState({current:initial})[0]; }
        export function useMemo(fn) { return fn(); }
        export function useEffect(fn,deps) { const s=h(), i=s.index++, old=s.deps[i];
          if (!old || deps.some((v,j)=>v!==old[j])) {s.deps[i]=deps; s.pending.push(()=>{s.cleanups[i]?.(); s.cleanups[i]=fn()});} }
      ` }));
    } }] });
  component = (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)).BookPublic;
  return component;
}

/** Runs the actual component/handlers/effects with controlled hooks, not a DOM/browser. */
async function harness(options: { authenticated?: boolean; draft?: any; preview?: boolean; authFailed?: boolean;
  search?: string;
  eligibility?: () => Promise<Response>;
  request?: (path: string, init?: RequestInit) => Promise<Response> } = {}) {
  const BookPublic = await load();
  const global = globalThis as any;
  const original = { fetch: global.fetch, window: global.window, document: global.document, sessionStorage: global.sessionStorage };
  const storage = new Map<string, string>();
  if (options.draft) storage.set(bookingDraftKey("fiction"), JSON.stringify(options.draft));
  const calls: { path: string; init?: RequestInit }[] = [], listeners: Record<string, () => void> = {};
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0, slug = "fiction";
  const state = { index: 0, values: [] as any[], deps: [] as any[], pending: [] as any[], cleanups: [] as any[] };
  const location = { search: options.search ?? (options.authFailed ? "?auth=failed" : ""), href: `http://localhost/book/fiction${options.search ?? ""}` };
  const history = (_state: unknown, _title: string, url: URL) => { location.search = url.search; location.href = url.href; };
  global.window = { location, history: { pushState: history, replaceState: history }, addEventListener: (key: string, fn: () => void) => { listeners[key] = fn; }, removeEventListener() {},
    setInterval(callback: () => void, delay: number) { intervals.set(++timerId, { callback, delay }); return timerId; }, clearInterval(id: number) { intervals.delete(id); } };
  global.document = { title: "", visibilityState: "visible", addEventListener: (key: string, fn: () => void) => { listeners[key] = fn; }, removeEventListener() {} };
  global.sessionStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  global.fetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.endsWith("/eligibility")) return options.eligibility ? options.eligibility() : Response.json({ eligible: true, code: null, message: null });
    if (options.request) return options.request(path, init);
    if (path.endsWith("/overview")) return Response.json(overview);
    if (path.endsWith("/session")) return options.authenticated ? Response.json({ customer }) : Response.json({ error: "No session" }, { status: 401 });
    if (path.endsWith("/logout")) return Response.json({ ok: true });
    if (path.includes("/slots?")) return Response.json({ slots: ["10:00", "11:00"] });
    throw new Error(`Unexpected request ${path}`);
  };
  let tree: any[] = [];
  const draw = () => { global.__wizardHooks = state; state.index = 0; tree = nodes(BookPublic({ slug, preview: options.preview ? overview : undefined })); state.pending.splice(0).forEach((fn) => fn()); return tree; };
  const settle = async () => { for (let i = 0; i < 4; i++) { draw(); await setImmediate(); } return draw(); };
  const find = (label: string) => tree.find((n) => typeof n.props?.onClick === "function" && nodes(n).includes(label));
  const click = (label: string) => { const button = find(label); assert.ok(button, `find ${label}`); assert.ok(!button.props.disabled, `${label} enabled`); button.props.onClick(); draw(); };
  const title = () => tree.find((n) => n.props?.id === "booking-step-title")?.props.children;
  const pickService = (id = 10) => { tree.find((n) => n.props?.role === "button" && nodes(n).includes(overview.services.find((s) => s.id === id)!.name)).props.onClick(); draw(); };
  const pickDay = (index = 0) => { tree.filter((n) => n.type === "button" && n.props?.["aria-label"])[index].props.onClick(); draw(); };
  const enterPhone = (value = "+54 11 5555-0100") => { const props = tree.find((n) => n.props?.id === "booking-contact-phone").props; (props.onInput ?? props.oninput)({ currentTarget: { value } }); draw(); };
  const toReview = async () => { pickService(); click("Continuar"); pickDay(); await settle(); click("10:00"); click("Continuar"); await settle(); enterPhone(); };
  draw();
  return { draw, settle, click, find, title, pickService, pickDay, toReview, enterPhone, calls, storage, listeners, intervals, location, setSlug(value: string) { slug = value; draw(); }, get tree() { return tree; },
    cleanup() { state.cleanups.forEach((fn) => fn?.()); Object.assign(global, original); delete global.__wizardHooks; } };
}

test("wizard gate validates partial/legacy intent, eligibility, dates, tenant keys and end times", () => {
  assert.equal(bookingStep(4, false, true, "2026-11-04", "10:00"), 1);
  assert.equal(bookingStep(1, true, true, "2026-11-04", "10:00"), 2);
  assert.equal(bookingStep(4, true, false, "2026-11-04", "10:00"), 2);
  assert.equal(bookingStep(4, true, true, null, "10:00"), 3);
  assert.equal(bookingStep(4, true, true, "2026-11-04", "10:00"), 4);
  assert.equal(validBookingService(overview.services, overview.staff, { serviceId: 10, staffId: null }), true);
  assert.equal(validBookingService(overview.services, overview.staff, { serviceId: 10, staffId: 2 }), false);
  assert.equal(validBookingService(overview.services, [], { serviceId: 10, staffId: null }), false);
  assert.notEqual(bookingDraftKey("a"), bookingDraftKey("b"));
  assert.equal(bookingEndTime("10:40", 90), "12:10");
  assert.equal(readBookingDraft("bad", "2026-11-04", "2026-11-17"), null);
  assert.deepEqual(readBookingDraft(JSON.stringify({ serviceId: 10, staffId: null, date: "2026-11-04", time: "10:00" }), "2026-11-04", "2026-11-17"),
    { serviceId: 10, staffId: null, date: "2026-11-04", time: "10:00", step: 4 });
  assert.equal(readBookingDraft(JSON.stringify({ date: "2020-01-01", time: "10:00", step: 4 }), "2026-11-04", "2026-11-17")!.time, null);
});

test("Ver mis turnos stays reachable when quota blocks confirmation and does not depend on valid service selection", async () => {
  const h = await harness({ authenticated: true, eligibility: async () => Response.json({ eligible: false, code: "CUSTOMER_ACTIVE_LIMIT", message: "Ya tiene un turno activo" }) });
  try {
    await h.settle(); assert.ok(h.find("Ver mis turnos"));
    const warning = h.tree.find((n) => n.props?.id === "booking-eligibility");
    assert.equal(nodes(warning).filter((n) => typeof n.props?.onClick === "function").length, 1);
    assert.deepEqual(nodes(warning).filter((n) => typeof n === "string"), ["Ya tiene un turno reservado", "Ver mis turnos"]);
    assert.ok(!h.find("Volver a verificar"));
    assert.ok(!h.find("Consultar mis próximos turnos"));
    const progress = h.tree.find((n) => n.props?.["aria-label"] === "Progreso de la reserva");
    assert.ok(h.tree.indexOf(h.find("Ver mis turnos")) > h.tree.indexOf(progress));
    let focuses = 0;
    h.tree.find((n) => n.type === "summary" && nodes(n).includes("Mis turnos")).ref.current = { focus() { focuses++; }, scrollIntoView() {} };
    h.click("Ver mis turnos"); await h.settle();
    h.click("Ver mis turnos"); await h.settle(); assert.equal(focuses, 2, "the same CTA focuses even an already open agenda");
    const manager = h.tree.find((n) => n.props?.route === "lista"); assert.ok(manager);
    manager.props.onChanged(); manager.props.navigate(""); await h.settle();
    assert.equal(h.title(), "¿Qué le gustaría reservar?");
    assert.ok(h.calls.filter((c) => c.path.endsWith("/eligibility")).length >= 2);
    assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 0);
  } finally { h.cleanup(); }
});

test("returning customers have one initially closed lazy agenda below the wizard and separate from business info", async () => {
  const h = await harness({ authenticated: true });
  try {
    await h.settle();
    assert.ok(!h.find("Ver mis turnos")); assert.ok(!h.find("Volver a verificar"));
    assert.ok(!h.find("Consultar mis próximos turnos"));
    const disclosure = h.tree.find((n) => n.type === "details" && nodes(n).includes("Mis turnos"));
    assert.equal(disclosure.props.open, false);
    assert.ok(!h.tree.some((n) => n.props?.route));
    const section = h.tree.find((n) => n.props?.["aria-labelledby"] === "booking-step-title");
    assert.ok(h.tree.indexOf(disclosure) > h.tree.indexOf(nodes(section).at(-1)));
    assert.equal(h.tree.filter((n) => n.type === "details").length, 2);
    disclosure.props.onToggle({ currentTarget: { open: true } }); await h.settle();
    assert.ok(h.tree.some((n) => n.props?.route === "lista"));
    assert.equal(h.location.search, "?turnos=lista");
  } finally { h.cleanup(); }
});

test("identity is customer-session only, trimmed plain text with a private Cliente fallback", async () => {
  for (const name of ["  María de ejemplo  ", "   ", "<b>Cliente</b>"]) {
    const h = await harness({ request: async (path) => Response.json(path.endsWith("/overview") ? overview : { customer: { ...customer, name } }) });
    try {
      await h.settle();
      assert.ok(h.tree.includes(name.trim() || "Cliente")); assert.ok(h.find("Cerrar sesión"));
      assert.ok(!h.tree.includes(customer.email));
      assert.ok(h.tree.some((n) => n.props?.className?.includes("[overflow-wrap:anywhere]") && nodes(n).includes(name.trim() || "Cliente")));
      assert.ok(!h.tree.some((n) => n.props?.dangerouslySetInnerHTML));
    } finally { h.cleanup(); }
  }
  const h = await harness();
  try { await h.settle(); assert.ok(!h.find("Cerrar sesión")); assert.ok(!h.tree.includes(customer.name)); assert.ok(!h.tree.includes(customer.email)); }
  finally { h.cleanup(); }
});

test("logout posts customer JSON once, clears private state/intent and invalidates pending session and eligibility reads", async () => {
  let releaseLogout!: (response: Response) => void, releaseSession!: (response: Response) => void, releaseEligibility!: (response: Response) => void;
  let sessions = 0, eligibilityReads = 0;
  const h = await harness({ eligibility: async () => ++eligibilityReads === 1 ? Response.json({ eligible: true, code: null, message: null })
    : new Promise((resolve) => { releaseEligibility = resolve; }), request: async (path) => {
    if (path.endsWith("/logout")) return new Promise((resolve) => { releaseLogout = resolve; });
    if (path.endsWith("/session")) return ++sessions === 1 ? Response.json({ customer }) : new Promise((resolve) => { releaseSession = resolve; });
    return Response.json(path.endsWith("/overview") ? overview : { slots: ["10:00"] });
  } });
  try {
    await h.settle(); await h.toReview();
    h.storage.set("yt.customer.intent:fiction", "123"); h.storage.set("unrelated", "keep");
    h.listeners.focus(); await h.settle();
    const button = h.find("Cerrar sesión"); button.props.onClick(); button.props.onClick(); h.draw();
    assert.equal(h.find("Cerrando sesión…").props.disabled, true);
    const writes = h.calls.filter((c) => c.init?.method === "POST"); assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "/api/auth/customer/logout");
    assert.equal((writes[0].init?.headers as Record<string, string>)["Content-Type"], "application/json");
    assert.equal(writes[0].init?.body, "{}");
    releaseLogout(Response.json({ ok: true })); await h.settle();
    releaseSession(Response.json({ customer })); releaseEligibility(Response.json({ eligible: false, code: "CUSTOMER_ACTIVE_LIMIT" })); await h.settle();
    assert.equal(h.title(), "Su turno empieza aquí"); assert.ok(!h.tree.includes(customer.name));
    assert.ok(!h.tree.some((n) => n.props?.route)); assert.ok(!h.find("Cerrar sesión")); assert.ok(!h.find("Ver mis turnos"));
    assert.equal(h.storage.has(bookingDraftKey("fiction")), false); assert.equal(h.storage.has("yt.customer.intent:fiction"), false);
    assert.equal(h.storage.get("unrelated"), "keep"); assert.equal(h.location.search, "");
  } finally { h.cleanup(); }
});

test("logout failures retain the authenticated customer and allow a deliberate retry", async () => {
  let attempts = 0;
  const h = await harness({ request: async (path) => path.endsWith("/logout")
    ? Response.json(++attempts === 1 ? { error: "Offline" } : { ok: true }, { status: attempts === 1 ? 503 : 200 })
    : Response.json(path.endsWith("/overview") ? overview : { customer }) });
  try {
    await h.settle(); h.click("Cerrar sesión"); await h.settle();
    assert.ok(h.tree.includes(customer.name)); assert.ok(h.find("Cerrar sesión"));
    assert.ok(h.tree.includes("No se pudo cerrar la sesión. Revise la conexión y vuelva a intentar."));
    h.click("Cerrar sesión"); await h.settle(); assert.equal(h.title(), "Su turno empieza aquí"); assert.equal(attempts, 2);
  } finally { h.cleanup(); }
});

test("session verification errors keep identity with retry; a definitive 401 clears the agenda and intent", async () => {
  let status = 200;
  const h = await harness({ search: "?turnos=lista", request: async (path) => path.endsWith("/overview") ? Response.json(overview)
    : Response.json(status === 200 ? { customer } : { error: "Fixture failed" }, { status }) });
  try {
    await h.settle(); status = 503; h.listeners.focus(); await h.settle();
    assert.ok(h.tree.includes(customer.name)); assert.ok(h.find("Reintentar verificación"));
    status = 401; h.click("Reintentar verificación"); await h.settle();
    assert.equal(h.title(), "Su turno empieza aquí"); assert.ok(!h.tree.includes(customer.name));
    assert.ok(!h.tree.some((n) => n.props?.route)); assert.equal(h.storage.has(bookingDraftKey("fiction")), false);
  } finally { h.cleanup(); }
});

test("agenda deeplinks and back open the same disclosure; closing preserves manager and unsaved booking selection", async () => {
  const h = await harness({ authenticated: true, search: "?turnos=123" });
  try {
    await h.settle();
    const disclosure = () => h.tree.find((n) => n.type === "details" && nodes(n).includes("Mis turnos"));
    assert.equal(disclosure().props.open, true); assert.equal(h.tree.find((n) => n.props?.route).props.route, "123");
    const summary = h.tree.find((n) => n.type === "summary" && nodes(n).includes("Mis turnos"));
    let focused = 0, scrolled = 0; summary.ref.current = { focus() { focused++; }, scrollIntoView() { scrolled++; } };
    await h.toReview();
    disclosure().props.onToggle({ currentTarget: { open: false } }); await h.settle();
    assert.equal(disclosure().props.open, false); assert.equal(h.location.search, "");
    assert.equal(h.tree.find((n) => n.props?.route).props.route, "123", "manager remains mounted with its detail/move state");
    assert.equal(h.title(), "Todo listo para su visita"); assert.equal(h.find("Confirmar turno").props.disabled, false);
    h.location.search = "?turnos=lista"; h.listeners.popstate(); await h.settle();
    assert.equal(disclosure().props.open, true); assert.equal(h.tree.filter((n) => n.props?.route).length, 1);
    disclosure().props.onKeyDown({ key: "Escape", stopPropagation() {} }); await h.settle();
    assert.equal(disclosure().props.open, false); assert.ok(focused > 0); assert.ok(scrolled > 0);
  } finally { h.cleanup(); }
});

test("account switches invalidate old agenda callbacks and clear previous contact and draft", async () => {
  let switched = false;
  const h = await harness({ search: "?turnos=lista", request: async (path) => Response.json(path.endsWith("/overview") ? overview : path.endsWith("/session")
    ? { customer: switched ? { sub: "another", email: "another@example.invalid", name: "Another fictional customer" } : customer } : { slots: ["10:00"] }) });
  try {
    await h.settle(); await h.toReview();
    const oldManager = h.tree.find((n) => n.props?.route);
    switched = true; h.listeners.focus(); await h.settle();
    assert.equal(oldManager.props.isCurrent(), false); oldManager.props.onExpired(); oldManager.props.navigate("123"); await h.settle();
    assert.ok(h.tree.includes("Another fictional customer")); assert.ok(!h.tree.includes(customer.name));
    assert.equal(h.title(), "¿Qué le gustaría reservar?"); assert.equal(h.location.search, "");
    assert.ok(!h.tree.some((n) => n.props?.route));
  } finally { h.cleanup(); }
});

test("agenda mutation immediately refreshes parent quota and invalidates the old wizard time", async () => {
  let cancelled = false;
  const h = await harness({ authenticated: true, eligibility: async () => Response.json({ eligible: cancelled, code: cancelled ? null : "CUSTOMER_ACTIVE_LIMIT", message: null }) });
  try {
    await h.settle(); await h.toReview(); assert.equal(h.find("Confirmar turno").props.disabled, true);
    h.click("Ver mis turnos"); await h.settle();
    const slotsBefore = h.calls.filter((c) => c.path.includes("/slots?")).length;
    cancelled = true; h.tree.find((n) => n.props?.route).props.onChanged(); await h.settle();
    assert.ok(!h.find("Ver mis turnos")); assert.equal(h.title(), "¿Qué le gustaría reservar?");
    h.tree.find((n) => n.props?.route).props.navigate(""); await h.settle(); h.click("Continuar"); await h.settle();
    assert.ok(h.calls.filter((c) => c.path.includes("/slots?")).length > slotsBefore);
    assert.equal(h.find("Continuar").props.disabled, true, "old selected time is not reused");
    h.click("10:00"); h.click("Continuar"); await h.settle(); assert.equal(h.find("Confirmar turno").props.disabled, false);
  } finally { h.cleanup(); }
});

test("preview identity and disclosure never call real customer session/logout/agenda endpoints", async () => {
  const h = await harness({ preview: true });
  try {
    await h.settle(); h.click("Simular ingreso con Google"); await h.settle();
    assert.ok(h.tree.includes("Cliente de ejemplo")); assert.equal(h.find("Cerrar sesión").props.disabled, true);
    h.find("Cerrar sesión").props.onClick();
    h.tree.find((n) => n.type === "details" && nodes(n).includes("Mis turnos")).props.onToggle({ currentTarget: { open: true } }); await h.settle();
    assert.ok(h.tree.includes("Vista previa · No hay turnos reales para consultar.")); assert.equal(h.calls.length, 0);
  } finally { h.cleanup(); }
});

test("external completion revalidates a limited warning on visibility and bookings return without resetting the selection", async () => {
  for (const event of ["visibilitychange", "focus", "bookings-return", "poll"]) {
    let completed = false;
    const h = await harness({ authenticated: true, eligibility: async () => Response.json(completed
      ? { eligible: true, code: null, message: null }
      : { eligible: false, code: "CUSTOMER_ACTIVE_LIMIT", message: "Ya tiene un turno reservado" }) });
    try {
      await h.settle(); await h.toReview();
      assert.equal(h.title(), "Todo listo para su visita");
      const requests = h.calls.filter((call) => call.path.endsWith("/eligibility")).length;
      completed = true;
      if (event === "visibilitychange" || event === "focus") h.listeners[event]?.();
      else if (event === "poll") {
        const timer = [...h.intervals.values()][0]; assert.equal(timer.delay, 30_000);
        (globalThis as any).document.visibilityState = "hidden";
        const count = h.calls.length; timer.callback(); await h.settle(); assert.equal(h.calls.length, count);
        (globalThis as any).document.visibilityState = "visible"; timer.callback();
      }
      else {
        h.click("Ver mis turnos"); await h.settle();
        h.tree.find((n) => n.props?.route === "lista").props.navigate("");
      }
      await h.settle();
      assert.ok(!h.find("Ver mis turnos"), event);
      assert.equal(h.intervals.size, 0, "eligible customers are not polled");
      assert.equal(h.title(), "Todo listo para su visita", "quiet refresh preserves wizard progress");
      assert.equal(h.find("Confirmar turno").props.disabled, false, "selection and contact are retained");
      assert.equal(h.calls.filter((call) => call.path.endsWith("/eligibility")).length - requests, event === "bookings-return" ? 2 : 1);
      assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 0);
    } finally { h.cleanup(); }
  }
});

test("late eligibility errors and previous-company limits cannot overwrite newer eligibility", async () => {
  let attempts = 0, release!: (response: Response) => void;
  const h = await harness({ authenticated: true, eligibility: async () => ++attempts === 2
    ? new Promise<Response>((resolve) => { release = resolve; })
    : Response.json({ eligible: true, code: null, message: null }) });
  try {
    await h.settle(); h.listeners.visibilitychange(); await h.settle();
    h.listeners.visibilitychange(); await h.settle();
    release(Response.json({ error: "Old failure" }, { status: 503 })); await h.settle();
    assert.ok(!h.find("Reintentar verificación"));
    attempts = 1; h.listeners.visibilitychange(); await h.settle();
    h.setSlug("other-company"); await h.settle();
    release(Response.json({ eligible: false, code: "CUSTOMER_ACTIVE_LIMIT", message: "Old company limit" })); await h.settle();
    assert.ok(!h.find("Ver mis turnos"));
    assert.ok(h.calls.some((call) => call.path === "/api/public/other-company/eligibility"));
  } finally { h.cleanup(); }
});

test("pending advisory eligibility never overwrites an authoritative booking quota rejection", async () => {
  let attempts = 0, release!: (response: Response) => void;
  const h = await harness({ authenticated: true,
    eligibility: async () => ++attempts === 1 ? Response.json({ eligible: true, code: null, message: null })
      : new Promise<Response>((resolve) => { release = resolve; }),
    request: async (path) => path.endsWith("/overview") ? Response.json(overview)
      : path.endsWith("/session") ? Response.json({ customer })
      : path.includes("/slots?") ? Response.json({ slots: ["10:00"] })
      : Response.json({ error: "Limit", code: "CUSTOMER_ACTIVE_LIMIT" }, { status: 409 }) });
  try {
    await h.settle(); await h.toReview();
    h.listeners.visibilitychange(); await h.settle();
    h.click("Confirmar turno"); await h.settle(); assert.ok(h.find("Ver mis turnos"));
    release(Response.json({ eligible: true, code: null, message: null })); await h.settle();
    assert.ok(h.find("Ver mis turnos")); assert.equal(h.find("Confirmar turno").props.disabled, true);
  } finally { h.cleanup(); }
});

test("eligibility network failures retain a distinct retry without the removed warning control", async () => {
  let attempts = 0;
  const h = await harness({ authenticated: true, eligibility: async () => ++attempts === 1
    ? Response.json({ error: "Fixture unavailable" }, { status: 503 })
    : Response.json({ eligible: true, code: null, message: null }) });
  try {
    await h.settle(); assert.ok(!h.find("Volver a verificar"));
    h.click("Reintentar verificación"); await h.settle();
    assert.equal(attempts, 2); assert.ok(!h.find("Reintentar verificación"));
  } finally { h.cleanup(); }
});

test("unauthenticated visitor sees Google first, OAuth failure is actionable, and no slots or booking calls start", async () => {
  const h = await harness({ authFailed: true });
  try {
    await h.settle(); assert.equal(h.title(), "Su turno empieza aquí");
    assert.ok(h.tree.some((n) => n.props?.href === "/api/auth/customer/google?slug=fiction"));
    assert.ok(h.tree.some((n) => n.props?.role === "alert"));
    assert.ok(!h.tree.some((n) => n.props?.role === "button"));
    assert.ok(h.calls.every((c) => /\/overview$|\/session$/.test(c.path)));
    const link = h.tree.find((n) => n.props?.href?.includes("/google?")); link.props.onClick();
    assert.equal(JSON.parse(h.storage.get(bookingDraftKey("fiction"))!).step, 2);
  } finally { h.cleanup(); }
});

test("authenticated customer skips Google; prerequisites, professional-first filtering, next/back and edit invalidate time", async () => {
  const h = await harness({ authenticated: true });
  try {
    await h.settle(); assert.equal(h.title(), "¿Qué le gustaría reservar?");
    assert.equal(h.find("Continuar").props.disabled, true);
    const ben = h.tree.find((n) => n.type === "button" && nodes(n).includes("Ben example")); ben.props.onClick(); h.draw();
    assert.ok(!h.tree.includes("Cut example")); assert.ok(h.tree.includes("Color example"));
    h.click("Cualquiera"); h.pickService(); h.click("Continuar");
    assert.equal(h.find("Continuar").props.disabled, true);
    h.pickDay(); await h.settle(); h.click("10:00"); h.click("Continuar");
    assert.equal(h.title(), "Todo listo para su visita"); assert.ok(h.tree.includes("Cut example"));
    assert.ok(nodes(h.tree).includes("10:00")); assert.ok(nodes(h.tree).includes("10:45"));
    assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 0);
    h.click("Atrás"); h.click("Atrás"); h.pickService(20); h.click("Continuar");
    assert.equal(h.find("Continuar").props.disabled, true); assert.ok(!h.tree.includes("10:00"));
    h.click("Atrás"); h.click("Ver todos / Limpiar"); h.draw();
    const ana = h.tree.find((n) => n.type === "button" && nodes(n).includes("Ana example")); ana.props.onClick(); h.draw();
    assert.equal(h.find("Continuar").props.disabled, true);
  } finally { h.cleanup(); }
});

test("reload and OAuth preserve valid review intent but never auto-submit; invalid current eligibility returns to service", async () => {
  const day = today();
  for (const invalid of [false, true]) {
    const h = await harness({ authenticated: true, draft: { serviceId: 10, staffId: invalid ? 2 : 1, date: day, time: "10:00", step: 4 } });
    try {
      await h.settle(); assert.equal(h.title(), invalid ? "¿Qué le gustaría reservar?" : "Todo listo para su visita");
      assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 0);
      if (!invalid) { assert.equal(h.find("Confirmar turno").props.disabled, true); h.enterPhone(); assert.equal(h.find("Confirmar turno").props.disabled, false); }
      else assert.equal(JSON.parse(h.storage.get(bookingDraftKey("fiction"))!).time, null);
    } finally { h.cleanup(); }
  }
});

test("anonymous restored intent waits for Google and resumes review only after the authenticated reload", async () => {
  const day = today();
  const anonymous = await harness({ draft: { serviceId: 20, staffId: 2, date: day, time: "11:00", step: 4 } });
  let intent;
  try {
    await anonymous.settle(); assert.equal(anonymous.title(), "Su turno empieza aquí");
    assert.ok(anonymous.calls.every((c) => !c.path.includes("/slots?")));
    anonymous.tree.find((n) => n.props?.href?.includes("/google?")).props.onClick();
    intent = JSON.parse(anonymous.storage.get(bookingDraftKey("fiction"))!);
    assert.deepEqual(Object.keys(intent).sort(), ["date", "serviceId", "staffId", "step", "time"]);
  } finally { anonymous.cleanup(); }
  const signedIn = await harness({ authenticated: true, draft: intent });
  try {
    await signedIn.settle(); assert.equal(signedIn.title(), "Todo listo para su visita");
    assert.ok(signedIn.tree.includes("Color example")); assert.ok(signedIn.tree.includes("Ben example"));
    assert.equal(signedIn.calls.filter((c) => c.init?.method === "POST").length, 0);
    signedIn.click("Atrás"); signedIn.click("Atrás");
    const ben = signedIn.tree.find((n) => n.type === "button" && nodes(n).includes("Ben example")); ben.props.onClick(); signedIn.draw(); signedIn.click("Continuar");
    assert.equal(signedIn.find("Continuar").props.disabled, true, "even a compatible staff choice clears the previous day/time");
  } finally { signedIn.cleanup(); }
});

test("expired authentication clears private contact and booking intent before Google reauthentication", async () => {
  let finish: (value: Response) => void = () => {};
  const h = await harness({ authenticated: true, request: async (path, init) => {
    if (init?.method === "POST") return new Promise((resolve) => { finish = resolve; });
    return Response.json(path.endsWith("/overview") ? overview : path.endsWith("/session") ? { customer } : { slots: ["10:00"] });
  } });
  try {
    await h.settle(); await h.toReview(); h.click("Confirmar turno");
    finish(Response.json({ error: "Expired" }, { status: 401 })); await h.settle();
    assert.equal(h.title(), "Su turno empieza aquí");
    assert.equal(h.storage.has(bookingDraftKey("fiction")), false);
    assert.ok(!h.tree.includes(customer.name)); assert.ok(!h.find("Cerrar sesión"));
    h.listeners.focus(); await h.settle();
    assert.equal(h.title(), "¿Qué le gustaría reservar?");
    h.pickService(); h.click("Continuar"); h.pickDay(); await h.settle(); h.click("10:00"); h.click("Continuar");
    assert.equal(h.tree.find((n) => n.props?.id === "booking-contact-phone").props.value, "");
    assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 1);
  } finally { h.cleanup(); }
});

test("confirmation requires valid manual contact without persisting the phone or auto-booking", async () => {
  const h = await harness({ authenticated: true });
  try {
    await h.settle(); await h.toReview();
    h.enterPhone(""); assert.equal(h.find("Confirmar turno").props.disabled, true);
    h.enterPhone("abc"); assert.equal(h.find("Confirmar turno").props.disabled, true);
    h.enterPhone("+54 (11) 5555-0100"); assert.equal(h.find("Confirmar turno").props.disabled, false);
    assert.equal(h.calls.filter((call) => call.init?.method === "POST").length, 0);
    assert.ok(!h.storage.get(bookingDraftKey("fiction"))!.includes("5555"));
    assert.ok(h.tree.includes("La empresa usará este número para contactarle manualmente sobre su turno. No se envían mensajes automáticos.") ||
      h.tree.some((node) => node.props?.id === "booking-phone-help"));
  } finally { h.cleanup(); }
});

test("customer policy is visible before confirmation and cannot be confused with missing hours", async () => {
  for (const code of ["CUSTOMER_ACTIVE_LIMIT", "CUSTOMER_BLOCKED"]) {
    const message = code === "CUSTOMER_ACTIVE_LIMIT" ? "Ya tiene un turno activo en esta empresa. Contacte a la empresa para cancelarlo o reprogramarlo antes de realizar otra reserva." : "La reserva en línea no está disponible para su cuenta en esta empresa. Contacte a la empresa para recibir asistencia.";
    const h = await harness({ authenticated: true, eligibility: async () => Response.json({ eligible: false, code, message }) });
    try {
      await h.settle(); assert.ok(h.tree.includes(code === "CUSTOMER_ACTIVE_LIMIT" ? "Ya tiene un turno reservado" : message));
      await h.toReview(); assert.equal(h.find("Confirmar turno").props.disabled, true);
      assert.ok(h.tree.includes("10:00")); assert.ok(!h.find("Volver a verificar"));
      assert.ok(h.find("Ver mis turnos"));
      assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 0);
      assert.ok(!h.tree.some((n) => n.props?.href?.includes("cancel")), "no nonexistent self-cancel action");
    } finally { h.cleanup(); }
  }
});

test("eligibility failure fails closed and retry recovers without submitting", async () => {
  let failed = true;
  const h = await harness({ authenticated: true, eligibility: async () => failed ? Response.json({ error: "Unavailable" }, { status: 503 }) : Response.json({ eligible: true, code: null, message: null }) });
  try {
    await h.settle(); await h.toReview(); assert.equal(h.find("Confirmar turno").props.disabled, true);
    assert.ok(h.tree.includes("No se pudo verificar si puede reservar. Vuelva a intentar antes de confirmar."));
    failed = false; h.click("Reintentar verificación"); await h.settle();
    assert.equal(h.find("Confirmar turno").props.disabled, false);
    assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 0);
  } finally { h.cleanup(); }
});

test("stale allowed eligibility never masks authoritative quota/blocked errors or resets time as a slot conflict", async () => {
  for (const [status, code] of [[409, "CUSTOMER_ACTIVE_LIMIT"], [403, "CUSTOMER_BLOCKED"]] as const) {
    const h = await harness({ authenticated: true, request: async (path, init) => {
      if (init?.method === "POST") return Response.json({ error: "Policy changed", code }, { status });
      return Response.json(path.endsWith("/overview") ? overview : path.endsWith("/session") ? { customer } : { slots: ["10:00"] });
    } });
    try {
      await h.settle(); await h.toReview(); h.click("Confirmar turno"); await h.settle();
      assert.equal(h.title(), "Todo listo para su visita");
      assert.equal(h.find("Confirmar turno").props.disabled, true);
      assert.ok(h.tree.some((n) => typeof n === "string" && n.includes(code === "CUSTOMER_ACTIVE_LIMIT" ? "Ya tiene un turno reservado" : "La reserva en línea no está disponible")));
      assert.ok(!h.tree.includes("¡Turno confirmado!"));
      assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 1);
      assert.equal(h.calls.filter((c) => c.path.includes("/slots?")).length, 1);
    } finally { h.cleanup(); }
  }
});

test("confirmation blocks same-render duplicates; 409 refreshes slots and 400 returns to service; success is separate", async () => {
  for (const status of [409, 400, 200]) {
    let finish: (value: Response) => void = () => {};
    const h = await harness({ authenticated: true, request: async (path, init) => {
      if (init?.method === "POST") return new Promise((resolve) => { finish = resolve; });
      return Response.json(path.endsWith("/overview") ? overview : path.endsWith("/session") ? { customer } : { slots: ["10:00", "11:00"] });
    } });
    try {
      await h.settle(); await h.toReview(); const confirm = h.find("Confirmar turno");
      confirm.props.onClick(); confirm.props.onClick(); h.draw();
      assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 1);
      assert.equal(JSON.parse(h.calls.find((c) => c.init?.method === "POST")!.init!.body as string).contact_phone, "+541155550100");
      assert.equal(h.find("Confirmando...").props.disabled, true);
      finish(Response.json(status === 200 ? { appointment: { id: 1, identifier: "FICTION", status: "confirmed", scheduled_date: today(), start_time: "10:00", end_time: "10:45" } } : { error: "Unavailable" }, { status }));
      await h.settle();
      if (status === 200) {
        assert.ok(h.tree.includes("¡Turno confirmado!")); assert.equal(h.storage.has(bookingDraftKey("fiction")), false); confirm.props.onClick();
        h.click("Ver mis turnos"); await h.settle();
        assert.equal(h.tree.find((n) => n.type === "details" && nodes(n).includes("Mis turnos")).props.open, true);
        assert.equal(h.tree.filter((n) => n.props?.route === "lista").length, 1);
      }
      else { assert.equal(h.title(), status === 409 ? "Encuentre su momento" : "¿Qué le gustaría reservar?"); assert.equal(h.find("Continuar").props.disabled, true); }
      assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 1);
      if (status === 409) assert.ok(h.calls.filter((c) => c.path.includes("/slots?")).length >= 2);
    } finally { h.cleanup(); }
  }
});

test("late slot response cannot replace a newer day or service selection", async () => {
  const pending: ((value: Response) => void)[] = [];
  const h = await harness({ authenticated: true, request: async (path) => {
    if (path.includes("/slots?")) return new Promise((resolve) => pending.push(resolve));
    return Response.json(path.endsWith("/overview") ? overview : { customer });
  } });
  try {
    await h.settle(); h.pickService(); h.click("Continuar"); h.pickDay(); h.draw(); h.pickDay(1); h.draw();
    assert.equal(pending.length, 2);
    pending[1](Response.json({ slots: ["11:00"] })); await h.settle();
    pending[0](Response.json({ slots: ["10:00"] })); await h.settle();
    assert.ok(!h.tree.includes("10:00")); assert.ok(h.tree.includes("11:00"));
    h.click("Atrás"); h.pickService(20); h.click("Continuar"); await h.settle();
    assert.ok(!h.tree.includes("11:00")); assert.equal(h.find("Continuar").props.disabled, true);
  } finally { h.cleanup(); }
});

test("slot 401 returns to customer login, while removed restored time returns to the date step", async () => {
  const day = today();
  for (const status of [401, 200]) {
    const h = await harness({ draft: { serviceId: 10, staffId: 1, date: day, time: "10:00", step: 4 }, request: async (path) => {
      if (path.includes("/slots?")) return Response.json(status === 401 ? { error: "Expired" } : { slots: ["11:00"] }, { status });
      return Response.json(path.endsWith("/overview") ? overview : { customer });
    } });
    try {
      await h.settle(); assert.equal(h.title(), status === 401 ? "Su turno empieza aquí" : "Encuentre su momento");
      if (status === 401) assert.equal(h.storage.has(bookingDraftKey("fiction")), false);
      else assert.equal(h.find("Continuar").props.disabled, true);
      assert.equal(h.calls.filter((c) => c.init?.method === "POST").length, 0);
    } finally { h.cleanup(); }
  }
});

test("unavailable company and session verification failures have explicit states without protected calls", async () => {
  for (const status of [404, 503]) {
    const h = await harness({ request: async (path) => path.endsWith("/overview")
      ? status === 404 ? Response.json({ error: "Inactive" }, { status }) : Response.json(overview)
      : Response.json({ error: "Connection unavailable" }, { status: 503 }) });
    try {
      await h.settle();
      if (status === 404) assert.ok(h.tree.some((n) => n.props?.title === "Agenda no disponible"));
      else { assert.ok(h.find("Reintentar verificación")); assert.ok(!h.tree.some((n) => n.props?.href?.includes("/google?"))); }
      assert.ok(h.calls.every((c) => /\/overview$|\/session$/.test(c.path)));
    } finally { h.cleanup(); }
  }
});

test("fictional preview navigates all screens and success without OAuth, requests or persisted intent", async () => {
  const h = await harness({ preview: true });
  try {
    await h.settle(); h.click("Simular ingreso con Google"); await h.toReview(); h.click("Confirmar turno"); await h.settle();
    assert.ok(h.tree.includes("Vista previa: turno de ejemplo"));
    const calendar = h.tree.find((n) => n.props?.appointment?.calendarContext);
    assert.equal(calendar.props.preview, true); assert.equal(calendar.props.appointment.id, -1);
    assert.equal(h.calls.length, 0); assert.equal(h.storage.size, 0);
    h.click("Volver a la vista previa"); assert.equal(h.title(), "¿Qué le gustaría reservar?");
  } finally { h.cleanup(); }
});

test("confirmation calendar uses saved appointment rather than draft time and snapshots only public labels", async () => {
  const saved = { id: 42, identifier: "APT-SAVED", status: "confirmed", scheduled_date: "2030-06-07", start_time: "14:10", end_time: "15:40" };
  let currentOverview = overview;
  const h = await harness({ authenticated: true, request: async (path, init) => Response.json(init?.method === "POST" ? { appointment: saved } :
    path.endsWith("/overview") ? currentOverview : path.endsWith("/session") ? { customer } : { slots: ["10:00", "11:00"] }) });
  try {
    await h.settle(); await h.toReview();
    assert.ok(!h.tree.some((n) => n.props?.appointment?.calendarContext));
    h.click("Confirmar turno"); await h.settle();
    const action = () => h.tree.find((n) => n.props?.appointment?.calendarContext);
    assert.deepEqual(action().props.appointment, { ...saved, calendarContext: { companyName: overview.company.name, serviceName: "Cut example", address: undefined } });
    assert.equal(action().props.preview, false); assert.ok(h.find("Ver mis turnos"));
    assert.ok(!JSON.stringify(action().props.context).includes(customer.email));
    currentOverview = { ...overview, company: { ...overview.company, name: "Changed public name" }, services: overview.services.map((s) => ({ ...s, name: "Changed service" })) };
    h.listeners.focus(); await h.settle();
    assert.equal(action().props.context.companyName, overview.company.name); assert.equal(action().props.context.serviceName, "Cut example");
    assert.equal(action().props.appointment.start_time, "14:10");
  } finally { h.cleanup(); }
});

test("Cerrar finishes only the receipt, keeps identity and agenda, and never replays stale confirmation", async () => {
  const saved = { id: 42, identifier: "APT-FINISHED", status: "confirmed", scheduled_date: today(), start_time: "10:00", end_time: "10:45" };
  const h = await harness({ authenticated: true, request: async (path, init) => Response.json(init?.method === "POST" ? { appointment: saved } :
    path.endsWith("/overview") ? overview : path.endsWith("/session") ? { customer } : { slots: ["10:00"] }) });
  try {
    await h.settle(); await h.toReview(); const staleConfirm = h.find("Confirmar turno");
    h.click("Confirmar turno"); await h.settle();
    assert.ok(h.tree.some((n) => n.props?.appointment?.calendarContext));
    h.click("Ver mis turnos"); await h.settle();
    assert.ok(h.tree.some((n) => n.props?.route === "lista"));
    h.storage.set("yt.customer.intent:fiction", "42"); h.storage.set("unrelated", "keep");
    const before = h.calls.length, close = h.find("Cerrar");
    close.props.onClick(); close.props.onClick(); await h.settle();
    assert.equal(h.calls.length, before, "closing makes no requests, including calendar or session mutations");
    assert.ok(h.tree.includes("Todo listo")); assert.ok(h.tree.includes("Su reserva quedó confirmada."));
    assert.ok(h.tree.includes("Puede cerrar esta pestaña.")); assert.ok(h.tree.includes(overview.company.name));
    assert.ok(h.tree.includes(customer.name)); assert.ok(h.find("Cerrar sesión")); assert.ok(h.find("Ver mis turnos"));
    assert.ok(!h.find("Cerrar")); assert.ok(!h.find("Confirmar turno")); assert.equal(h.title(), undefined);
    assert.ok(!h.tree.some((n) => n.props?.appointment?.calendarContext || n.props?.id === "booking-eligibility"));
    assert.equal(h.storage.has(bookingDraftKey("fiction")), false); assert.equal(h.storage.has("yt.customer.intent:fiction"), false);
    assert.equal(h.storage.get("unrelated"), "keep"); assert.equal(new URLSearchParams(h.location.search).get("reserva"), "finalizada");
    staleConfirm.props.onClick(); await h.settle();
    const manager = h.tree.find((n) => n.props?.route === "lista"); manager.props.onChanged();
    h.tree.find((n) => n.type === "details" && nodes(n).includes("Mis turnos")).props.onToggle({ currentTarget: { open: false } }); await h.settle();
    h.click("Ver mis turnos"); await h.settle(); h.listeners.popstate(); h.listeners.focus(); await h.settle();
    assert.ok(h.tree.includes("Todo listo")); assert.equal(h.title(), undefined);
    assert.equal(h.calls.filter((c) => c.init?.method !== "GET").length, 1, "only the original explicit booking writes");
    assert.equal(h.calls.filter((c) => c.path.includes("/slots?")).length, 1, "finished selections cannot trigger fresh slots");
    h.tree.find((n) => n.props?.route === "lista").props.navigate(""); await h.settle();
    assert.equal(h.title(), "¿Qué le gustaría reservar?", "only the agenda's explicit reserve action restarts the wizard");
    assert.equal(new URLSearchParams(h.location.search).has("reserva"), false);
    assert.equal(h.calls.filter((c) => c.init?.method !== "GET").length, 1);
  } finally { h.cleanup(); }
});

test("finished URL reload suppresses stale drafts and quota warnings without storing appointment details", async () => {
  const h = await harness({ authenticated: true, search: "?reserva=finalizada&turnos=lista", draft: { serviceId: 10, staffId: 1, date: today(), time: "10:00", step: 4 },
    eligibility: async () => Response.json({ eligible: false, code: "CUSTOMER_ACTIVE_LIMIT", message: "Ya tiene un turno reservado" }) });
  try {
    await h.settle(); assert.ok(h.tree.includes("Todo listo")); assert.ok(h.tree.includes(customer.name));
    assert.ok(h.tree.some((n) => n.props?.route === "lista")); assert.equal(h.title(), undefined);
    assert.ok(!h.tree.includes("Ya tiene un turno reservado")); assert.ok(!h.find("Confirmar turno"));
    assert.equal(h.storage.size, 0); assert.ok(h.calls.every((c) => /\/overview$|\/session$|\/eligibility$/.test(c.path)));
  } finally { h.cleanup(); }
});

test("preview Cerrar ends the fictional flow without network, storage, or a misleading real confirmation", async () => {
  const h = await harness({ preview: true });
  try {
    await h.settle(); h.click("Simular ingreso con Google"); await h.toReview(); h.click("Confirmar turno"); await h.settle();
    h.click("Cerrar"); await h.settle(); assert.ok(h.tree.includes("Todo listo"));
    assert.ok(h.tree.includes("Finalizó la reserva de ejemplo. No se creó ningún turno."));
    assert.ok(!h.find("Cerrar")); assert.equal(h.title(), undefined); assert.equal(h.calls.length, 0); assert.equal(h.storage.size, 0);
  } finally { h.cleanup(); }
});

test("shared legal footer is readable and keyboard accessible; reduced motion disables wizard animation", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /booking-wizard-screen\s*\{\s*animation: booking-step-enter 200ms/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important; transition: none !important/);
  assert.match(css, /booking-legal nav[^}]*color: var\(--foreground\)/);
  const frame = await readFile(new URL("../components/booking-page-frame.tsx", import.meta.url), "utf8");
  assert.match(frame, /<footer[^>]*booking-legal[^>]*><LegalLinks \/><\/footer>/);
  const legal = await readFile(new URL("../components/legal-pages.tsx", import.meta.url), "utf8");
  assert.match(legal, /href="\/privacidad"/); assert.match(legal, /href="\/terminos"/);
});
