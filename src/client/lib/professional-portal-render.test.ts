import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

test("private agenda renders focused views and safe actions; rejected reschedules retain their draft", async () => {
  const result = await build({ entryPoints: [new URL("../components/professional-portal.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false, loader: { ".css": "empty" },
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" },
    plugins: [{ name: "agenda-render", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: { importer: string }) => args.importer.includes("/src/client/") ? { path: "hooks", namespace: "agenda-render" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "agenda-render" }, () => ({ contents: `
        export const useState = initial => { const s = globalThis.__agendaRender, i = s.index++;
          if (!(i in s.values)) s.values[i] = initial;
          return [s.values[i], value => s.values[i] = typeof value === 'function' ? value(s.values[i]) : value]; };
        export const useRef = initial => { const s = globalThis.__agendaRender, i = s.refIndex++; return s.refs[i] ||= {current:initial}; };
        export const useEffect = () => {};
      ` }));
      builder.onResolve({ filter: /^@radix-ui\/react-dialog$/ }, () => ({ path: "dialog", namespace: "agenda-dialog" }));
      builder.onLoad({ filter: /.*/, namespace: "agenda-dialog" }, () => ({ contents: `import {h} from 'preact';
        const wrap = tag => props => h(tag, props, props.children);
        export const Root=wrap('dialog-root'), Portal=wrap('dialog-portal'), Overlay=wrap('dialog-overlay'), Content=wrap('dialog-content'), Title=wrap('h2'), Description=wrap('p');`, resolveDir: process.cwd() }));
    } }],
  });
  const { ProfessionalPortal } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const globals = globalThis as any;
  const previous = { __agendaRender: globals.__agendaRender, fetch: globals.fetch };
  const state = { index: 0, refIndex: 0, values: {} as Record<number, any>, refs: [] as any[] };
  globals.__agendaRender = state;
  let nodes: any[] = [];
  const visit = (node: any): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node.type === "function") { visit(node.type(node.props)); return; }
    nodes.push(node); visit(node.props?.children);
  };
  const render = () => { state.index = 0; state.refIndex = 0; nodes = []; visit(ProfessionalPortal({ companyName: "Estudio de ejemplo", logout: async () => {} })); };
  const text = (node: any): string => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : node == null ? "" : String(node);
  const button = (label: string) => nodes.find(node => node.type === "button" && text(node) === label);
  const booking = { id: 1, identifier: "APT-EXAMPLE", client_name: "Cliente de ejemplo", client_phone: "+12025550123", client_email: "person@example.invalid", scheduled_date: "2037-11-02", start_time: "10:00", end_time: "11:00", status: "confirmed", notes: "", services: [] };
  try {
    render();
    assert.ok(nodes.some(node => node.props.role === "status" && text(node).includes("Cargando agenda")));
    state.values[1] = { appointments: [booking], upcoming: [], staff: null };
    render();
    assert.equal(nodes.find(node => node.props.role === "tab" && node.props["aria-selected"]).props.children, "Día");
    assert.equal(nodes.filter(node => node.props.role === "tabpanel").length, 1);
    assert.ok(button("Día anterior") === undefined, "date controls have separate accessible labels");
    nodes.find(node => node.props["aria-label"] === "Día siguiente").props.onClick();
    assert.equal(state.values[1], null, "changing date clears the old date's agenda");
    state.values[1] = { appointments: [booking], upcoming: [], staff: null };
    render(); button("Próximos").props.onClick(); render();
    assert.ok(nodes.some(node => node.type === "h3" && text(node) === "Sin próximos turnos"));
    assert.equal(nodes.some(node => node.props.className === "pa-datebar"), false);
    state.values[15] = true; state.values[4] = "Error de conexión de ejemplo";
    render(); assert.ok(nodes.some(node => node.props.role === "alert"));
    assert.ok(nodes.some(node => node.props.role === "status" && text(node).includes("Sin conexión")));
    state.values[15] = false; state.values[4] = ""; state.values[2] = booking; state.values[3] = 1;
    render();
    assert.equal(nodes.find(node => node.type === "a").props.href, "tel:+12025550123");
    assert.ok(text(nodes).includes("Finalizar no registra un pago."));
    let writes = 0;
    globals.fetch = async () => { writes++; return new Response(JSON.stringify({ error: "Horario ocupado. Elija otro horario." }), { status: 409 }); };
    button("Cancelar turno").props.onClick({ currentTarget: {} }); render();
    assert.equal(writes, 0, "opening cancellation never writes");
    assert.equal(button("Confirmar cancelación").props.disabled, true);
    assert.equal(state.values[14], "cancelled");
    button("Volver al turno").props.onClick(); render();
    button("Reprogramar").props.onClick(); render();
    const time = nodes.find(node => node.type === "input" && node.props.type === "time");
    time.props.onInput({ currentTarget: { value: "12:17" } });
    state.values[11] = true; render();
    await nodes.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    render();
    assert.equal(writes, 1);
    assert.equal(state.values[12].time, "12:17", "409 retains entered time");
    assert.equal(state.values[12].date, booking.scheduled_date);
    assert.equal(state.values[2], booking, "failure preserves the open detail");
    assert.ok(nodes.some(node => node.props.role === "alert" && text(node).includes("Horario ocupado")));
    assert.equal(state.values[9], false);
    state.values[2] = { ...booking, start_time: "10:30" }; render();
    assert.equal(button("Guardar reprogramación").props.disabled, true, "poll changes invalidate original snapshot without clearing draft");
    assert.equal(state.values[12].time, "12:17");
    state.values[2] = { ...booking, status: "cancelled" }; render();
    assert.equal(nodes.find(node => node.type === "input" && node.props.type === "time").props.value, "12:17");
    assert.equal(button("Guardar reprogramación").props.disabled, true, "status changes keep the draft visible but cannot be saved");
    state.values[2] = null; state.values[4] = "No se pudo cargar el turno"; render();
    assert.ok(nodes.some(node => node.props.role === "alert" && text(node).includes("No se pudo cargar el turno")));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globals[key]; else globals[key] = value; }
  }
});

test("private workspace CSS supports small viewports, scoped theme and reduced motion", async () => {
  const css = await readFile(new URL("../components/professional-portal.css", import.meta.url), "utf8");
  assert.match(css, /100dvh/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /min-height: 48px/);
  assert.doesNotMatch(css, /(?:^|\n)(?:body|:root)\s*\{/);
  assert.doesNotMatch(css, /overflow-x:\s*hidden/);
});
