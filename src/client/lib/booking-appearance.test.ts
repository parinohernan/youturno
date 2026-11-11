import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { appearanceDecoration, appearanceError, buttonForeground, contrast, defaultAppearance, readAppearance } from "../../shared/booking-appearance.ts";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const alias = { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" };
const company = { name: "Company", description: "Public company", address: "", phone: "", public_email: "", website: "",
  social_links: {}, logo_url: "/api/company/logo?v=1", business_hours: {} };
function nodes(node: any): any[] {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const handler = (node: any, name: string) => node.props[name] ?? node.props[name.toLowerCase()];
async function load(component: string) {
  const result = await build({ entryPoints: [new URL(`../components/${component}.tsx`, import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false, alias,
    plugins: [{ name: "controlled-hooks", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: { importer: string }) =>
        /\/(booking-appearance-editor|book-public)\.tsx$/.test(args.importer) ? { path: "hooks", namespace: "controlled-hooks" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "controlled-hooks" }, () => ({ contents: `
        const h = () => globalThis.__appearanceHooks;
        export function useState(initial) { const s=h(), i=s.index++; if (!(i in s.values)) s.values[i]=typeof initial==='function'?initial():initial;
          return [s.values[i], value => {s.values[i]=typeof value==='function'?value(s.values[i]):value}]; }
        export function useRef(initial) { return useState({current: initial})[0]; }
        export function useMemo(fn) { return fn(); }
        export function useEffect(fn, deps) { const s=h(), i=s.index++, old=s.deps[i];
          if (!old || deps.some((v,j)=>v!==old[j])) { s.deps[i]=deps; s.pending.push(()=>{s.cleanups[i]?.(); s.cleanups[i]=fn()}); } }
      ` }));
    } }] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
function hooks() { return { index: 0, values: [] as any[], deps: [] as any[], pending: [] as any[], cleanups: [] as any[] }; }
function render(state: ReturnType<typeof hooks>, component: () => any) {
  (globalThis as any).__appearanceHooks = state; state.index = 0;
  const tree = component(); state.pending.splice(0).forEach((effect) => effect()); return tree;
}

test("appearance allowlisted colors, legacy defaults and deterministic button foreground meet contrast rules", () => {
  assert.equal(appearanceError(defaultAppearance), null);
  assert.deepEqual(readAppearance(null), defaultAppearance);
  assert.deepEqual(readAppearance("invalid"), defaultAppearance);
  assert.deepEqual(readAppearance('{"background":"url(x)"}'), defaultAppearance);
  for (const button of ["#ffffff", "#000000", "#777777", "#00ff00", "#6d28d9", "#ff0000"])
    assert.ok(contrast(button, buttonForeground(button)) >= 4.5);
  assert.ok(appearanceError({ ...defaultAppearance, text: "#eeeeee" }));
  assert.ok(appearanceError({ ...defaultAppearance, button: "#ffffff" }));
  assert.ok(appearanceError({ ...defaultAppearance, welcome: "x".repeat(501) }));
});

test("company decoration follows light, dark and colorful palettes without changing validated surfaces", async () => {
  const { BookingPageFrame } = await load("booking-page-frame");
  const palettes = [defaultAppearance,
    { ...defaultAppearance, background: "#14252b", text: "#f5faf9", button: "#5eead4" },
    { ...defaultAppearance, background: "#fff1f2", text: "#4c0519", button: "#be123c" },
    { ...defaultAppearance, background: "#ffffff", text: "#767676", button: "#949494" }];
  const glows = new Set();
  for (const appearance of palettes) {
    assert.equal(appearanceError(appearance), null);
    const decoration = appearanceDecoration(appearance);
    glows.add(decoration.glow);
    const frame = BookingPageFrame({ appearance, children: "Content" });
    const styles = frame.props.style;
    for (const key of ["--background", "--card", "--muted", "--accent", "--secondary"])
      assert.equal(styles[key], appearance.background, "decoration must not weaken near-threshold text contrast");
    assert.equal(styles["--primary"], appearance.button);
    assert.ok(contrast(styles["--foreground"], styles["--card"]) >= 4.5);
    assert.ok(contrast(styles["--primary"], styles["--background"]) >= 3);
    assert.ok(contrast(styles["--primary"], styles["--primary-foreground"]) >= 4.5);
    assert.equal(styles["--booking-glow"], decoration.glow);
    assert.doesNotMatch(JSON.stringify(styles), /color-mix|#e5a52c|#141b20/);
  }
  assert.equal(glows.size, palettes.length);
  assert.deepEqual(appearanceDecoration({ ...defaultAppearance, button: "url(invalid)" }), appearanceDecoration(defaultAppearance));
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.booking-appearance::before\s*\{[^}]*pointer-events: none/);
  assert.match(css, /\.booking-appearance \.booking-panel,[\s\S]*?background: var\(--background\)/);
});

test("preview renders the actual public booking layout, reuses logo/legal identity and performs no requests or storage/OAuth work", async () => {
  const { appearancePreview } = await load("booking-appearance-editor");
  const { BookPublic } = await load("book-public");
  const { BookingPageFrame } = await load("booking-page-frame");
  const { CompanyPublicDetails } = await load("company-public-details");
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Preview must not fetch"); };
  try {
    const design = { background: "#111111", text: "#eeeeee", button: "#dddddd", welcome: "<script>escaped text</script>" };
    const overview = appearancePreview(company, design, "blob:preview");
    assert.equal(overview.company.logo_url, company.logo_url);
    assert.equal(nodes(CompanyPublicDetails({ company: overview.company, preview: true })).find((n) => n.type === "img").props.src, company.logo_url);
    assert.equal(overview.staff[0].id, -1); assert.equal(overview.services[0].name, "Servicio de ejemplo");
    const tree = nodes(render(hooks(), () => BookPublic({ slug: "preview", preview: overview })));
    assert.ok(tree.includes("Su turno empieza aquí"));
    assert.ok(!tree.includes("Encuentre su momento"), "only the login step is shown initially");
    assert.ok(tree.some((n) => n.props?.company?.logo_url === company.logo_url));
    assert.ok(nodes(BookingPageFrame(tree[0].props)).some((n) => n.type?.name === "LegalLinks"));
    assert.ok(tree.includes("Simular ingreso con Google"));
    assert.ok(tree.every((n) => !n.props?.href?.includes("/api/auth/customer/google")));
    assert.ok(tree.includes(design.welcome));
    assert.ok(tree.every((n) => !n.props?.dangerouslySetInnerHTML));
    const coverClasses = tree.find((n) => n.type === "img").props.className.split(/\s+/);
    for (const name of ["booking-cover", "w-full", "object-cover", "object-center"])
      assert.ok(coverClasses.includes(name), `cover preserves ${name}`);
    assert.equal(tree.find((n) => n.type === "fieldset").props.hidden, true);
    const frame = BookingPageFrame(tree[0].props);
    assert.equal(frame.props.inert, undefined, "fictional wizard navigation remains interactive");
    for (const key of ["--background", "--card", "--muted", "--accent", "--secondary"]) assert.equal(frame.props.style[key], design.background);
    for (const key of ["--foreground", "--card-foreground", "--muted-foreground"]) assert.equal(frame.props.style[key], design.text);
    assert.equal(frame.props.style["--primary"], design.button);
    assert.equal(frame.props.style["--primary-foreground"], "#000000");
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previousFetch; delete (globalThis as any).__appearanceHooks; }
});

test("editorial booking fonts are local licensed Latin subsets and layout responds to its own container", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  let total = 0;
  for (const family of ["fraunces", "dm-sans"]) {
    const font = await readFile(new URL(`../../../public/fonts/booking/${family}-latin-400.woff2`, import.meta.url));
    assert.equal(font.subarray(0, 4).toString(), "wOF2");
    total += font.length;
    assert.match(await readFile(new URL(`../../../public/fonts/booking/${family}-OFL.txt`, import.meta.url), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.ok(css.includes(`url("/fonts/booking/${family}-latin-400.woff2")`));
  }
  assert.ok(total < 35000, "two display/body subsets stay economical");
  assert.match(css, /\.booking-appearance\s*\{[^}]*font-family: "Booking DM Sans"/);
  assert.match(css, /\.booking-appearance :is\(h1, h2, \.booking-welcome-title\)[^}]*font-family: "Booking Fraunces"/);
  assert.match(css, /@container booking \(min-width: 480px\)/);
  assert.doesNotMatch(css, /min-width: 960px/, "wide screens reuse the narrow single-column layout");
  assert.match(css, /\.booking-service-content\s*\{[^}]*grid-template-columns: 1\.5rem minmax\(0, 1fr\)/);
  assert.match(css, /\.booking-cover\s*\{[^}]*aspect-ratio: 16 \/ 9/);
  const index = await readFile(new URL("../../../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(index, /fonts\.googleapis|fonts\.gstatic/, "booking HTML must not start a third-party font connection before rendering");
  const main = await readFile(new URL("../main.tsx", import.meta.url), "utf8");
  assert.match(main, /if \(!\/\^\\\/book\\\//, "existing platform font loading excludes public booking routes");
});

test("booking layout bounds intrinsic content and confines stable day targets to their own scroll strip", async () => {
  const { appearancePreview } = await load("booking-appearance-editor");
  const { BookPublic } = await load("book-public");
  const overview = appearancePreview({ ...company, name: "Company".repeat(30) }, defaultAppearance, "blob:example-cover");
  overview.services[0].name = "VeryLongService".repeat(30);
  overview.services[0].price = 1234567890123;
  overview.staff[0].name = "Professional".repeat(30);
  const state = hooks();
  const draw = () => nodes(render(state, () => BookPublic({ slug: "preview", preview: overview })));
  try {
    let tree = draw();
    assert.ok(tree.some((n) => n.type === "img" && n.props.className.includes("booking-cover")), "cover introduces the business on the welcome step");
    tree.find((n) => typeof n.props?.onClick === "function" && nodes(n).includes("Simular ingreso con Google")).props.onClick(); tree = draw();
    assert.ok(!tree.some((n) => n.type === "img" && n.props.className.includes("booking-cover")), "later steps retain identity without repeating the cover");
    assert.ok(tree.some((n) => n.type === "header" && n.props["data-compact"]), "identity becomes compact after welcome");
    assert.match(tree.find((n) => n.type === "fieldset").props.className, /min-w-0/);
    const card = tree.find((n) => n.props?.role === "button");
    assert.match(card.props.className, /min-w-0/);
    assert.equal(card.props["aria-pressed"], false);
    const content = nodes(card).find((n) => n.type?.displayName === "CardContent");
    assert.match(content.props.className, /booking-service-content min-w-0/);
    assert.ok(nodes(card).includes(overview.services[0].name), "full service name is retained, not clipped");
    assert.ok(nodes(card).every((n) => !n.props?.className?.includes("truncate")));
    const clear = tree.find((n) => n.props?.children === "Ver todos / Limpiar");
    assert.match(clear.props.className, /max-w-full whitespace-normal/);
    const professional = tree.find((n) => n.type === "button" && nodes(n).includes(overview.staff[0].name));
    assert.match(professional.props.className, /min-h-11 min-w-0 max-w-full/);
    card.props.onClick(); tree = draw();
    tree.find((n) => n.props?.children === "Continuar").props.onClick(); tree = draw();
    const strip = tree.find((n) => n.props?.["aria-label"] === "Días disponibles");
    assert.match(strip.props.className, /min-w-0 max-w-full.*overflow-x-auto overscroll-x-contain/);
    assert.equal(strip.props.tabIndex, 0);
    const days = nodes(strip).filter((n) => n.type === "button");
    assert.equal(days.length, 14);
    for (const day of days) {
      assert.match(day.props.className, /h-16 w-16 shrink-0/);
      assert.ok(day.props["aria-label"]);
    }
    days[13].props.onClick(); tree = draw();
    const selected = tree.filter((n) => n.type === "button" && n.props?.["aria-label"] && n.props?.["aria-pressed"]);
    assert.ok(selected.some((n) => n.props["aria-label"] === days[13].props["aria-label"]), "day selection state is retained");
    let prevented = false;
    card.props.onKeyDown({ key: "Enter", preventDefault() { prevented = true; } });
    assert.equal(prevented, true, "service keyboard activation is retained");
    const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
    assert.match(css, /\.booking-page-content\s*\{[^}]*overflow-wrap: anywhere/);
    assert.match(css, /@container booking \(min-width: 480px\)/);
    assert.doesNotMatch(css, /\.booking-appearance-editor button\s*\{/, "editor action sizing must not override preview day circles");
    assert.doesNotMatch(css, /overflow-x:\s*hidden/);
  } finally { delete (globalThis as any).__appearanceHooks; }
});

test("editor updates unsaved real-page preview, supports both widths, cancels/resets drafts and only publishes multipart on Save", async () => {
  const { BookingAppearanceEditor } = await load("booking-appearance-editor");
  const originalFetch = globalThis.fetch, createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL;
  const writes: RequestInit[] = [], revoked: string[] = [];
  let published = { appearance: { ...defaultAppearance }, cover_url: "/api/company/cover?v=saved" as string | null };
  URL.createObjectURL = () => "blob:draft"; URL.revokeObjectURL = (url) => { revoked.push(url); };
  globalThis.fetch = async (path, init) => {
    if (init?.method === "PUT") {
      writes.push(init); const form = init.body as FormData;
      published = { appearance: JSON.parse(String(form.get("settings"))), cover_url: form.get("cover_action") === "remove" ? null : "/api/company/cover?v=new" };
      return Response.json({ ok: true });
    }
    return Response.json(String(path).endsWith("/profile") ? company : published);
  };
  const state = hooks();
  const draw = () => nodes(render(state, () => BookingAppearanceEditor()));
  const button = (tree: any[], label: string) => tree.find((n) => n.props?.children === label && typeof n.props?.onClick === "function");
  const preview = (tree: any[]) => tree.find((n) => n.props?.preview)?.props.preview;
  try {
    draw(); await setImmediate(); let tree = draw();
    assert.equal(tree.find((n) => n.props?.type === "submit").props.disabled, false, "valid unchanged defaults can publish");
    assert.equal(preview(tree).company.cover_url, published.cover_url);
    handler(tree.find((n) => n.props?.["aria-label"] === "Color del texto"), "onInput")({ currentTarget: { value: "#ffffff" } });
    tree = draw();
    assert.equal(tree.find((n) => n.props?.type === "submit").props.disabled, true);
    assert.match(nodes(tree.find((n) => n.props?.id === "appearance-save-help")).join(" "), /No se puede guardar:.*4,5:1/);
    assert.equal(tree.find((n) => n.props?.type === "submit").props["aria-describedby"], "appearance-save-help");
    handler(tree.find((n) => n.type === "form"), "onSubmit")({ preventDefault() {} });
    assert.equal(writes.length, 0, "unreadable palette cannot publish");
    button(tree, "Cancelar cambios").props.onClick(); tree = draw();
    handler(tree.find((n) => n.props?.["aria-label"] === "Color de fondo"), "onInput")({ currentTarget: { value: "#f1f5f9" } });
    tree = draw(); assert.equal(preview(tree).company.appearance.background, "#f1f5f9");
    assert.equal(published.appearance.background, defaultAppearance.background);
    handler(tree.find((n) => n.type === "textarea"), "onInput")({ currentTarget: { value: "Unsaved welcome" } });
    tree = draw(); assert.equal(preview(tree).company.appearance.welcome, "Unsaved welcome"); assert.equal(writes.length, 0);
    button(tree, "Escritorio").props.onClick(); tree = draw();
    assert.ok(tree.some((n) => n.props?.style?.width === "760px"));
    assert.match(tree.find((n) => n.props?.style?.width === "760px").props.className, /max-w-full/);
    button(tree, "Móvil").props.onClick(); tree = draw();
    assert.ok(tree.some((n) => n.props?.style?.width === "375px"));
    assert.match(tree.find((n) => n.props?.style?.width === "375px").props.className, /max-w-full/);
    const file = new File(["draft"], "cover.png", { type: "image/png" });
    handler(tree.find((n) => n.props?.type === "file"), "onChange")({ currentTarget: { files: [file], value: "" } });
    draw(); tree = draw(); assert.equal(preview(tree).company.cover_url, "blob:draft"); assert.equal(writes.length, 0);
    handler(tree.find((n) => n.props?.["aria-label"] === "Color de botones"), "onInput")({ currentTarget: { value: "#ffffff" } });
    tree = draw();
    assert.equal(tree.find((n) => n.props?.type === "submit").props.disabled, true);
    assert.match(nodes(tree.find((n) => n.props?.id === "appearance-save-help")).join(" "), /3:1/);
    button(tree, "Usar colores predeterminados").props.onClick(); tree = draw();
    assert.equal(tree.find((n) => n.props?.type === "submit").props.disabled, false);
    assert.equal(preview(tree).company.cover_url, "blob:draft", "palette correction retains cover draft");
    assert.equal(preview(tree).company.appearance.welcome, "Unsaved welcome", "palette correction retains welcome");
    button(tree, "Cancelar cambios").props.onClick(); draw(); tree = draw();
    assert.equal(preview(tree).company.appearance.welcome, ""); assert.equal(preview(tree).company.cover_url, published.cover_url);
    assert.ok(revoked.includes("blob:draft")); assert.equal(writes.length, 0);
    button(tree, "Quitar portada al guardar").props.onClick(); tree = draw();
    assert.equal(preview(tree).company.cover_url, null); assert.ok(published.cover_url); assert.equal(writes.length, 0);
    button(tree, "Cancelar cambios").props.onClick(); tree = draw();
    handler(tree.find((n) => n.props?.type === "file"), "onChange")({ currentTarget: { files: [file], value: "" } });
    draw(); tree = draw();
    handler(tree.find((n) => n.type === "form"), "onSubmit")({ preventDefault() {} });
    await setImmediate(); draw(); tree = draw();
    assert.equal(writes.length, 1); assert.ok(writes[0].body instanceof FormData);
    assert.equal((writes[0].body as FormData).get("cover_action"), "replace");
    assert.equal(((writes[0].body as FormData).get("cover") as File).name, "cover.png");
    assert.ok(!(writes[0].headers as any)["Content-Type"], "browser supplies multipart boundary");
    assert.equal(preview(tree).company.cover_url, published.cover_url);
    button(tree, "Restablecer diseño").props.onClick(); draw(); tree = draw();
    assert.deepEqual(preview(tree).company.appearance, defaultAppearance); assert.equal(preview(tree).company.cover_url, null);
    assert.equal(writes.length, 1, "reset remains a draft");
    button(tree, "Cancelar cambios").props.onClick(); tree = draw();
    assert.equal(preview(tree).company.cover_url, published.cover_url);
    state.cleanups.forEach((cleanup) => cleanup?.());
  } finally {
    globalThis.fetch = originalFetch; URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl;
    delete (globalThis as any).__appearanceHooks;
  }
});

test("editor reports loading failures without an endless spinner and retries before allowing saves", async () => {
  const { BookingAppearanceEditor } = await load("booking-appearance-editor");
  const originalFetch = globalThis.fetch;
  let fail = true, writes = 0;
  globalThis.fetch = async (path, init) => {
    if (init?.method === "PUT") { writes++; throw new Error("Unexpected write"); }
    if (String(path).endsWith("/profile")) return Response.json(company);
    return fail ? Response.json({ error: "Configuración no disponible" }, { status: 503 })
      : Response.json({ appearance: defaultAppearance, cover_url: null });
  };
  const state = hooks();
  const draw = () => nodes(render(state, () => BookingAppearanceEditor()));
  try {
    let tree = draw();
    assert.ok(tree.includes("Cargando diseño… Espere antes de guardar."));
    assert.ok(!tree.some((n) => n.props?.type === "submit"));
    await setImmediate(); tree = draw();
    assert.ok(tree.includes("Configuración no disponible"));
    assert.ok(!tree.includes("Cargando diseño… Espere antes de guardar."));
    assert.ok(tree.some((n) => n.props?.role === "alert"));
    assert.ok(!tree.some((n) => n.type === "form"));
    fail = false;
    tree.find((n) => n.props?.children === "Reintentar carga").props.onClick();
    tree = draw(); assert.ok(tree.includes("Cargando diseño… Espere antes de guardar."));
    await setImmediate(); tree = draw();
    assert.equal(tree.find((n) => n.props?.type === "submit").props.disabled, false);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = originalFetch; delete (globalThis as any).__appearanceHooks; }
});

test("editor saves empty unchanged defaults, blocks duplicate submits, and recovers from a failed save without losing drafts", async () => {
  const { BookingAppearanceEditor } = await load("booking-appearance-editor");
  const originalFetch = globalThis.fetch;
  let writes = 0, finish: (response: Response) => void = () => {};
  let published = { appearance: { ...defaultAppearance }, cover_url: null };
  globalThis.fetch = async (path, init) => {
    if (init?.method === "PUT") {
      writes++;
      const form = init.body as FormData;
      assert.equal(form.get("cover_action"), "preserve");
      assert.equal(form.get("cover"), null);
      const response = await new Promise<Response>((resolve) => { finish = resolve; });
      if (response.ok) published = { ...published, appearance: JSON.parse(String(form.get("settings"))) };
      return response;
    }
    return Response.json(String(path).endsWith("/profile") ? company : published);
  };
  const state = hooks();
  const draw = () => nodes(render(state, () => BookingAppearanceEditor()));
  const submit = (tree: any[]) => handler(tree.find((n) => n.type === "form"), "onSubmit")({ preventDefault() {} });
  try {
    draw(); await setImmediate(); let tree = draw();
    assert.equal(tree.find((n) => n.props?.type === "submit").props.disabled, false);
    submit(tree); submit(tree);
    assert.equal(writes, 1, "same-render duplicate submit is blocked synchronously");
    tree = draw();
    assert.equal(tree.find((n) => n.type === "fieldset").props.disabled, true);
    assert.equal(tree.find((n) => n.props?.type === "submit").props.disabled, true);
    assert.ok(tree.includes("Guardando diseño. Espere a que termine la publicación."));
    finish(Response.json({ ok: true })); await setImmediate(); tree = draw();
    assert.equal(tree.find((n) => n.props?.type === "submit").props.disabled, false);
    assert.equal(tree.find((n) => n.type === "fieldset").props.disabled, false);
    assert.ok(tree.includes("Diseño guardado y publicado."));
    handler(tree.find((n) => n.type === "textarea"), "onInput")({ currentTarget: { value: "Keep my draft" } });
    tree = draw(); submit(tree);
    finish(Response.json({ error: "No se pudo publicar" }, { status: 503 }));
    await setImmediate(); tree = draw();
    assert.equal(tree.find((n) => n.type === "textarea").props.value, "Keep my draft");
    assert.equal(tree.find((n) => n.props?.type === "submit").props.disabled, false);
    assert.ok(tree.includes("No se pudo publicar"));
    tree.find((n) => n.props?.children === "Cancelar cambios").props.onClick(); tree = draw();
    assert.equal(tree.find((n) => n.type === "textarea").props.value, "");
  } finally { globalThis.fetch = originalFetch; delete (globalThis as any).__appearanceHooks; }
});
