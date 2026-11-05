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
  request?: (path: string, init?: RequestInit) => Promise<Response> } = {}) {
  const BookPublic = await load();
  const global = globalThis as any;
  const original = { fetch: global.fetch, window: global.window, document: global.document, sessionStorage: global.sessionStorage };
  const storage = new Map<string, string>();
  if (options.draft) storage.set(bookingDraftKey("fiction"), JSON.stringify(options.draft));
  const calls: { path: string; init?: RequestInit }[] = [], listeners: Record<string, () => void> = {};
  const state = { index: 0, values: [] as any[], deps: [] as any[], pending: [] as any[], cleanups: [] as any[] };
  global.window = { location: { search: options.authFailed ? "?auth=failed" : "" }, addEventListener: (key: string, fn: () => void) => { listeners[key] = fn; }, removeEventListener() {} };
  global.document = { title: "" };
  global.sessionStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  global.fetch = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (options.request) return options.request(path, init);
    if (path.endsWith("/overview")) return Response.json(overview);
    if (path.endsWith("/session")) return options.authenticated ? Response.json({ customer }) : Response.json({ error: "No session" }, { status: 401 });
    if (path.includes("/slots?")) return Response.json({ slots: ["10:00", "11:00"] });
    throw new Error(`Unexpected request ${path}`);
  };
  let tree: any[] = [];
  const draw = () => { global.__wizardHooks = state; state.index = 0; tree = nodes(BookPublic({ slug: "fiction", preview: options.preview ? overview : undefined })); state.pending.splice(0).forEach((fn) => fn()); return tree; };
  const settle = async () => { for (let i = 0; i < 4; i++) { draw(); await setImmediate(); } return draw(); };
  const find = (label: string) => tree.find((n) => typeof n.props?.onClick === "function" && nodes(n).includes(label));
  const click = (label: string) => { const button = find(label); assert.ok(button, `find ${label}`); assert.ok(!button.props.disabled, `${label} enabled`); button.props.onClick(); draw(); };
  const title = () => tree.find((n) => n.props?.id === "booking-step-title")?.props.children;
  const pickService = (id = 10) => { tree.find((n) => n.props?.role === "button" && nodes(n).includes(overview.services.find((s) => s.id === id)!.name)).props.onClick(); draw(); };
  const pickDay = (index = 0) => { tree.filter((n) => n.type === "button" && n.props?.["aria-label"])[index].props.onClick(); draw(); };
  const enterPhone = (value = "+54 11 5555-0100") => { const props = tree.find((n) => n.props?.id === "booking-contact-phone").props; (props.onInput ?? props.oninput)({ currentTarget: { value } }); draw(); };
  const toReview = async () => { pickService(); click("Continuar"); pickDay(); await settle(); click("10:00"); click("Continuar"); await settle(); enterPhone(); };
  draw();
  return { draw, settle, click, find, title, pickService, pickDay, toReview, enterPhone, calls, storage, listeners, get tree() { return tree; },
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

test("expired authentication preserves review intent across Google and requires a new explicit confirmation", async () => {
  let finish: (value: Response) => void = () => {};
  const h = await harness({ authenticated: true, request: async (path, init) => {
    if (init?.method === "POST") return new Promise((resolve) => { finish = resolve; });
    return Response.json(path.endsWith("/overview") ? overview : path.endsWith("/session") ? { customer } : { slots: ["10:00"] });
  } });
  try {
    await h.settle(); await h.toReview(); h.click("Confirmar turno");
    finish(Response.json({ error: "Expired" }, { status: 401 })); await h.settle();
    assert.equal(h.title(), "Su turno empieza aquí");
    assert.equal(JSON.parse(h.storage.get(bookingDraftKey("fiction"))!).step, 4);
    assert.equal(JSON.parse(h.storage.get(bookingDraftKey("fiction"))!).time, "10:00");
    h.listeners.focus(); await h.settle();
    assert.equal(h.title(), "Todo listo para su visita");
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
      if (status === 200) { assert.ok(h.tree.includes("¡Turno confirmado!")); assert.equal(h.storage.has(bookingDraftKey("fiction")), false); confirm.props.onClick(); }
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
      if (status === 401) assert.equal(JSON.parse(h.storage.get(bookingDraftKey("fiction"))!).time, "10:00");
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
    assert.equal(h.calls.length, 0); assert.equal(h.storage.size, 0);
    h.click("Volver a la vista previa"); assert.equal(h.title(), "¿Qué le gustaría reservar?");
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
