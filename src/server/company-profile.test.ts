import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";
import { signToken } from "./auth.ts";
import { MAX_LOGO_BYTES, validLogo } from "./company-logo.ts";
import { companyUpgrade } from "../../scripts/public-booking-migration.mjs";
import { defaultAppearance } from "../shared/booking-appearance.ts";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const secret = "company-profile-test-secret-at-least-32-characters";
const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1kAAAAASUVORK5CYII=", "base64");
// A generated 1x1 baseline JPEG, independent of the platform's branding assets.
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==", "base64");
const fields = { name: " Updated salon ", description: " Public description ", address: " Main St 12 ",
  phone: " +54 11 1234 ", public_email: " contact@example.test ", website: " https://example.test/salon " };
let bundle: string;
let instance = 0;
before(async () => {
  const result = await build({ entryPoints: [new URL("./index.ts", import.meta.url).pathname], bundle: true,
    platform: "node", format: "esm", write: false });
  bundle = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
});

async function harness(t: { after: (action: () => void) => void }) {
  const { default: app } = await import(`${bundle}#profile-${instance++}`);
  app.onError(() => Response.json({ error: "Request failed" }, { status: 500 }));
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON"); db.exec(schema);
  db.exec(`INSERT INTO companies (id, name, slug, status) VALUES (1, 'One', 'one', 'active'), (2, 'Two', 'two', 'active'),
    (3, 'Pending', 'pending', 'pending'), (4, 'Disabled', 'disabled', 'disabled');
    INSERT INTO users (id, email, password_hash, role, company_id) VALUES
    (1, 'private-one@example.test', 'unused', 'tenant', 1), (2, 'private-two@example.test', 'unused', 'tenant', 2),
    (3, 'admin@example.test', 'unused', 'superadmin', NULL), (4, 'pending@example.test', 'unused', 'tenant', 3),
    (5, 'disabled@example.test', 'unused', 'tenant', 4);`);
  const d1 = {
    prepare(sql: string) { return { bind(...params: any[]) {
      const statement = db.prepare(sql);
      return {
        async first() {
          const row = statement.get(...params);
          if (row?.bytes instanceof Uint8Array) row.bytes = Array.from(row.bytes) as any;
          return row ?? null;
        },
        async all() { return { results: statement.all(...params) }; },
        async run() { const r = statement.run(...params); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
      };
    } }; },
    async batch(statements: { run: () => Promise<unknown> }[]) {
      db.exec("BEGIN");
      try { const result = []; for (const s of statements) result.push(await s.run()); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  const tokens = await Promise.all([1, 2, 3, 4, 5].map((id) => signToken(secret, id, 0)));
  async function request(method: string, path: string, body?: unknown, user = 1, headers: Record<string, string> = {}) {
    const token = tokens[user - 1];
    const multipart = body instanceof FormData;
    const raw = body instanceof Uint8Array || body instanceof ReadableStream || multipart;
    const init = { method, headers: { origin: "http://localhost", ...(!multipart ? { "content-type": raw ? "image/png" : "application/json" } : {}),
      ...(token ? { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf } : {}), ...headers },
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}), duplex: "half" };
    return app.request(path, init, { DB: d1, AUTH_SECRET: secret });
  }
  return { db, request };
}

test("profile GET/PUT derives tenant and updates public fields and session name only", async (t) => {
  const { db, request } = await harness(t);
  assert.equal((await request("PUT", "/api/company/profile", fields)).status, 200);
  const profile = await (await request("GET", "/api/company/profile")).json();
  assert.equal(profile.name, "Updated salon"); assert.equal(profile.address, "Main St 12");
  assert.equal(profile.description, "Public description"); assert.equal(profile.public_email, "contact@example.test");
  assert.equal((await (await request("GET", "/api/auth/session")).json()).company_name, "Updated salon");
  assert.equal((await (await request("GET", "/api/company/profile", undefined, 2)).json()).name, "Two");
  const overview = await (await request("GET", "/api/public/one/overview", undefined, 0)).json();
  assert.equal(overview.company.website, "https://example.test/salon");
  assert.equal(overview.company.name, "Updated salon");
  assert.deepEqual(Object.keys(overview.company).sort(), ["name", "slug", "description", "address", "phone", "public_email", "website", "social_links", "logo_url", "business_hours", "appearance", "cover_url"].sort());
  assert.ok(!JSON.stringify(overview).includes("private-one"));
  assert.equal((await request("PUT", "/api/company/profile", { name: "Clear optional" })).status, 200);
  assert.equal(db.prepare("SELECT public_email FROM companies WHERE id = 1").get()?.public_email, "contact@example.test");
  assert.equal((await request("PUT", "/api/company/profile", { public_email: " " })).status, 200);
  assert.equal(db.prepare("SELECT public_email FROM companies WHERE id = 1").get()?.public_email, "");
});

function appearanceForm(settings: unknown = defaultAppearance, action?: string, image?: Uint8Array, mime = "image/png") {
  const form = new FormData(); form.set("settings", JSON.stringify(settings));
  if (action) form.set("cover_action", action);
  if (image) form.set("cover", new Blob([image], { type: mime }), "cover.png");
  return form;
}

const portrait = { mime: "image/png", data: png.toString("base64") };
const MAX_STAFF_BODY = Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 64 * 1024;

test("staff portraits create, replace, preserve and remove atomically with versioned minimal metadata", async (t) => {
  const { db, request } = await harness(t);
  db.exec(`INSERT INTO services (id, name) VALUES (1, 'Fixture service');
    INSERT INTO tenant_ownership VALUES ('services', 1, 1);`);
  const created = await request("POST", "/api/staff", { name: "Fixture professional", photo: portrait, service_ids: [1], email: "portrait@example.test", working_hours: { mon: [["09:00", "12:00"]] } });
  assert.equal(created.status, 201);
  const { staff } = await created.json();
  assert.ok(staff.photo_url?.startsWith(`/api/staff/${staff.id}/photo?v=`));
  assert.deepEqual(staff.service_ids, [1], "photo insertion must not disturb last_insert_rowid service assignment");
  const url = staff.photo_url;
  const image = await request("GET", url);
  assert.equal(image.status, 200); assert.equal(image.headers.get("Content-Type"), "image/png");
  assert.equal(image.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(image.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await request("PUT", `/api/staff/${staff.id}`, { title: "Updated" })).status, 200);
  const list = (await (await request("GET", "/api/staff")).json()).staff;
  assert.equal(list[0].photo_url, url);
  assert.ok(!JSON.stringify(list).includes(portrait.data));
  assert.equal((await request("PUT", `/api/staff/${staff.id}`, { photo: { mime: "image/jpeg", data: jpeg.toString("base64") } })).status, 200);
  const replaced = (await (await request("GET", "/api/staff")).json()).staff[0].photo_url;
  assert.notEqual(replaced, url);
  assert.equal((await request("GET", replaced)).headers.get("Content-Type"), "image/jpeg");
  const overview = await (await request("GET", "/api/public/one/overview", undefined, 0)).json();
  assert.match(overview.staff[0].photo_url, new RegExp(`^/api/public/one/staff/${staff.id}/photo\\?v=`));
  assert.ok(!JSON.stringify(overview.staff).includes("portrait@example.test"));
  assert.ok(!JSON.stringify(overview.staff).includes("bytes"));
  assert.equal((await request("PUT", `/api/staff/${staff.id}`, { photo: null })).status, 200);
  assert.equal((await request("GET", replaced)).status, 404);
  assert.equal((await (await request("GET", "/api/staff")).json()).staff[0].photo_url, null);
});

test("invalid portrait cannot partially update staff, services, hours or professional credentials", async (t) => {
  const { db, request } = await harness(t);
  const created = await (await request("POST", "/api/staff", { name: "Fixture professional", email: "portrait@example.test", photo: portrait })).json();
  const id = created.staff.id;
  const before = db.prepare("SELECT * FROM staff WHERE id = ?").get(id);
  for (const photo of [{ mime: "image/png", data: "not base64" }, { mime: "image/jpeg", data: portrait.data },
    { mime: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") }, { mime: "image/png", data: Buffer.from("<html>bad</html>").toString("base64") },
    { mime: "image/png", data: Buffer.alloc(MAX_LOGO_BYTES + 1).toString("base64") }]) {
    const response = await request("PUT", `/api/staff/${id}`, { name: "Must not save", service_ids: [], working_hours: {}, professional_password: "fixture-secret-password", photo });
    assert.equal(response.status, 400);
    assert.deepEqual(db.prepare("SELECT * FROM staff WHERE id = ?").get(id), before);
    assert.equal(db.prepare("SELECT count(*) AS n FROM professional_accounts").get()?.n, 0);
    assert.equal((await request("GET", created.staff.photo_url)).status, 200);
  }
  const largeDimensions = Buffer.from(png); largeDimensions.writeUInt32BE(4097, 16);
  assert.equal((await request("PUT", `/api/staff/${id}`, { photo: { mime: "image/png", data: largeDimensions.toString("base64") } })).status, 400);
  assert.equal((await request("PUT", `/api/staff/${id}`, { professional_password: "fixture-secret-password" })).status, 200);
  const access = db.prepare("SELECT * FROM users WHERE email = 'portrait@example.test'").get();
  assert.equal((await request("PUT", `/api/staff/${id}`, { professional_password: "", photo: null })).status, 200);
  assert.deepEqual(db.prepare("SELECT * FROM users WHERE email = 'portrait@example.test'").get(), access, "blank password preserves credentials and sessions");
});

test("bounded staff mutations reject oversized streamed bodies without Content-Length before any mutation", async (t) => {
  const { db, request } = await harness(t);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_STAFF_BODY)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  assert.equal((await request("POST", "/api/staff", stream, 1, { "content-type": "application/json" })).status, 413);
  assert.equal(db.prepare("SELECT count(*) AS n FROM staff").get()?.n, 0);
  const malformed = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"photo":')); controller.close(); } });
  assert.equal((await request("POST", "/api/staff", malformed, 1, { "content-type": "application/json" })).status, 400);
  assert.equal((await request("POST", "/api/staff", {}, 1, { "content-length": String(MAX_STAFF_BODY + 1) })).status, 413);
});

test("a failed photo write rolls back the whole staff, services, hours and credential batch", async (t) => {
  const { db, request } = await harness(t);
  const { staff } = await (await request("POST", "/api/staff", { name: "Fixture professional", email: "portrait@example.test", photo: portrait })).json();
  const path = `/api/staff/${staff.id}`;
  assert.equal((await request("PUT", path, { professional_password: "fixture-original-password" })).status, 200);
  const beforeStaff = db.prepare("SELECT * FROM staff").all();
  const beforeUsers = db.prepare("SELECT * FROM users").all();
  const beforePhoto = db.prepare("SELECT * FROM staff_photos").all();
  db.exec("CREATE TRIGGER fixture_reject_photo BEFORE UPDATE ON staff_photos BEGIN SELECT RAISE(ABORT, 'fixture photo failure'); END;");
  const response = await request("PUT", path, { name: "Must roll back", email: "changed@example.test", professional_password: "fixture-replacement-password",
    service_ids: [], working_hours: {}, scheduling_mode: "consecutive", photo: portrait });
  assert.equal(response.status, 409);
  assert.deepEqual(db.prepare("SELECT * FROM staff").all(), beforeStaff);
  assert.deepEqual(db.prepare("SELECT * FROM users").all(), beforeUsers);
  assert.deepEqual(db.prepare("SELECT * FROM staff_photos").all(), beforePhoto);
});

test("portrait reads and writes isolate tenants, public inactivity and restricted own-identity portal access", async (t) => {
  const { db, request } = await harness(t);
  const { staff } = await (await request("POST", "/api/staff", { name: "Fixture professional", photo: portrait })).json();
  const path = `/api/staff/${staff.id}`;
  assert.equal((await request("GET", staff.photo_url, undefined, 2)).status, 404);
  assert.equal((await request("PUT", path, { photo: null }, 2)).status, 404);
  assert.equal((await request("PUT", `${path}?company_id=2`, { photo: null })).status, 400);
  assert.equal((await request("PUT", path, { photo: portrait, company_id: 2 })).status, 400);
  const publicPath = `/api/public/one/staff/${staff.id}/photo`;
  assert.equal((await request("GET", publicPath, undefined, 0)).status, 200);
  assert.equal((await request("GET", `/api/public/two/staff/${staff.id}/photo`, undefined, 0)).status, 404);
  db.exec(`UPDATE staff SET active = 0 WHERE id = ${staff.id}`);
  assert.equal((await request("GET", publicPath, undefined, 0)).status, 404);
  db.exec(`UPDATE staff SET active = 1 WHERE id = ${staff.id}; UPDATE companies SET status = 'disabled' WHERE id = 1`);
  assert.equal((await request("GET", publicPath, undefined, 0)).status, 404);
  db.exec(`UPDATE companies SET status = 'active' WHERE id = 1;
    INSERT INTO users (id, email, password_hash, role, company_id) VALUES (6, 'own-fixture@example.test', 'unused', 'tenant', 1);
    INSERT INTO professional_accounts (user_id, company_id, staff_id) VALUES (6, 1, ${staff.id});`);
  const token = await signToken(secret, 6, 0);
  const headers = { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf };
  const own = await request("GET", "/api/professional/photo", undefined, 0, headers);
  assert.equal(own.status, 200); assert.deepEqual(Buffer.from(await own.arrayBuffer()), png);
  assert.equal((await request("GET", "/api/staff", undefined, 0, headers)).status, 403);
  assert.equal((await request("GET", staff.photo_url, undefined, 0, headers)).status, 403);
  assert.equal((await request("PUT", path, { photo: null }, 0, headers)).status, 403);
  assert.equal((await request("PUT", "/api/professional/photo", {}, 0, headers)).status, 403);
  const agenda = await (await request("GET", "/api/professional/agenda?date=2030-01-01", undefined, 0, headers)).json();
  assert.match(agenda.staff.photo_url, /^\/api\/professional\/photo\?v=/);
  assert.deepEqual(Object.keys(agenda.staff).sort(), ["effective_hours", "name", "photo_url"]);
  db.exec(`UPDATE staff SET active = 0 WHERE id = ${staff.id}`);
  assert.equal((await request("GET", "/api/professional/photo", undefined, 0, headers)).status, 403);
});

test("portrait additive schema repeats without changing prior data and enforces ownership and cascade", async (t) => {
  const { db, request } = await harness(t);
  await request("POST", "/api/staff", { name: "Fixture professional" });
  db.exec("DROP TABLE staff_photos");
  const prior = db.prepare("SELECT * FROM staff").all();
  db.exec(schema); db.exec(schema);
  assert.deepEqual(db.prepare("SELECT * FROM staff").all(), prior);
  assert.equal(db.prepare("SELECT count(*) AS n FROM staff_photos").get()?.n, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const id = Number(prior[0].id);
  assert.throws(() => db.prepare("INSERT INTO staff_photos VALUES (?, 2, ?, 'image/png', 'test')").run(id, png), /staff photo must belong to company/);
  assert.equal((await request("PUT", `/api/staff/${id}`, { photo: portrait })).status, 200);
  assert.equal((await request("DELETE", `/api/staff/${id}`, {})).status, 200);
  assert.equal(db.prepare("SELECT count(*) AS n FROM staff_photos").get()?.n, 0);
});

test("appearance defaults old rows, atomically saves public design and preserves profile, hours, logo and other tenants", async (t) => {
  const { db, request } = await harness(t);
  const initial = await (await request("GET", "/api/company/appearance")).json();
  assert.deepEqual(initial, { appearance: defaultAppearance, cover_url: null });
  assert.deepEqual((await (await request("GET", "/api/public/one/overview", undefined, 0)).json()).company.appearance, defaultAppearance);
  await request("PUT", "/api/company/profile", fields);
  await request("PUT", "/api/company/logo", png);
  const before = await (await request("GET", "/api/company/profile")).json();
  const design = { background: "#111111", text: "#ffffff", button: "#dddddd", welcome: "Welcome <script>not HTML</script>" };
  assert.equal((await request("PUT", "/api/company/appearance", appearanceForm(design, "replace", png))).status, 200);
  const saved = await (await request("GET", "/api/company/appearance")).json();
  assert.deepEqual(saved.appearance, design); assert.match(saved.cover_url, /^\/api\/company\/cover\?v=/);
  const publicData = (await (await request("GET", "/api/public/one/overview", undefined, 0)).json()).company;
  assert.deepEqual(publicData.appearance, design); assert.match(publicData.cover_url, /^\/api\/public\/one\/cover\?v=/);
  assert.ok(!JSON.stringify(publicData).includes('"bytes"'));
  const after = await (await request("GET", "/api/company/profile")).json();
  for (const key of ["name", "social_links", "business_hours", "logo_url", "description"]) assert.deepEqual(after[key], before[key]);
  const cover = await request("GET", "/api/public/one/cover", undefined, 0);
  assert.equal(cover.headers.get("content-type"), "image/png");
  assert.equal(cover.headers.get("x-content-type-options"), "nosniff"); assert.equal(cover.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await cover.arrayBuffer()), png);
  assert.equal(db.prepare("SELECT typeof(bytes) AS kind FROM company_booking_appearance").get()?.kind, "blob");
  assert.equal((await request("GET", "/api/company/cover", undefined, 2)).status, 404);
  assert.equal((await request("GET", "/api/public/two/cover", undefined, 0)).status, 404);
  assert.deepEqual((await (await request("GET", "/api/company/appearance", undefined, 2)).json()).appearance, defaultAppearance);
  await request("PUT", "/api/company/profile", { description: "Profile change" });
  assert.deepEqual((await (await request("GET", "/api/company/appearance")).json()).appearance, design);
});

test("appearance cover omission preserves, replacement invalidates URL, removal follows save and failures leave all bytes unchanged", async (t) => {
  const { db, request } = await harness(t);
  await request("PUT", "/api/company/appearance", appearanceForm(defaultAppearance, "replace", png));
  const initial = await (await request("GET", "/api/company/appearance")).json();
  const changed = { ...defaultAppearance, welcome: "Changed" };
  await request("PUT", "/api/company/appearance", appearanceForm(changed));
  assert.equal((await (await request("GET", "/api/company/appearance")).json()).cover_url, initial.cover_url);
  assert.deepEqual(Buffer.from(await (await request("GET", "/api/company/cover")).arrayBuffer()), png);
  const malformed = Buffer.from(png); malformed.writeUInt32BE(4097, 16);
  for (const [image, mime] of [[malformed, "image/png"], [png.subarray(0, 30), "image/png"], [png, "image/jpeg"],
    [Buffer.from("<svg/>"), "image/svg+xml"], [new Uint8Array(), "image/png"], [new Uint8Array(MAX_LOGO_BYTES + 1), "image/png"]] as const) {
    assert.equal((await request("PUT", "/api/company/appearance", appearanceForm(defaultAppearance, "replace", image, mime))).status, 400);
    assert.deepEqual((await (await request("GET", "/api/company/appearance")).json()).appearance, changed);
    assert.deepEqual(Buffer.from(await (await request("GET", "/api/company/cover")).arrayBuffer()), png);
  }
  // A database failure cannot publish just the metadata or just the new image.
  db.exec("CREATE TRIGGER reject_appearance BEFORE UPDATE ON company_booking_appearance BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await request("PUT", "/api/company/appearance", appearanceForm(defaultAppearance, "replace", jpeg, "image/jpeg"))).status, 500);
  assert.deepEqual((await (await request("GET", "/api/company/appearance")).json()).appearance, changed);
  assert.deepEqual(Buffer.from(await (await request("GET", "/api/company/cover")).arrayBuffer()), png);
  db.exec("DROP TRIGGER reject_appearance");
  await request("PUT", "/api/company/appearance", appearanceForm(changed, "replace", jpeg, "image/jpeg"));
  assert.notEqual((await (await request("GET", "/api/company/appearance")).json()).cover_url, initial.cover_url);
  assert.deepEqual(Buffer.from(await (await request("GET", "/api/company/cover")).arrayBuffer()), jpeg);
  await request("PUT", "/api/company/appearance", appearanceForm(defaultAppearance, "remove"));
  assert.equal((await request("GET", "/api/company/cover")).status, 404);
  assert.equal((await (await request("GET", "/api/public/one/overview", undefined, 0)).json()).company.cover_url, null);
});

test("appearance rejects CSS injection, contrast failures, oversize welcome, selectors and unknown/duplicate fields", async (t) => {
  const { db, request } = await harness(t);
  for (const invalid of [{ background: "red" }, { text: "#fff" }, { button: "url(javascript:bad())" }, { text: "#ffffff" },
    { button: "#ffffff" }, { welcome: "x".repeat(501) }, { welcome: null }, { company_id: 2 }, { status: "active" }, { slug: "two" }]) {
    assert.equal((await request("PUT", "/api/company/appearance", appearanceForm({ ...defaultAppearance, ...invalid }, "replace", png))).status, 400);
  }
  for (const form of [appearanceForm(defaultAppearance, "unknown"), appearanceForm(defaultAppearance, "replace"), appearanceForm(defaultAppearance, "remove", png)])
    assert.equal((await request("PUT", "/api/company/appearance", form)).status, 400);
  const extra = appearanceForm(); extra.set("company_id", "2");
  assert.equal((await request("PUT", "/api/company/appearance", extra)).status, 400);
  const duplicate = appearanceForm(); duplicate.append("settings", "{}");
  assert.equal((await request("PUT", "/api/company/appearance", duplicate)).status, 400);
  assert.equal((await request("PUT", "/api/company/appearance?company_id=2", appearanceForm())).status, 400);
  assert.equal((await request("GET", "/api/company/appearance?company_id=2")).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM company_booking_appearance").get()?.n, 0);
});

test("appearance enforces tenant auth, origin, CSRF, inactive public constraints and chunked multipart limits", async (t) => {
  const { db, request } = await harness(t);
  for (const user of [0, 3, 4, 5]) {
    const expected = user === 0 ? 401 : 403;
    assert.equal((await request("GET", "/api/company/appearance", undefined, user)).status, expected);
    assert.equal((await request("GET", "/api/company/cover", undefined, user)).status, expected);
    assert.equal((await request("PUT", "/api/company/appearance", appearanceForm(), user)).status, expected);
  }
  for (const headers of [{ origin: "https://evil.test" }, { "x-csrf-token": "bad" }])
    assert.equal((await request("PUT", "/api/company/appearance", appearanceForm(), 1, headers)).status, 403);
  await request("PUT", "/api/company/appearance", appearanceForm(defaultAppearance, "replace", png));
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } });
  assert.equal((await request("PUT", "/api/company/appearance", stream, 1, { "content-type": "multipart/form-data; boundary=test" })).status, 413);
  assert.equal(cancelled, true);
  assert.equal((await request("PUT", "/api/company/appearance", appearanceForm(), 1,
    { "content-length": String(MAX_LOGO_BYTES + 16385) })).status, 413);
  assert.deepEqual(Buffer.from(await (await request("GET", "/api/company/cover")).arrayBuffer()), png);
  db.exec("UPDATE companies SET status = 'disabled' WHERE id = 1");
  for (const slug of ["one", "pending", "disabled", "missing"])
    assert.equal((await request("GET", `/api/public/${slug}/cover`, undefined, 0)).status, 404);
});

test("appearance additive schema preserves legacy company rows and appearance data on repeat", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const old = schema.replace(/-- Appearance and cover publish[\s\S]*?(?=CREATE TABLE IF NOT EXISTS company_logos)/, "");
    db.exec(old); db.exec("INSERT INTO companies (id, name, status) VALUES (42, 'Preserved', 'active')");
    db.exec(schema);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM company_booking_appearance").get()?.n, 0);
    db.prepare("INSERT INTO company_booking_appearance (company_id, settings, bytes, content_type, revision) VALUES (?, ?, ?, ?, ?)")
      .run(42, JSON.stringify(defaultAppearance), png, "image/png", "kept");
    db.exec(schema);
    assert.equal(db.prepare("SELECT name FROM companies").get()?.name, "Preserved");
    assert.equal(db.prepare("SELECT revision FROM company_booking_appearance").get()?.revision, "kept");
    assert.deepEqual(Buffer.from(db.prepare("SELECT bytes FROM company_booking_appearance").get()?.bytes as Uint8Array), png);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("social links persist per tenant, preserve omissions, clear individually or together without changing hours/logo", async (t) => {
  const { db, request } = await harness(t);
  await request("PUT", "/api/company/logo", png);
  const before = await (await request("GET", "/api/company/profile")).json();
  const links = { instagram: " https://www.instagram.com/example ", facebook: "https://m.facebook.com/example",
    tiktok: "https://vm.tiktok.com/example", youtube: "https://youtu.be/example", linkedin: "http://www.linkedin.com/company/example" };
  assert.equal((await request("PUT", "/api/company/profile", { ...fields, social_links: links })).status, 200);
  const saved = await (await request("GET", "/api/company/profile")).json();
  assert.equal(saved.social_links.instagram, links.instagram.trim());
  assert.deepEqual(saved.business_hours, before.business_hours);
  assert.equal(saved.logo_url, before.logo_url);
  assert.deepEqual((await (await request("GET", "/api/company/profile", undefined, 2)).json()).social_links, {});
  assert.deepEqual((await (await request("GET", "/api/public/two/overview", undefined, 0)).json()).company.social_links, {});
  assert.deepEqual((await (await request("GET", "/api/public/one/overview", undefined, 0)).json()).company.social_links, saved.social_links);
  await request("PUT", "/api/company/profile", { description: "Changed only" });
  assert.deepEqual((await (await request("GET", "/api/company/profile")).json()).social_links, saved.social_links);
  await request("PUT", "/api/company/profile", { social_links: { instagram: "  " } });
  const cleared = (await (await request("GET", "/api/company/profile")).json()).social_links;
  assert.equal(cleared.instagram, undefined); assert.equal(cleared.facebook, links.facebook);
  await request("PUT", "/api/company/profile", { social_links: {} });
  assert.deepEqual((await (await request("GET", "/api/public/one/overview", undefined, 0)).json()).company.social_links, {});
  assert.equal(db.prepare("SELECT name FROM companies WHERE id = 2").get()?.name, "Two");
});

test("invalid social links and mass assignment reject the entire profile update", async (t) => {
  const { db, request } = await harness(t);
  for (const social_links of [{ instagram: "javascript:alert(1)" }, { facebook: "data:text/html,x" },
    { tiktok: "ftp://tiktok.com/example" }, { youtube: "//youtube.com/example" }, { linkedin: "not a URL" },
    { instagram: "https://user:pass@instagram.com/example" }, { instagram: "https://user@instagram.com" },
    { instagram: "https://instagram.com/" + "x".repeat(500) }, { instagram: null }, { unknown: "https://example.test" },
    { company_id: 2 }, { status: "active" }]) {
    assert.equal((await request("PUT", "/api/company/profile", { ...fields, social_links })).status, 400);
    assert.equal(db.prepare("SELECT name FROM companies WHERE id = 1").get()?.name, "One");
    assert.equal(db.prepare("SELECT social_links FROM companies WHERE id = 1").get()?.social_links, "{}");
  }
  for (const extra of [{ company_id: 2 }, { status: "disabled" }])
    assert.equal((await request("PUT", "/api/company/profile", { social_links: { instagram: "https://instagram.com/example" }, ...extra })).status, 400);
});

test("profile rejects mass assignment, cross-tenant selectors, unsafe URL, invalid fields atomically", async (t) => {
  const { db, request } = await harness(t);
  for (const invalid of [{ company_id: 2 }, { status: "active" }, { slug: "other" }, { logo_url: "data:image/svg+xml,x" },
    { business_hours: {} }, { name: " " }, { name: "x".repeat(121) }, { description: "x".repeat(501) },
    { address: "x".repeat(301) }, { phone: "x".repeat(41) }, { public_email: "not-email" },
    { website: "javascript:alert(1)" }, { website: "data:text/html,x" }, { website: "https://user:pass@example.test" }]) {
    assert.equal((await request("PUT", "/api/company/profile", { ...fields, ...invalid })).status, 400, JSON.stringify(invalid));
    assert.equal(db.prepare("SELECT name FROM companies WHERE id = 1").get()?.name, "One");
  }
  assert.equal((await request("PUT", "/api/company/profile?company_id=2", fields)).status, 400);
  assert.equal((await request("GET", "/api/company/profile?company_id=2")).status, 400);
  assert.equal((await request("PUT", "/api/company/profile", { ...fields, description: "x".repeat(9000) })).status, 413);
});

test("profile and logo deny anonymous, superadmin, pending and disabled actors and enforce origin/CSRF", async (t) => {
  const { request } = await harness(t);
  for (const user of [0, 3, 4, 5]) {
    const expected = user === 0 ? 401 : 403;
    for (const [method, path, body] of [["GET", "/api/company/profile"], ["PUT", "/api/company/profile", fields],
      ["GET", "/api/company/logo"], ["PUT", "/api/company/logo", png], ["DELETE", "/api/company/logo", {}]] as const)
      assert.equal((await request(method, path, body, user)).status, expected);
  }
  for (const headers of [{ origin: "https://evil.test" }, { "x-csrf-token": "bad" }]) {
    assert.equal((await request("PUT", "/api/company/profile", fields, 1, headers)).status, 403);
    assert.equal((await request("PUT", "/api/company/logo", png, 1, headers)).status, 403);
    assert.equal((await request("DELETE", "/api/company/logo", {}, 1, headers)).status, 403);
  }
});

test("logo stores bounded BLOB, serves bytes safely, replaces and removes without crossing tenants", async (t) => {
  const { db, request } = await harness(t);
  assert.equal((await request("PUT", "/api/company/logo", png)).status, 200);
  assert.equal(db.prepare("SELECT typeof(bytes) AS kind FROM company_logos WHERE company_id = 1").get()?.kind, "blob");
  assert.equal((await request("GET", "/api/company/logo", undefined, 2)).status, 404);
  assert.equal((await request("GET", "/api/public/two/logo", undefined, 0)).status, 404);
  const response = await request("GET", "/api/public/one/logo", undefined, 0);
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  const before = await (await request("GET", "/api/company/profile")).json();
  assert.equal((await request("PUT", "/api/company/logo", jpeg, 1, { "content-type": "image/jpeg" })).status, 200);
  const replacement = await request("GET", "/api/public/one/logo", undefined, 0);
  assert.equal(replacement.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await replacement.arrayBuffer()), jpeg);
  assert.notEqual((await (await request("GET", "/api/company/profile")).json()).logo_url, before.logo_url);
  assert.equal((await request("PUT", "/api/company/logo?company_id=2", png)).status, 400);
  assert.equal((await request("DELETE", "/api/company/logo?company_id=2", {})).status, 400);
  assert.equal((await request("DELETE", "/api/company/logo", {}, 2)).status, 200);
  assert.equal((await request("GET", "/api/public/one/logo", undefined, 0)).status, 200);
  assert.equal((await request("DELETE", "/api/company/logo", {})).status, 200);
  assert.equal((await request("GET", "/api/public/one/logo", undefined, 0)).status, 404);
  assert.equal((await (await request("GET", "/api/public/one/overview", undefined, 0)).json()).company.logo_url, null);
});

test("invalid MIME, magic, dimensions, truncation and JSON cannot overwrite a logo", async (t) => {
  const { request } = await harness(t);
  await request("PUT", "/api/company/logo", png);
  const huge = Buffer.from(png); huge.writeUInt32BE(4097, 16);
  for (const invalid of [new Uint8Array(), Buffer.from("<svg><script>bad()</script></svg>"), huge, png.subarray(0, 30)])
    assert.equal((await request("PUT", "/api/company/logo", invalid)).status, 400);
  assert.equal((await request("PUT", "/api/company/logo", png, 1, { "content-type": "image/jpeg" })).status, 400);
  assert.equal((await request("PUT", "/api/company/logo", png, 1, { "content-type": "image/svg+xml" })).status, 403);
  assert.equal((await request("PUT", "/api/company/logo", { company_id: 2, bytes: Array.from(png) })).status, 400);
  assert.deepEqual(Buffer.from(await (await request("GET", "/api/company/logo")).arrayBuffer()), png);
});

test("oversize chunked upload without Content-Length is cancelled and leaves logo unchanged", async (t) => {
  const { request } = await harness(t);
  await request("PUT", "/api/company/logo", png);
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536)); },
    cancel() { cancelled = true; } });
  assert.equal((await request("PUT", "/api/company/logo", stream)).status, 413);
  assert.equal(cancelled, true);
  assert.equal((await request("PUT", "/api/company/logo", png, 1, { "content-length": String(MAX_LOGO_BYTES + 1) })).status, 413);
  assert.equal((await request("PUT", "/api/company/logo", new Uint8Array(MAX_LOGO_BYTES + 1))).status, 413);
  assert.deepEqual(Buffer.from(await (await request("GET", "/api/company/logo")).arrayBuffer()), png);
});

