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
         : `export const useRef = initial => {
           const state = globalThis.__staffRender, index = state.index++;
           if (!(index in state.values)) state.values[index] = { current: initial };
           return state.values[index];
         }; export const useState = initial => {
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
  let groups = new Map<any, any>();
  function visit(node: any, group?: any) {
    if (Array.isArray(node)) return node.forEach((child) => visit(child, group));
    if (!node || typeof node !== "object") return;
    nodes.push(node); groups.set(node, group);
    visit(node.props?.children, node.type === "fieldset" ? node : group);
  }
  let staff: any;
  function render() {
    globals.__staffRender = state; state.index = 0; nodes = []; groups = new Map();
    visit(CreateStaff({ onClose() {}, staff }));
    assertGroups();
  }
  const byId = (id: string) => nodes.find((node) => node.props?.id === id);
  const checkboxes = () => nodes.filter((node) => node.type === "input" && node.props.type === "checkbox");
  function assertGroups() {
    const group = (title: string) => {
      const legend = nodes.find((node) => node.type === "legend" && node.props.children === title);
      assert.ok(legend, `Missing legend: ${title}`);
      const fieldset = groups.get(legend);
      assert.equal(fieldset?.type, "fieldset");
      return fieldset;
    };
    const services = group("Servicios que ofrece");
    const hours = group("Horarios de atención");
    const method = group("Método de agenda");
    assert.equal(new Set([services, hours, method]).size, 3, "Groups must be separate fieldsets");
    if (staff) {
      const access = group("Acceso al portal profesional");
      assert.equal(new Set([services, hours, method, access]).size, 4);
      assert.equal(groups.get(byId("professional-password")), access);
      assert.equal(byId("professional-password").props.type, "password");
      assert.equal(byId("professional-password").props.autoComplete, "new-password");
      assert.equal(byId("professional-password").props.value, undefined, "password is uncontrolled, never filled from staff data");
      assert.equal(byId("professional-password").props.minLength, 12);
      assert.equal(nodes.find((node) => node.type === "a" && node.props.children === "Portal del profesional")?.props.href, "/profesionales/login");
    }
    const [service, inherit] = checkboxes();
    assert.equal(groups.get(service), services, "Only service assignments belong to services");
    assert.equal(groups.get(inherit), hours, "Inheritance must not look like another service");
    assert.equal(groups.get(byId("scheduling-mode")), method);
    if (byId("scheduling-interval")) assert.equal(groups.get(byId("scheduling-interval")), method);
    assert.equal(groups.get(nodes.find((node) => node.props?.id === "scheduling-help")), method);
    const warning = nodes.find((node) => node.props?.role === "status" && node.props?.children?.startsWith("Sin servicios"));
    if (warning) assert.equal(groups.get(warning), services);
    const weeklyEditor = nodes.find((node) => node.props?.personal === true && node.props?.onChange);
    if (weeklyEditor) assert.equal(groups.get(weeklyEditor), hours, "Weekly overrides belong to hours");
    assert.match(groups.get(inherit).props.children.find((node: any) => node?.type === "label").props.children.join(" "), /horarios de atención de la empresa/);
  }
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
    checkboxes()[1].props.onChange({ currentTarget: { checked: true } }); render();
    await save();
    assert.equal(saved.at(-1).working_hours, null, "Company hours remain inherited");
    checkboxes()[1].props.onChange({ currentTarget: { checked: false } }); render();
    await save();
    assert.deepEqual(saved.at(-1).working_hours, {}, "Missing personal days still inherit");
    const weeklyEditor = nodes.find((node) => node.props?.personal === true && node.props?.onChange);
    weeklyEditor.props.onChange({ mon: [] }); render();
    checkboxes()[0].props.onChange({ currentTarget: { checked: false } }); render();
    await save();
    assert.deepEqual(saved.at(-1).working_hours, { mon: [] }, "Explicit closed days remain closed");
    assert.deepEqual(saved.at(-1).service_ids, [], "Clearing assignments stays explicit, not omitted");
    const password = byId("professional-password");
    password.ref.current = { value: "fictional transient password" };
    password.props.onInput({ currentTarget: password.ref.current }); render();
    assert.ok(nodes.some((node) => node.props.children === "Guardar y crear acceso"));
    await nodes.find((node) => node.props.children === "Guardar y crear acceso").props.onClick(); render();
    assert.equal(byId("professional-password").ref.current.value, "");
    assert.equal(saved.at(-1).professional_password, "fictional transient password");
    assert.ok(nodes.some((node) => node.props.id === "professional-access-help" && node.props.children.includes("Deje vacío")));
    const photoEditor = () => nodes.find((node) => typeof node.props?.onBusy === "function");
    const photoCount = saved.length;
    photoEditor().props.onChange({ mime: "image/png", data: "fixture-only" }); render();
    assert.equal(saved.length, photoCount, "choosing a photo does not publish the draft");
    photoEditor().props.onBusy(true); render(); await save();
    assert.equal(saved.length, photoCount, "pending image decoding blocks whole form save");
    photoEditor().props.onBusy(false); render(); await save();
    assert.deepEqual(saved.at(-1).photo, { mime: "image/png", data: "fixture-only" });
    assert.equal(saved.at(-1).professional_password, undefined, "photo save never resubmits cleared password");
    photoEditor().props.onChange(null); render(); await save();
    assert.equal(saved.at(-1).photo, null, "removal is explicit in the atomic save");
    photoEditor().props.onChange(undefined); render(); await save();
    assert.equal("photo" in saved.at(-1), false, "unchanged photo is omitted, never implicitly cleared");
    context.updateStaff = async () => { throw new Error("Isolated failure"); };
    byId("professional-password").ref.current.value = "fictional retry password";
    await save();
    assert.equal(byId("professional-password").ref.current.value, "", "failed submission never retains a secret for retry");
  } finally {
    if (previous === undefined) delete globals.__staffRender; else globals.__staffRender = previous;
  }
});
