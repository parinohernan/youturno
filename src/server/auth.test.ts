import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";
import { hashPassword, signToken, verifyToken } from "./auth.ts";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const secret = "test-secret-for-JWT-at-least-32-characters";
let bundle: string;
let scenario = 0;
before(async () => {
  const result = await build({ entryPoints: [new URL("./index.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false });
  bundle = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
});

async function harness(t: { after: (fn: () => void) => void }) {
  const { default: app } = await import(`${bundle}#${scenario++}`);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const d1 = {
    prepare(sql: string) {
      return { bind(...params: unknown[]) {
        const statement = db.prepare(sql);
        return {
          async first() { return statement.get(...params) ?? null; },
          async all() { return { results: statement.all(...params) }; },
          async run() { const r = statement.run(...params); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
        };
      } };
    },
    async batch(statements: { run: () => Promise<unknown> }[]) {
      db.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        db.exec("COMMIT");
        return result;
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    },
  };
  const env = { DB: d1, AUTH_SECRET: secret };
  const request = async (method: string, path: string, body?: unknown, token?: { jwt: string; csrf: string }, headers: Record<string, string> = {}) => {
    const response = await app.request(path, { method, headers: { origin: "http://localhost", "content-type": "application/json",
      ...(token ? { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env);
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
  };
  return { db, request };
}

test("password hashes are salted, verify in Worker Web Crypto, JWT expires and rejects tampering", async () => {
  const a = await hashPassword("a long secret password");
  const b = await hashPassword("a long secret password");
  assert.notEqual(a, b);
  assert.match(a, /^pbkdf2-sha256\$600000\$/);
  const { verifyPassword } = await import("./auth.ts");
  assert.equal(await verifyPassword("a long secret password", a), true);
  assert.equal(await verifyPassword("wrong password", a), false);
  const token = await signToken(secret, 1, 0);
  assert.equal((await verifyToken(secret, token.jwt))?.sub, 1);
  const [head, payload, signature] = token.jwt.split(".");
  assert.equal(await verifyToken(secret, `${head}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`), null);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 9 * 60 * 60 * 1000;
    assert.equal(await verifyToken(secret, token.jwt), null, "expired cookie is rejected");
  } finally { Date.now = originalNow; }
});

test("login, CSRF, logout and DB revocation protect legacy routes", async (t) => {
  const { db, request } = await harness(t);
  db.exec("INSERT INTO companies (name, status) VALUES ('Legacy', 'active')");
  db.prepare("INSERT INTO users (email, password_hash, role, company_id) VALUES (?, ?, 'tenant', 1)")
    .run("owner@example.test", await hashPassword("owner secret password"));
  assert.equal((await request("GET", "/api/clients")).status, 401);
  assert.equal((await request("POST", "/api/auth/login", { email: "owner@example.test", password: "incorrect" })).status, 401);
  const login = await request("POST", "/api/auth/login", { email: "owner@example.test", password: "owner secret password" });
  assert.equal(login.status, 200);
  assert.match(login.cookie!, /HttpOnly/i);
  assert.match(login.cookie!, /Secure/i);
  assert.match(login.cookie!, /SameSite=Strict/i);
  const token = { jwt: login.cookie!.match(/__Host-youturno=([^;]+)/)![1], csrf: login.body.csrf };
  assert.equal((await request("GET", "/api/clients", undefined, token)).status, 200);
  assert.equal((await request("POST", "/api/clients", { name: "No CSRF" }, token, { "x-csrf-token": "" })).status, 403);
  assert.equal((await request("POST", "/api/clients", { name: "Wrong origin" }, token, { origin: "https://evil.example" })).status, 403);
  assert.equal((await request("POST", "/api/clients", { name: "Valid" }, token)).status, 201);
  assert.equal((await request("POST", "/api/auth/logout", {}, token)).status, 200);
  assert.equal((await request("GET", "/api/clients", undefined, token)).status, 401);
});

test("wrong passwords are throttled without creating a session", async (t) => {
  const { db, request } = await harness(t);
  db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'superadmin')")
    .run("admin@example.test", await hashPassword("admin secret password"));
  for (let i = 0; i < 5; i++) {
    assert.equal((await request("POST", "/api/auth/login", { email: "ADMIN@example.test", password: "wrong" })).status, 401);
  }
  assert.equal((await request("POST", "/api/auth/login", { email: "admin@example.test", password: "admin secret password" })).status, 429);
  assert.equal(db.prepare("SELECT failures FROM login_attempts WHERE email = 'admin@example.test'").get()?.failures, 5);
});

test("superadmin provisions the first user for a second company and controls activation", async (t) => {
  const { db, request } = await harness(t);
  db.exec("INSERT INTO companies (name, status) VALUES ('Legacy', 'active')");
  db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'superadmin')")
    .run("admin@example.test", await hashPassword("admin secret password"));
  const admin = await signToken(secret, 1, 0);
  assert.equal((await request("GET", "/api/clients", undefined, admin)).status, 403);
  assert.equal((await request("GET", "/api/admin/companies", undefined, admin)).status, 200);
  const first = await request("POST", "/api/admin/users", { email: "new@example.test", password: "new tenant password" }, admin);
  assert.equal(first.status, 201);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM companies").get()?.total, 1);
  const firstToken = await signToken(secret, first.body.id, 0);
  assert.equal((await request("GET", "/api/clients", undefined, firstToken)).status, 403);
  assert.equal((await request("POST", "/api/onboarding/company", { name: "Second company" }, firstToken)).status, 201);
  assert.equal(db.prepare("SELECT status FROM companies WHERE id = 2").get()?.status, "pending");
  assert.equal((await request("GET", "/api/clients", undefined, firstToken)).status, 403);
  assert.equal((await request("PUT", "/api/admin/companies/2/status", { status: "active" }, admin)).status, 200);
  assert.equal((await request("GET", "/api/clients", undefined, firstToken)).status, 200);
  assert.equal((await request("GET", "/api/clients", undefined, admin)).status, 403);
  const existing = await request("POST", "/api/admin/users", { email: "legacy@example.test", password: "additional password", company_id: 1 }, admin);
  assert.equal(existing.status, 201);
  const tenant = await signToken(secret, existing.body.id, 0);
  assert.equal((await request("POST", "/api/admin/users", { email: "no@example.test", password: "new tenant password" }, tenant)).status, 403);
  assert.equal((await request("POST", "/api/onboarding/company", { name: "New company" }, tenant)).status, 403);
  assert.equal((await request("GET", "/api/clients", undefined, tenant)).status, 200);
  const extra = { email: "extra@example.test", password: "additional password", company_id: 1 };
  assert.equal((await request("POST", "/api/admin/users", extra, admin)).status, 403);
  assert.equal((await request("POST", "/api/admin/users", { ...extra, agreement_confirmed: true }, admin)).status, 201);
  assert.equal((await request("PUT", "/api/admin/companies/1/status", { status: "disabled" }, admin)).status, 200);
  assert.equal((await request("GET", "/api/clients", undefined, tenant)).status, 403, "status checked each request");
  assert.equal((await request("GET", "/api/admin/companies", undefined, admin)).status, 200);
  assert.equal((await request("PUT", "/api/admin/companies/1/status", { status: "active" }, admin)).status, 200);
  assert.equal((await request("GET", "/api/clients", undefined, tenant)).status, 200, "reactivation is read from DB");
});

test("first tenant creates pending company atomically on an empty installation", async (t) => {
  const { db, request } = await harness(t);
  db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'superadmin')")
    .run("admin@example.test", await hashPassword("admin secret password"));
  const admin = await signToken(secret, 1, 0);
  const created = await request("POST", "/api/admin/users", { email: "first@example.test", password: "first user password" }, admin);
  assert.equal(created.status, 201);
  const first = await signToken(secret, created.body.id, 0);
  assert.equal((await request("POST", "/api/onboarding/company", { name: "My business" }, first)).status, 201);
  assert.equal(db.prepare("SELECT name, status FROM companies").get()?.status, "pending");
  assert.equal(db.prepare("SELECT user_id FROM company_onboarding").get()?.user_id, created.body.id);
  assert.equal(db.prepare("SELECT company_id FROM users WHERE id = ?").get(created.body.id)?.company_id, 1);
  assert.equal((await request("POST", "/api/onboarding/company", { name: "Again" }, first)).status, 403);
  assert.equal((await request("GET", "/api/stats", undefined, first)).status, 403);
  assert.equal((await request("PUT", "/api/admin/companies/1/status", { status: "active" }, admin)).status, 200);
  assert.equal((await request("GET", "/api/stats", undefined, first)).status, 200);
});

test("unmigrated business rows cannot be claimed by first-user onboarding", async (t) => {
  const { db, request } = await harness(t);
  db.exec("INSERT INTO clients (name) VALUES ('Unmigrated client')");
  db.exec("INSERT INTO users (email, password_hash, role) VALUES ('first@example.test', 'test-only', 'tenant')");
  const first = await signToken(secret, 1, 0);
  assert.equal((await request("POST", "/api/onboarding/company", { name: "New company" }, first)).status, 503);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM companies").get()?.count, 0);
  db.exec(readFileSync(new URL("./migrate-legacy.sql", import.meta.url), "utf8"));
  assert.equal(db.prepare("SELECT company_id FROM tenant_ownership WHERE resource_type = 'clients'").get()?.company_id, 1);
  assert.equal((await request("POST", "/api/onboarding/company", { name: "Second company" }, first)).status, 201);
});

test("two companies cannot see, link, mutate, cascade-delete or conflict with each other's records", async (t) => {
  const { db, request } = await harness(t);
  db.exec(`
    INSERT INTO clients (id, name) VALUES (1, 'Legacy customer');
    INSERT INTO staff (id, name) VALUES (1, 'Legacy stylist');
    INSERT INTO services (id, name, price) VALUES (1, 'Legacy haircut', 40);
    INSERT INTO products (id, name) VALUES (1, 'Legacy product');
  `);
  db.exec(readFileSync(new URL("./migrate-legacy.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO companies (name, status) VALUES ('Second company', 'active')");
  db.exec("INSERT INTO users (email, password_hash, role, company_id) VALUES ('a@example.test', 'test-only', 'tenant', 1), ('b@example.test', 'test-only', 'tenant', 2)");
  const a = await signToken(secret, 1, 0);
  const b = await signToken(secret, 2, 0);
  const callA = (method: string, path: string, body?: unknown) => request(method, path, body, a);
  const callB = (method: string, path: string, body?: unknown) => request(method, path, body, b);

  const clientB = (await callB("POST", "/api/clients", { name: "Second customer" })).body.client.id;
  const staffB = (await callB("POST", "/api/staff", { name: "Second stylist" })).body.staff.id;
  const serviceB = (await callB("POST", "/api/services", { name: "Second service", duration: 60, price: 20 })).body.service.id;
  const productB = (await callB("POST", "/api/products", { name: "Second product" })).body.product.id;
  db.exec("INSERT INTO products (id, name) VALUES (999, 'Unowned product')");
  const booking = (client_id: number, staff_id: number, service_ids: number[]) => ({
    client_id, staff_id, service_ids, scheduled_date: "2026-09-14", start_time: "10:00",
  });
  const appointmentA = (await callA("POST", "/api/appointments", booking(1, 1, [1]))).body.appointment;
  const appointmentB = (await callB("POST", "/api/appointments", booking(clientB, staffB, [serviceB]))).body.appointment;
  assert.equal((await callA("POST", `/api/appointments/${appointmentA.id}/notes`, { content: "Legacy note" })).status, 201);
  const noteA = db.prepare("SELECT id FROM appointment_notes WHERE appointment_id = ?").get(appointmentA.id)!.id;
  assert.notEqual(appointmentA.identifier, appointmentB.identifier, "counter is globally unique");
  assert.equal((await callB("POST", "/api/blocked-slots", { staff_id: staffB, blocked_date: "2026-09-14", start_time: "12:00", end_time: "13:00" })).status, 201);
  const blockB = db.prepare("SELECT id FROM blocked_slots WHERE staff_id = ?").get(staffB)!.id;
  assert.equal((await callB("POST", `/api/appointments/${appointmentB.id}/notes`, { content: "Second company's note" })).status, 201);
  const noteB = db.prepare("SELECT id FROM appointment_notes WHERE appointment_id = ?").get(appointmentB.id)!.id;
  for (const type of ["clients", "staff", "services", "appointments", "appointment_services", "appointment_notes", "blocked_slots", "products"]) {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_ownership WHERE resource_type = ? AND company_id = 2").get(type)?.count, 1,
      `new ${type} must be owned within its write transaction`);
  }

  assert.deepEqual((await callA("GET", "/api/clients/all")).body.clients.map((row: { id: number }) => row.id), [1]);
  assert.deepEqual((await callB("GET", "/api/staff/all")).body.staff.map((row: { id: number }) => row.id), [staffB]);
  assert.deepEqual((await callA("GET", "/api/services")).body.services.map((row: { id: number }) => row.id), [1]);
  assert.deepEqual((await callA("GET", "/api/products")).body.products.map((row: { id: number }) => row.id), [1]);
  assert.equal((await callB("GET", "/api/products")).body.total, 1, "unowned rows stay invisible");
  assert.equal((await callA("PUT", "/api/products/999", { name: "Claimed" })).status, 404);
  assert.deepEqual((await callA("GET", "/api/appointments")).body.appointments.map((row: { id: number }) => row.id), [appointmentA.id]);
  assert.equal((await callA("GET", "/api/clients?search=Second")).body.total, 0);
  assert.equal((await callA("GET", "/api/products?search=Second")).body.total, 0);
  assert.equal((await callA("GET", `/api/appointments?search=${appointmentB.identifier}`)).body.total, 0);
  assert.equal((await callB("GET", "/api/stats")).body.clients, 1);
  assert.equal((await callB("GET", "/api/stats")).body.revenue, 0);
  assert.equal((await callB("PUT", `/api/appointments/${appointmentB.id}`, { status: "completed", total_price: 125 })).status, 200);
  assert.equal((await callB("GET", "/api/stats")).body.revenue, 125);
  assert.equal((await callA("GET", "/api/stats")).body.revenue, 0);
  const calendarA = (await callA("GET", "/api/calendar?start=2026-09-14&end=2026-09-14")).body;
  assert.deepEqual(calendarA.appointments.map((row: { id: number }) => row.id), [appointmentA.id]);
  assert.equal(calendarA.blocked_slots.length, 0);
  assert.equal((await callA("GET", "/api/clients/1")).body.appointments[0].client_id, 1);
  assert.equal((await callA("GET", "/api/staff")).body.staff[0].appointment_count, 1);
  assert.equal((await callA("GET", `/api/appointments/${appointmentA.id}`)).body.appointment.appointment_notes[0].content, "Legacy note");
  assert.equal((await callA("GET", `/api/clients/1`)).body.appointments[0].latest_note, "Legacy note");
  for (const [method, path, body] of [
    ["GET", `/api/clients/${clientB}`], ["PUT", `/api/clients/${clientB}`, { name: "Stolen" }], ["DELETE", `/api/clients/${clientB}`],
    ["PUT", `/api/staff/${staffB}`, { name: "Stolen" }], ["DELETE", `/api/staff/${staffB}`],
    ["PUT", `/api/services/${serviceB}`, { name: "Stolen" }], ["DELETE", `/api/services/${serviceB}`],
    ["PUT", `/api/products/${productB}`, { name: "Stolen" }], ["DELETE", `/api/products/${productB}`],
    ["GET", `/api/appointments/${appointmentB.id}`], ["PUT", `/api/appointments/${appointmentB.id}`, { notes: "Stolen" }],
    ["DELETE", `/api/appointments/${appointmentB.id}`],
    ["POST", `/api/appointments/${appointmentB.id}/notes`, { content: "Stolen" }],
    ["DELETE", `/api/notes/${noteB}`], ["DELETE", `/api/blocked-slots/${blockB}`],
  ] as const) {
    assert.equal((await callA(method, path, body)).status, 404, `${method} ${path}`);
  }
  assert.equal((await callA("POST", "/api/appointments", booking(clientB, 1, [1]))).status, 400);
  assert.equal((await callA("POST", "/api/appointments", booking(1, staffB, [1]))).status, 400);
  assert.equal((await callA("POST", "/api/appointments", booking(1, 1, [serviceB]))).status, 400);
  assert.equal((await callA("PUT", `/api/appointments/${appointmentA.id}`, { client_id: clientB })).status, 400);
  assert.equal((await callA("PUT", `/api/appointments/${appointmentA.id}`, { staff_id: staffB })).status, 400);
  assert.equal((await callA("POST", "/api/blocked-slots", { staff_id: staffB, blocked_date: "2026-09-14", start_time: "14:00", end_time: "15:00" })).status, 400);
  assert.throws(() => db.prepare("UPDATE appointments SET client_id = ? WHERE id = ?").run(clientB, appointmentA.id),
    /appointment client must belong to company/, "DB trigger rejects cross-company links outside the API");
  assert.throws(() => db.prepare("UPDATE appointments SET staff_id = ? WHERE id = ?").run(staffB, appointmentA.id),
    /appointment staff must belong to company/);
  const linkB = db.prepare("SELECT id FROM appointment_services WHERE appointment_id = ?").get(appointmentB.id)!.id;
  assert.throws(() => db.prepare("UPDATE appointment_services SET service_id = 1 WHERE id = ?").run(linkB),
    /appointment service must belong to company/);
  assert.throws(() => db.prepare("UPDATE appointment_notes SET appointment_id = ? WHERE id = ?").run(appointmentA.id, noteB),
    /appointment note must belong to company/);
  assert.throws(() => db.prepare("UPDATE blocked_slots SET staff_id = 1 WHERE id = ?").run(blockB),
    /blocked slot staff must belong to company/);
  // A's occupied staff and B's blocked time must not affect B's different staff.
  assert.equal((await callB("POST", "/api/appointments", { ...booking(clientB, staffB, [serviceB]), start_time: "12:00" })).status, 409);
  assert.equal((await callB("POST", "/api/appointments", { ...booking(clientB, staffB, [serviceB]), start_time: "14:00" })).status, 201);

  assert.equal((await callA("DELETE", "/api/clients/1")).status, 200);
  assert.equal((await callB("GET", `/api/appointments/${appointmentB.id}`)).status, 200);
  assert.equal((await callB("GET", `/api/clients/${clientB}`)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_ownership WHERE resource_type = 'appointments' AND resource_id = ?").get(appointmentA.id)?.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_ownership WHERE resource_type = 'appointment_notes' AND resource_id = ?").get(noteA)?.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_ownership WHERE resource_type = 'appointment_notes' AND resource_id = ?").get(noteB)?.count, 1);
});