test("public logo and overview disappear for nonexistent or inactive companies", async (t) => {
  const { db, request } = await harness(t);
  await request("PUT", "/api/company/logo", png);
  assert.match((await (await request("GET", "/api/public/one/overview", undefined, 0)).json()).company.logo_url, /^\/api\/public\/one\/logo\?v=/);
  db.exec("UPDATE companies SET status = 'disabled' WHERE id = 1");
  for (const slug of ["one", "pending", "disabled", "missing"])
    for (const endpoint of ["logo", "overview"])
      assert.equal((await request("GET", `/api/public/${slug}/${endpoint}`, undefined, 0)).status, 404);
});

test("profile migration is additive and repeatable, preserving hours and existing rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const oldSchema = schema.replace(/^  (description|address|phone|public_email|website) TEXT NOT NULL DEFAULT '',\n/gm, "")
      .replace("  social_links TEXT NOT NULL DEFAULT '{}',\n", "");
    db.exec(oldSchema);
    db.exec(`INSERT INTO companies (id, name, slug, status, business_hours) VALUES (42, 'Preserved', 'preserved', 'active', '{"mon":[]}');`);
    for (let pass = 0; pass < 2; pass++) {
      db.exec(companyUpgrade(db.prepare("PRAGMA table_info(companies)").all())); db.exec(schema);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM companies").get()?.n, 1);
      assert.equal(db.prepare("SELECT business_hours FROM companies").get()?.business_hours, '{"mon":[]}');
      assert.equal(db.prepare("SELECT name FROM companies").get()?.name, "Preserved");
      assert.equal(db.prepare("SELECT phone FROM companies").get()?.phone, pass === 0 ? "" : "Keep me");
      assert.equal(db.prepare("SELECT social_links FROM companies").get()?.social_links, pass === 0 ? "{}" : '{"instagram":"https://instagram.com/example"}');
      db.exec(`UPDATE companies SET social_links = '{"instagram":"https://instagram.com/example"}'`);
      db.exec("UPDATE companies SET phone = 'Keep me'");
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    }
    assert.equal(validLogo(png, "image/png"), true);
    assert.equal(validLogo(png, "image/jpeg"), false);
  } finally { db.close(); }
});
