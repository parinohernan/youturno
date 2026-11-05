import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { after, before, mock, test } from "node:test";
import { signCustomerToken, signToken, verifyCustomerState } from "./auth.ts";
import { publicStarts, type SchedulingMode } from "./scheduling.ts";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const secret = "test-secret-for-JWT-at-least-32-characters";
let bundle: string;
let scenario = 0;
before(async () => {
  // Keep fixed booking fixtures in the future regardless of the machine's date.
  mock.timers.enable({ apis: ["Date"], now: new Date("2037-11-01T12:00:00Z") });
  const result = await build({ entryPoints: [new URL("./index.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false });
  bundle = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
});
after(() => mock.timers.reset());

type Request = (method: string, path: string, options?: {
  body?: unknown; headers?: Record<string, string>; env?: Record<string, string>;
}) => Promise<{ status: number; body: any; location: string | null; cookies: string[] }>;

async function harness(t: { after: (fn: () => void) => void }) {
  const { default: app } = await import(`${bundle}#${scenario++}`);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  let batchTail = Promise.resolve();
  let beforeBatch: (() => void) | null = null;
  const beforeNextBatch = (action: () => void) => { beforeBatch = action; };
  const metrics = { admissionConflicts: 0 };
  let barrier: { remaining: number; wait: Promise<void>; release: () => void } | null = null;
  const synchronizeBatches = (count: number) => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    barrier = { remaining: count, wait, release };
  };
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
      // Let both HTTP requests finish their stale reads before either writes.
      if (barrier) {
        if (--barrier.remaining === 0) barrier.release();
        await barrier.wait;
      }
      const previous = batchTail;
      let release!: () => void;
      batchTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      if (beforeBatch) { const action = beforeBatch; beforeBatch = null; action(); }
      db.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        if (String(err).includes("public booking conflict")) metrics.admissionConflicts++;
        throw err;
      }
      finally { release(); }
    },
  };
  const request = async (method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; env?: Record<string, string> } = {}) => {
    const environment = { DB: d1, AUTH_SECRET: secret, ...options.env };
    const response = await app.request(path, { method,
      headers: { origin: "http://localhost", "content-type": "application/json", ...options.headers },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }, environment);
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = text; }
    const acknowledge = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    return { status: response.status, body, location: response.headers.get("location"),
      cookies: acknowledge ? acknowledge.call(response.headers) : [response.headers.get("set-cookie") ?? ""].filter(Boolean) };
  };
  return { db, request, metrics, synchronizeBatches, beforeNextBatch };
}

/** Value a browser would have been given in one of the `cookie` responses. */
const cookieValue = (cookies: string[], name: string): string =>
  cookies.find((value) => value.startsWith(`${name}=`))!.match(new RegExp(`${name}=([^;]+)`) )![1];

/** A customer session the client sends directly, as a browser would. */
const bookingCookie = async (email = "client@example.test", name = "Client Name") =>
  `yt_book=${await signCustomerToken(secret, { sub: "google-1", email, name })}`;

/** Two tenants: Acme (bookable, two staff) and Beauty (never visible through Acme's routes). */
async function twoCompanies(t: Parameters<typeof harness>[0]) {
  const { db, request, metrics, synchronizeBatches, beforeNextBatch } = await harness(t);
  db.exec(`
    INSERT INTO companies (id, name, slug, status) VALUES (1, 'Acme', 'acme', 'active');
    INSERT INTO companies (id, name, slug, status) VALUES (2, 'Beauty', 'beauty', 'active');
    INSERT INTO services (id, name, duration, price, active) VALUES (1, 'Acme haircut', 60, 40, 1);
    INSERT INTO services (id, name, duration, price, active) VALUES (2, 'Retired dye', 90, 80, 0);
    INSERT INTO services (id, name, duration, price, active) VALUES (3, 'Beauty facial', 120, 120, 1);
    INSERT INTO staff (id, name, color, title, active) VALUES (1, 'Ana', '#111111', 'Senior', 1);
    INSERT INTO staff (id, name, color, title, active) VALUES (2, 'Ben', '#222222', 'Jr', 1);
    INSERT INTO staff (id, name, color, title, active) VALUES (3, 'Zoe', '#333333', 'Facial', 1);
    INSERT INTO staff (id, name, active) VALUES (4, 'Yesterday', 0);
  `);
  const own = (type: string, id: number, companyId: number) =>
    db.prepare("INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES (?, ?, ?)").run(type, id, companyId);
  own("services", 1, 1);
  own("services", 2, 1);
  own("services", 3, 2);
  own("staff", 1, 1);
  own("staff", 2, 1);
  own("staff", 4, 1);
  own("staff", 3, 2);
  // Booking fixtures explicitly configure qualifications; production migration does not.
  db.exec("INSERT INTO staff_services (company_id, staff_id, service_id) VALUES (1, 1, 1), (1, 2, 1), (2, 3, 3)");
  return { db, request: request as Request, metrics, synchronizeBatches, beforeNextBatch };
}

// 2037-11-02 is a Monday; far-future fixtures also satisfy SQLite's real clock.
const MONDAY = "2037-11-02";
const SUNDAY = "2037-11-08";

/** Attach a business row the tests created directly to company 1. */
const ownCompany1 = (db: DatabaseSync, type: string, id: number) =>
  db.prepare("INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES (?, ?, 1)").run(type, id);

test("public contact phone is required, unverified, normalized and private to the booked company", async (t) => {
  const { db, request } = await twoCompanies(t);
  const headers = { cookie: await bookingCookie() };
  const base = { service_id: 1, staff_id: 1, date: MONDAY, start_time: "10:00" };
  for (const value of [undefined, null, "", "123", "+", "++541155550100", "555 abc 123456", "1".repeat(16), "<script>", 123456789]) {
    const response = await request("POST", "/api/public/acme/book", { headers, body: { ...base, contact_phone: value } });
    assert.equal(response.status, 400, String(value));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients").get()?.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM appointments").get()?.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tenant_ownership WHERE resource_type = 'clients'").get()?.n, 0);
  }
  const book = (slug: string, body: unknown) => request("POST", `/api/public/${slug}/book`, { headers, body });
  assert.equal((await book("acme", { ...base, contact_phone: "+54 (11) 5555-0100" })).status, 201);
  assert.equal(db.prepare("SELECT phone FROM clients").get()?.phone, "+541155550100");
  assert.equal((await book("acme", { ...base, start_time: "11:00", contact_phone: "020 1234 5678" })).status, 201);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients").get()?.n, 1);
  assert.equal(db.prepare("SELECT phone FROM clients").get()?.phone, "02012345678", "authenticated customer explicitly replaces this company's contact");
  assert.equal((await book("beauty", { ...base, service_id: 3, staff_id: 3, contact_phone: "+442012345678" })).status, 201);
  assert.equal(db.prepare("SELECT phone FROM clients WHERE id = 1").get()?.phone, "02012345678");
  const publicData = JSON.stringify((await request("GET", "/api/public/acme/overview")).body);
  assert.ok(!publicData.includes("02012345678"));
  assert.ok(!publicData.includes("client@example.test"));
  assert.equal((await book("acme", { ...base, contact_phone: "+33123456789" })).status, 409);
  assert.equal(db.prepare("SELECT phone FROM clients WHERE id = 1").get()?.phone, "02012345678", "conflict cannot partially update contact");
});

test("concurrent bookings for the same customer reuse one company client atomically", async (t) => {
  const { db, request, synchronizeBatches } = await twoCompanies(t);
  const headers = { cookie: await bookingCookie() };
  synchronizeBatches(2);
  const result = await Promise.all(["10:00", "12:00"].map((start_time) => request("POST", "/api/public/acme/book", {
    headers, body: { service_id: 1, staff_id: 1, date: MONDAY, start_time, contact_phone: "+541155550100" } })));
  assert.deepEqual(result.map((r) => r.status), [201, 201]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients").get()?.n, 1);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT client_id) AS n FROM appointments").get()?.n, 1);
});

async function professionalFixture(t: Parameters<typeof harness>[0]) {
  const setup = await twoCompanies(t);
  const { db } = setup;
  db.exec(`INSERT INTO users (id, email, password_hash, role, company_id) VALUES
    (1, 'professional@example.test', 'test', 'tenant', 1), (2, 'owner@example.test', 'test', 'tenant', 1),
    (3, 'platform@example.test', 'test', 'superadmin', NULL);
    INSERT INTO professional_accounts VALUES (1, 1, 1);
    INSERT INTO clients (id, name, email, phone) VALUES (1, 'Own customer', 'own@example.test', '+541155550100'),
      (2, 'Other customer', 'other@example.test', '+541155550200');
    INSERT INTO tenant_ownership VALUES ('clients', 1, 1), ('clients', 2, 1);
    INSERT INTO appointments (id, identifier, client_id, staff_id, status, scheduled_date, start_time, end_time) VALUES
      (1, 'APT-1', 1, 1, 'confirmed', '${MONDAY}', '10:00', '11:00'),
      (2, 'APT-2', 2, 2, 'confirmed', '${MONDAY}', '12:00', '13:00');
    INSERT INTO tenant_ownership VALUES ('appointments', 1, 1), ('appointments', 2, 1);
    INSERT INTO appointment_services (id, appointment_id, service_id, duration, price) VALUES (1, 1, 1, 60, 40);
    INSERT INTO tenant_ownership VALUES ('appointment_services', 1, 1);`);
  db.exec(`INSERT INTO clients (id, name, email, phone) VALUES (3, 'Cross-company customer', 'private@example.test', '+442012345678');
    INSERT INTO tenant_ownership VALUES ('clients', 3, 2);
    INSERT INTO appointments (id, identifier, client_id, staff_id, status, scheduled_date, start_time, end_time)
      VALUES (3, 'APT-3', 3, 3, 'confirmed', '${MONDAY}', '10:00', '12:00');
    INSERT INTO tenant_ownership VALUES ('appointments', 3, 2);`);
  const token = await signToken(secret, 1, 0);
  const headers = { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf };
  const expected = () => ({ ...db.prepare("SELECT status, scheduled_date, start_time, end_time FROM appointments WHERE id = 1").get() });
  const action = (body: Record<string, unknown>, id = 1, extraHeaders = {}) => setup.request("POST", `/api/professional/appointments/${id}/actions`,
    { headers: { ...headers, ...extraHeaders }, body: { expected: expected(), ...body } });
  return { ...setup, token, headers, expected, action };
}

test("professional sessions expose only own agenda and deny every tenant-wide route", async (t) => {
  const { db, request, headers } = await professionalFixture(t);
  const session = await request("GET", "/api/auth/session", { headers });
  assert.equal(session.body.role, "professional"); assert.equal(session.body.staff_id, 1);
  const agenda = await request("GET", `/api/professional/agenda?date=${MONDAY}&staff_id=2&company_id=2`, { headers });
  assert.equal(agenda.status, 200);
  assert.deepEqual(agenda.body.appointments.map((row: any) => row.id), [1]);
  assert.deepEqual(agenda.body.staff.effective_hours.mon, [["09:00", "18:00"]]);
  assert.equal(agenda.body.new_booking_ids.length, 0, "initial load is not a new booking alert");
  assert.ok(!JSON.stringify(agenda.body).includes("other@example.test"));
  const detail = await request("GET", "/api/professional/appointments/1", { headers });
  assert.equal(detail.body.appointment.client_phone, "+541155550100");
  assert.equal(detail.body.appointment.services[0].service_name, "Acme haircut");
  assert.equal(detail.body.appointment.client_id, undefined, "no client-history selector is exposed");
  for (const id of [2, 3, 999]) assert.equal((await request("GET", `/api/professional/appointments/${id}`, { headers })).status, 404);
  for (const path of ["/api/stats", "/api/calendar?start=2037-11-02&end=2037-11-03", "/api/clients", "/api/clients/1",
    "/api/staff", "/api/staff/all", "/api/services", "/api/products", "/api/appointments", "/api/appointments/1",
    "/api/company/profile", "/api/company/booking", "/api/company/appearance", "/api/admin/companies", "/api/admin/users", "/api/onboarding/company"]) {
    assert.equal((await request("GET", path, { headers })).status, 403, path);
    assert.equal((await request("PUT", path, { headers, body: { name: "Forbidden", staff_id: 2, role: "tenant" } })).status, 403, path);
  }
  const owner = await signToken(secret, 2, 0);
  assert.equal((await request("GET", `/api/professional/agenda?date=${MONDAY}`, { headers: { cookie: `__Host-youturno=${owner.jwt}` } })).status, 403);
  db.exec("UPDATE appointments SET staff_id = 2 WHERE id = 1");
  assert.equal((await request("GET", "/api/professional/appointments/1", { headers })).status, 404);
});

test("professional membership denies inactive, moved, deleted and revoked bindings without elevation", async (t) => {
  const { db, request, headers } = await professionalFixture(t);
  const read = () => request("GET", "/api/auth/session", { headers });
  for (const [change, restore] of [
    ["UPDATE staff SET active = 0 WHERE id = 1", "UPDATE staff SET active = 1 WHERE id = 1"],
    ["UPDATE companies SET status = 'disabled' WHERE id = 1", "UPDATE companies SET status = 'active' WHERE id = 1"],
    ["UPDATE users SET company_id = 2 WHERE id = 1", "UPDATE users SET company_id = 1 WHERE id = 1"],
    ["DELETE FROM tenant_ownership WHERE resource_type = 'staff' AND resource_id = 1", "INSERT INTO tenant_ownership VALUES ('staff', 1, 1)"],
  ]) { db.exec(change); assert.equal((await read()).status, 403, change); db.exec(restore); assert.equal((await read()).status, 200); }
  assert.throws(() => db.exec("UPDATE professional_accounts SET staff_id = 3 WHERE user_id = 1"), /invalid professional binding/);
  assert.equal((await request("POST", "/api/auth/logout", { headers, body: {} })).status, 200);
  assert.equal((await read()).status, 401);
  db.exec("UPDATE users SET session_version = 0 WHERE id = 1; DELETE FROM staff WHERE id = 1");
  assert.equal(db.prepare("SELECT staff_id FROM professional_accounts WHERE user_id = 1").get()?.staff_id, null);
  assert.equal((await read()).status, 403);
});

test("only company admin provisions own professional access; platform staff_id provisioning is rejected", async (t) => {
  const { db, request, headers } = await professionalFixture(t);
  const admin = await signToken(secret, 3, 0);
  const adminHeaders = { cookie: `__Host-youturno=${admin.jwt}`, "x-csrf-token": admin.csrf };
  const body = { email: "new@example.test", password: "fictional test password", company_id: 1, staff_id: 2, agreement_confirmed: true };
  assert.equal((await request("POST", "/api/admin/users", { headers, body })).status, 403);
  const owner = await signToken(secret, 2, 0);
  assert.equal((await request("POST", "/api/admin/users", { headers: { cookie: `__Host-youturno=${owner.jwt}`, "x-csrf-token": owner.csrf }, body })).status, 403);
  for (const invalid of [{ ...body, staff_id: 3 }, { ...body, staff_id: 4 }, { ...body, company_id: null }, { ...body, role: "superadmin" }]) {
    assert.equal((await request("POST", "/api/admin/users", { headers: adminHeaders, body: invalid })).status, 400);
  }
  assert.equal((await request("POST", "/api/admin/users", { headers: adminHeaders, body })).status, 400);
  const ownerHeaders = { cookie: `__Host-youturno=${owner.jwt}`, "x-csrf-token": owner.csrf };
  const access = { email: body.email, professional_password: body.password };
  assert.equal((await request("PUT", "/api/staff/2", { headers, body: access })).status, 403);
  assert.equal((await request("PUT", "/api/staff/2", { headers: adminHeaders, body: access })).status, 403);
  assert.equal((await request("PUT", "/api/staff/3", { headers: ownerHeaders, body: access })).status, 404);
  assert.equal((await request("PUT", "/api/staff/4", { headers: ownerHeaders, body: access })).status, 400);
  const created = await request("PUT", "/api/staff/2", { headers: ownerHeaders, body: access });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body, { ok: true });
  const login = await request("POST", "/api/auth/login", { body: { email: body.email, password: body.password } });
  assert.equal(login.status, 200);
  const current = await request("GET", "/api/auth/session", { headers: { cookie: `__Host-youturno=${cookieValue(login.cookies, "__Host-youturno")}` } });
  assert.equal(current.body.role, "professional"); assert.equal(current.body.staff_id, 2);
  const ownAgenda = await request("GET", `/api/professional/agenda?date=${MONDAY}`, { headers: { cookie: `__Host-youturno=${cookieValue(login.cookies, "__Host-youturno")}` } });
  assert.equal(ownAgenda.status, 200);
  assert.deepEqual(ownAgenda.body.appointments.map((row: any) => row.id), [2]);
  assert.equal((await request("GET", "/api/clients", { headers: { cookie: `__Host-youturno=${cookieValue(login.cookies, "__Host-youturno")}` } })).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM professional_accounts WHERE staff_id = 2").get()?.n, 1);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("professional resets revoke only their sessions; blank preserves and email edits sync safely", async (t) => {
  const { db, request } = await professionalFixture(t);
  const owner = await signToken(secret, 2, 0);
  const headers = { cookie: `__Host-youturno=${owner.jwt}`, "x-csrf-token": owner.csrf };
  const save = (body: unknown) => request("PUT", "/api/staff/2", { headers, body });
  const login = (email: string, password: string) => request("POST", "/api/auth/login", { body: { email, password, professional_portal: true } });
  assert.equal((await save({ email: " Professional.New@Example.test ", professional_password: "fictional initial password" })).status, 200);
  const first = await login("professional.new@example.test", "fictional initial password");
  assert.equal(first.status, 200);
  const firstHeaders = { cookie: `__Host-youturno=${cookieValue(first.cookies, "__Host-youturno")}` };
  const uid = db.prepare("SELECT user_id FROM professional_accounts WHERE staff_id = 2").get()!.user_id;
  const original = db.prepare("SELECT password_hash, session_version FROM users WHERE id = ?").get(uid);
  assert.equal((await save({ name: "Updated professional", professional_password: "" })).status, 200);
  assert.deepEqual(db.prepare("SELECT password_hash, session_version FROM users WHERE id = ?").get(uid), original);
  assert.equal((await request("GET", "/api/auth/session", { headers: firstHeaders })).status, 200);
  const tooShort = await save({ professional_password: "short-only" });
  assert.equal(tooShort.status, 400);
  assert.ok(!JSON.stringify(tooShort.body).includes("short-only"));
  assert.equal((await save({ professional_password: "fictional replacement password" })).status, 200);
  assert.equal((await login("professional.new@example.test", "fictional initial password")).status, 401);
  assert.equal((await request("GET", "/api/auth/session", { headers: firstHeaders })).status, 401);
  assert.equal((await request("GET", "/api/auth/session", { headers })).status, 200);
  const second = await login("professional.new@example.test", "fictional replacement password");
  assert.equal(second.status, 200);
  const secondHeaders = { cookie: `__Host-youturno=${cookieValue(second.cookies, "__Host-youturno")}` };
  assert.equal((await save({ email: " Renamed@Example.test " })).status, 200);
  assert.equal(db.prepare("SELECT email FROM users WHERE id = ?").get(uid)?.email, "renamed@example.test");
  assert.equal(db.prepare("SELECT email FROM staff WHERE id = 2").get()?.email, "renamed@example.test");
  assert.equal((await request("GET", "/api/auth/session", { headers: secondHeaders })).status, 401);
  assert.equal((await login("professional.new@example.test", "fictional replacement password")).status, 401);
  assert.equal((await login("renamed@example.test", "fictional replacement password")).status, 200);
  for (const email of ["", "invalid", "owner@example.test", "platform@example.test", "professional@example.test"]) {
    const result = await save({ email, name: "Must not persist", professional_password: "fictional rejected password" });
    assert.equal(result.status, ["", "invalid"].includes(email) ? 400 : 409);
    assert.ok(!JSON.stringify(result.body).includes("fictional rejected password"));
    assert.equal(db.prepare("SELECT name FROM staff WHERE id = 2").get()?.name, "Updated professional");
    assert.equal(db.prepare("SELECT email FROM users WHERE id = ?").get(uid)?.email, "renamed@example.test");
  }
  const listing = await request("GET", "/api/staff", { headers });
  for (const email of ["", "owner@example.test", "professional@example.test"]) {
    assert.equal((await save({ email })).status, email === "" ? 400 : 409, "ordinary staff edits enforce linked identity semantics");
    assert.equal(db.prepare("SELECT email FROM staff WHERE id = 2").get()?.email, "renamed@example.test");
  }
  assert.equal(listing.body.staff.find((s: any) => s.id === 2).access_enabled, 1);
  assert.ok(!JSON.stringify(listing.body).includes("password_hash"));
  const publicListing = await request("GET", "/api/public/acme/overview");
  assert.equal(publicListing.status, 200);
  assert.ok(!JSON.stringify(publicListing.body).includes("access_enabled"));
  assert.ok(!JSON.stringify(publicListing.body).includes("password_hash"));
  assert.equal((await save({ active: 0 })).status, 200);
  assert.equal((await login("renamed@example.test", "fictional replacement password")).status, 403);
  assert.equal((await save({ professional_password: "fictional inactive reset" })).status, 400);
  db.exec("UPDATE staff SET active = 1 WHERE id = 2; UPDATE companies SET status = 'disabled' WHERE id = 1");
  assert.equal((await login("renamed@example.test", "fictional replacement password")).status, 403);
  assert.equal((await save({ professional_password: "fictional inactive reset" })).status, 403);
});

test("new access rejects collisions without converting accounts and blank password never links by email", async (t) => {
  const { db, request } = await professionalFixture(t);
  db.exec("INSERT INTO users (id, email, password_hash, role, company_id) VALUES (4, 'cross@example.test', 'test', 'tenant', 2); INSERT INTO professional_accounts VALUES (4, 2, 3)");
  const owner = await signToken(secret, 2, 0);
  const headers = { cookie: `__Host-youturno=${owner.jwt}`, "x-csrf-token": owner.csrf };
  const before = db.prepare("SELECT * FROM users ORDER BY id").all();
  for (const email of ["owner@example.test", "PLATFORM@example.test", "professional@example.test", "cross@example.test"]) {
    assert.equal((await request("PUT", "/api/staff/2", { headers, body: { name: "Rejected", email, professional_password: "fictional collision password" } })).status, 409);
    assert.deepEqual(db.prepare("SELECT * FROM users ORDER BY id").all(), before);
    assert.equal(db.prepare("SELECT name FROM staff WHERE id = 2").get()?.name, "Ben");
  }
  assert.equal((await request("PUT", "/api/staff/2", { headers, body: { email: "owner@example.test", professional_password: "" } })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM professional_accounts WHERE staff_id = 2").get()?.n, 0);
  assert.deepEqual(db.prepare("SELECT * FROM users ORDER BY id").all(), before);
  assert.equal((await request("PUT", "/api/staff/2", { headers, body: { professional_password: "fictional collision password", role: "tenant" } })).status, 400);
});

test("access batches reject duplicate provisioning, stale authority and roll back staff or credential failures", async (t) => {
  const { db, request, beforeNextBatch, synchronizeBatches } = await professionalFixture(t);
  const owner = await signToken(secret, 2, 0);
  const headers = { cookie: `__Host-youturno=${owner.jwt}`, "x-csrf-token": owner.csrf };
  const save = (body: unknown) => request("PUT", "/api/staff/2", { headers, body });
  for (const [change, restore] of [
    ["UPDATE staff SET active = 0 WHERE id = 2", "UPDATE staff SET active = 1 WHERE id = 2"],
    ["UPDATE companies SET status = 'disabled' WHERE id = 1", "UPDATE companies SET status = 'active' WHERE id = 1"],
    ["UPDATE users SET session_version = 1 WHERE id = 2", "UPDATE users SET session_version = 0 WHERE id = 2"],
    ["DELETE FROM tenant_ownership WHERE resource_type = 'staff' AND resource_id = 2", "INSERT INTO tenant_ownership VALUES ('staff', 2, 1)"],
  ]) {
    beforeNextBatch(() => db.exec(change));
    assert.equal((await save({ name: "Rejected", email: "atomic@example.test", professional_password: "fictional atomic password" })).status, 409);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'atomic@example.test'").get()?.n, 0);
    assert.equal(db.prepare("SELECT name FROM staff WHERE id = 2").get()?.name, "Ben");
    db.exec(restore);
  }
  db.exec("CREATE TRIGGER fail_staff_edit BEFORE UPDATE ON staff WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'isolated failure'); END");
  assert.equal((await save({ name: "Rejected", email: "atomic@example.test", professional_password: "fictional atomic password" })).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'atomic@example.test'").get()?.n, 0);
  db.exec("DROP TRIGGER fail_staff_edit");
  synchronizeBatches(2);
  const concurrent = await Promise.all([save({ email: "atomic@example.test", professional_password: "fictional atomic password" }),
    save({ email: "other-atomic@example.test", professional_password: "fictional atomic password" })]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM professional_accounts WHERE staff_id = 2").get()?.n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email IN ('atomic@example.test', 'other-atomic@example.test')").get()?.n, 1);
  const snapshot = db.prepare("SELECT password_hash, session_version FROM users WHERE id = (SELECT user_id FROM professional_accounts WHERE staff_id = 2)").get();
  db.exec("CREATE TRIGGER fail_staff_edit BEFORE UPDATE ON staff WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'isolated failure'); END");
  assert.equal((await save({ name: "Rejected", professional_password: "fictional reset rollback" })).status, 409);
  assert.deepEqual(db.prepare("SELECT password_hash, session_version FROM users WHERE id = (SELECT user_id FROM professional_accounts WHERE staff_id = 2)").get(), snapshot);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("professional completion is not payment and cancellation requires manual contact, with terminal and duplicate actions denied", async (t) => {
  const { db, request, action, headers, expected } = await professionalFixture(t);
  assert.equal((await action({ action: "completed" }, 2)).status, 404);
  assert.equal((await action({ action: "completed" }, 3)).status, 404);
  assert.equal((await action({ action: "completed", staff_id: 2 })).status, 400);
  assert.equal((await action({ action: "completed" }, 1, { "x-csrf-token": "" })).status, 403);
  assert.equal((await action({ action: "cancelled" })).status, 400);
  // Legacy corrupt times never block an unrelated finalization.
  db.exec("UPDATE appointments SET start_time = 'legacy', end_time = 'legacy' WHERE id = 1");
  const before = expected();
  const complete = await action({ action: "completed" });
  assert.equal(complete.status, 200); assert.equal(complete.body.manual_contact_required, false);
  assert.equal(db.prepare("SELECT status FROM appointments WHERE id = 1").get()?.status, "completed");
  assert.equal((await action({ action: "completed", expected: before })).status, 409);
  assert.equal((await action({ action: "cancelled", manual_contact_acknowledged: true })).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM professional_appointment_changes").get()?.n, 1);
  db.exec("UPDATE appointments SET status = 'confirmed' WHERE id = 1");
  const cancel = await action({ action: "cancelled", manual_contact_acknowledged: true });
  assert.equal(cancel.status, 200); assert.equal(cancel.body.manual_contact_required, true);
  assert.match(cancel.body.message, /no se envió ningún mensaje/);
  const detail = await request("GET", "/api/professional/appointments/1", { headers });
  assert.equal(detail.body.appointment.status, "cancelled"); assert.equal(detail.body.appointment.client_phone, "+541155550100");
  assert.equal(detail.body.appointment.history.length, 2);
});

test("professional reschedule preserves real duration, excludes itself and uses full hours not public cadence", async (t) => {
  const { db, action, expected } = await professionalFixture(t);
  db.exec("UPDATE staff SET scheduling_mode = 'consecutive' WHERE id = 1");
  const old = expected();
  const moved = await action({ action: "reschedule", date: MONDAY, start_time: "10:17", manual_contact_acknowledged: true });
  assert.equal(moved.status, 200); assert.equal(moved.body.manual_contact_required, true);
  assert.deepEqual(expected(), { ...old, start_time: "10:17", end_time: "11:17" });
  assert.equal((await action({ action: "reschedule", date: MONDAY, start_time: "12:00", expected: old, manual_contact_acknowledged: true })).status, 409);
  assert.equal((await action({ action: "reschedule", date: SUNDAY, start_time: "12:00", manual_contact_acknowledged: true })).status, 409);
  assert.equal((await action({ action: "reschedule", date: MONDAY, start_time: "23:30", manual_contact_acknowledged: true })).status, 400);
  assert.equal((await action({ action: "reschedule", date: "2037-02-30", start_time: "12:00", manual_contact_acknowledged: true })).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM professional_appointment_changes").get()?.n, 1);
});

test("legacy bookings without service links remain manageable but cannot be rescheduled by a professional", async (t) => {
  const { db, action } = await professionalFixture(t);
  db.exec("DELETE FROM appointment_services WHERE appointment_id = 1");
  assert.equal((await action({ action: "reschedule", date: MONDAY, start_time: "12:00", manual_contact_acknowledged: true })).status, 409);
  assert.equal((await action({ action: "reschedule", date: MONDAY, start_time: "12:00", manual_contact_acknowledged: true, allow_conflict: true })).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM professional_appointment_changes").get()?.n, 0);
  assert.equal((await action({ action: "cancelled", manual_contact_acknowledged: true })).status, 200);
});

test("simultaneous duplicate completion creates exactly one terminal change and audit entry", async (t) => {
  const { db, action, synchronizeBatches } = await professionalFixture(t);
  synchronizeBatches(2);
  const results = await Promise.all([action({ action: "completed" }), action({ action: "completed" })]);
  assert.deepEqual(results.map((row) => row.status).sort(), [200, 409]);
  assert.equal(db.prepare("SELECT status FROM appointments WHERE id = 1").get()?.status, "completed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM professional_appointment_changes").get()?.n, 1);
});

for (const change of ["busy", "block", "company hours", "staff hours", "qualification", "inactive", "company disabled", "revoked", "reassigned", "status", "duration"]) {
  test(`professional reschedule atomically rechecks stale admission: ${change}`, async (t) => {
    const { db, action, beforeNextBatch, expected } = await professionalFixture(t);
    const old = expected();
    beforeNextBatch(() => {
      if (change === "busy") db.exec(`UPDATE appointments SET staff_id = 1 WHERE id = 2`);
      if (change === "block") db.exec(`INSERT INTO blocked_slots (id, staff_id, blocked_date, start_time, end_time) VALUES (1, 1, '${MONDAY}', '12:00', '13:00'); INSERT INTO tenant_ownership VALUES ('blocked_slots', 1, 1);`);
      if (change === "company hours") db.exec(`UPDATE companies SET business_hours = '{"mon":[["09:00","11:00"],["13:00","18:00"]]}' WHERE id = 1`);
      if (change === "staff hours") db.exec(`UPDATE staff SET working_hours = '{"mon":[]}' WHERE id = 1`);
      if (change === "qualification") db.exec("DELETE FROM staff_services WHERE staff_id = 1");
      if (change === "inactive") db.exec("UPDATE staff SET active = 0 WHERE id = 1");
      if (change === "company disabled") db.exec("UPDATE companies SET status = 'disabled' WHERE id = 1");
      if (change === "revoked") db.exec("UPDATE users SET session_version = 1 WHERE id = 1");
      if (change === "reassigned") db.exec("UPDATE appointments SET staff_id = 2 WHERE id = 1");
      if (change === "status") db.exec("UPDATE appointments SET status = 'completed' WHERE id = 1");
      if (change === "duration") db.exec("UPDATE appointments SET end_time = '11:30' WHERE id = 1");
    });
    assert.equal((await action({ action: "reschedule", date: MONDAY, start_time: "12:00", manual_contact_acknowledged: true })).status, 409);
    assert.deepEqual(expected(), { ...old, ...(change === "status" ? { status: "completed" } : {}), ...(change === "duration" ? { end_time: "11:30" } : {}) });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM professional_appointment_changes").get()?.n, 0);
  });
}

test("competing professional reschedules admit only one and alert cursors do not replay initial bookings", async (t) => {
  const { db, request, action, headers, synchronizeBatches } = await professionalFixture(t);
  db.exec(`UPDATE appointments SET staff_id = 1 WHERE id = 2;
    INSERT INTO appointment_services (id, appointment_id, service_id, duration, price) VALUES (2, 2, 1, 60, 40);
    INSERT INTO tenant_ownership VALUES ('appointment_services', 2, 1);`);
  const baseline = await request("GET", `/api/professional/agenda?date=${MONDAY}`, { headers });
  assert.deepEqual(baseline.body.new_booking_ids, []);
  const expected2 = { ...db.prepare("SELECT status, scheduled_date, start_time, end_time FROM appointments WHERE id = 2").get() };
  synchronizeBatches(2);
  const changes = await Promise.all([action({ action: "reschedule", date: MONDAY, start_time: "14:00", manual_contact_acknowledged: true }),
    action({ action: "reschedule", expected: expected2, date: MONDAY, start_time: "14:00", manual_contact_acknowledged: true }, 2)]);
  assert.deepEqual(changes.map((r) => r.status).sort(), [200, 409]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM professional_appointment_changes").get()?.n, 1);
  const booked = await request("POST", "/api/public/acme/book", { headers: { cookie: await bookingCookie() },
    body: { contact_phone: "+541155550100", service_id: 1, staff_id: 1, date: MONDAY, start_time: "16:00" } });
  assert.equal(booked.status, 201);
  const updates = await request("GET", `/api/professional/agenda?date=${MONDAY}&cursor=${baseline.body.cursor}`, { headers });
  assert.deepEqual(updates.body.new_booking_ids, [booked.body.appointment.id]);
  assert.deepEqual((await request("GET", `/api/professional/agenda?date=${MONDAY}&cursor=${updates.body.cursor}`, { headers })).body.new_booking_ids, []);
});

test("staff scheduling settings default, validate, preserve omissions and resist mass assignment", async (t) => {
  const { db, request } = await twoCompanies(t);
  db.exec("INSERT INTO users (email, password_hash, role, company_id) VALUES ('owner@example.test', 'test', 'tenant', 1)");
  const token = await signToken(secret, 1, 0);
  const headers = { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf };
  const read = () => db.prepare("SELECT * FROM staff WHERE id = 1").get()!;
  assert.equal(read().scheduling_mode, "fixed");
  assert.equal(read().scheduling_interval, 30);
  const put = (body: unknown) => request("PUT", "/api/staff/1", { headers, body });
  for (const body of [{ scheduling_mode: "smart" }, { scheduling_mode: null }, { scheduling_interval: 0 },
    { scheduling_interval: -1 }, { scheduling_interval: 241 }, { scheduling_interval: 2.5 },
    { scheduling_interval: "10" }, { scheduling_interval: null }, { company_id: 2 }, { id: 3 }]) {
    assert.equal((await put(body)).status, 400);
    assert.equal((await request("POST", "/api/staff", { headers, body: { name: "Invalid", ...body } })).status, 400);
  }
  assert.equal((await put({ scheduling_mode: "fixed", scheduling_interval: 17, working_hours: { mon: [["09:10", "13:00"]] } })).status, 200);
  assert.equal((await put({ scheduling_mode: "service_duration" })).status, 200);
  assert.equal((await put({ name: "Renamed" })).status, 200);
  assert.equal(read().scheduling_mode, "service_duration");
  assert.equal(read().scheduling_interval, 17);
  assert.deepEqual(JSON.parse(String(read().working_hours)), { mon: [["09:10", "13:00"]] });
  assert.deepEqual(db.prepare("SELECT service_id FROM staff_services WHERE staff_id = 1").all().map((r) => r.service_id), [1]);
  const created = await request("POST", "/api/staff", { headers, body: { name: "Fixture", scheduling_mode: "consecutive", scheduling_interval: 10, service_ids: [1] } });
  assert.equal(created.status, 201);
  assert.equal(created.body.staff.scheduling_mode, "consecutive");
  assert.equal(created.body.staff.scheduling_interval, 10);
  assert.equal((await request("PUT", "/api/staff/3", { headers, body: { scheduling_mode: "consecutive" } })).status, 404);
});

test("any-professional slots union each policy and assign only a professional accepting that start", async (t) => {
  const { db, request } = await twoCompanies(t);
  db.exec(`UPDATE companies SET business_hours = '{"mon":[["09:10","11:00"],["16:10","18:00"]]}' WHERE id = 1;
    UPDATE services SET duration = 30 WHERE id = 1;
    UPDATE staff SET scheduling_mode = 'consecutive' WHERE id = 1;
    UPDATE staff SET scheduling_mode = 'service_duration' WHERE id = 2;`);
  const slots = async (suffix = "") => (await request("GET", `/api/public/acme/slots?date=${MONDAY}&service_id=1${suffix}`)).body.slots;
  assert.deepEqual(await slots("&staff_id=1"), ["09:10", "16:10"]);
  assert.deepEqual(await slots(), ["09:10", "09:40", "10:10", "16:10", "16:40", "17:10"]);
  const cookie = await bookingCookie();
  const book = (start_time: string, staff_id?: number) => request("POST", "/api/public/acme/book", {
    headers: { cookie }, body: { contact_phone: "+54 11 5555-0100", service_id: 1, date: MONDAY, start_time, ...(staff_id ? { staff_id } : {}) } });
  assert.equal((await book("09:40", 1)).status, 409);
  assert.equal((await book("09:27")).status, 409);
  assert.equal((await book("25:00")).status, 400);
  const booked = await book("09:40");
  assert.equal(booked.status, 201);
  assert.equal(db.prepare("SELECT staff_id FROM appointments WHERE id = ?").get(booked.body.appointment.id)?.staff_id, 2);
  assert.deepEqual(await slots("&staff_id=1"), ["09:10", "16:10"]);
});

for (const change of ["mode", "cadence", "earliest", "duration"]) {
  test(`atomic admission rejects stale public policy: ${change}`, async (t) => {
    const { db, request, metrics, beforeNextBatch } = await twoCompanies(t);
    let start_time = "09:30";
    if (change === "earliest") {
      db.exec(`UPDATE staff SET scheduling_mode = 'consecutive' WHERE id = 1;
        INSERT INTO blocked_slots (id, staff_id, blocked_date, start_time, end_time) VALUES (1, 1, '${MONDAY}', '09:00', '10:17');`);
      ownCompany1(db, "blocked_slots", 1);
      start_time = "10:17";
    }
    beforeNextBatch(() => {
      if (change === "mode") db.exec("UPDATE staff SET scheduling_mode = 'consecutive' WHERE id = 1");
      if (change === "cadence") db.exec("UPDATE staff SET scheduling_interval = 60 WHERE id = 1");
      if (change === "earliest") db.exec("DELETE FROM blocked_slots WHERE id = 1");
      if (change === "duration") db.exec("UPDATE services SET duration = 45 WHERE id = 1");
    });
    const result = await request("POST", "/api/public/acme/book", { headers: { cookie: await bookingCookie() },
      body: { contact_phone: "+541155550100", service_id: 1, staff_id: 1, date: MONDAY, start_time } });
    assert.equal(result.status, 409);
    assert.equal(metrics.admissionConflicts, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM appointments").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM clients").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM public_booking_admission").get()?.n, 0);
  });
}

test("consecutive contention admits only one customer and advances to the exact busy end", async (t) => {
  const { db, request, synchronizeBatches, metrics } = await twoCompanies(t);
  db.exec("UPDATE staff SET scheduling_mode = 'consecutive' WHERE id = 1; UPDATE services SET duration = 45 WHERE id = 1");
  synchronizeBatches(2);
  const results = await Promise.all(["one", "two"].map(async (name) => request("POST", "/api/public/acme/book", {
    headers: { cookie: await bookingCookie(`${name}@example.test`) }, body: { contact_phone: "+541155550100", service_id: 1, staff_id: 1, date: MONDAY, start_time: "09:00" } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(metrics.admissionConflicts, 1);
  assert.deepEqual((await request("GET", `/api/public/acme/slots?date=${MONDAY}&service_id=1&staff_id=1`)).body.slots, ["09:45"]);
});

test("atomic SQL and shared pure generator agree on every minute across policies, durations and split hours", async (t) => {
  const { db } = await twoCompanies(t);
  db.exec(`UPDATE companies SET business_hours = '{"mon":[["09:00","13:00"],["16:00","19:00"]]}' WHERE id = 1;
    UPDATE staff SET working_hours = '{"mon":[["09:10","12:30"],["16:10","18:00"]]}' WHERE id = 1;
    INSERT INTO blocked_slots (id, staff_id, blocked_date, start_time, end_time) VALUES (1, 1, '${MONDAY}', '09:23', '09:37');`);
  ownCompany1(db, "blocked_slots", 1);
  const windows = [{ start: 550, end: 750 }, { start: 970, end: 1080 }];
  const busy = [{ kind: "blocked" as const, start_time: "09:23", end_time: "09:37", label: "Fixture" }];
  const insert = db.prepare("INSERT INTO public_booking_admission VALUES ('probe', 1, 1, 1, ?, ?, ?)");
  const time = (i: number) => `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
  for (const mode of ["consecutive", "fixed", "service_duration"] as SchedulingMode[]) {
    for (const duration of [10, 30, 45, 60]) {
      for (const cadence of (mode === "fixed" ? [5, 10, 15, 30] : [30])) {
        db.prepare("UPDATE staff SET scheduling_mode = ?, scheduling_interval = ? WHERE id = 1").run(mode, cadence);
        db.prepare("UPDATE services SET duration = ? WHERE id = 1").run(duration);
        const expected = new Set(publicStarts(windows, duration, busy, { scheduling_mode: mode, scheduling_interval: cadence }));
        for (let minute = 540; minute <= 1140; minute++) {
          let accepted = false;
          try { insert.run(MONDAY, time(minute), time(minute + duration)); accepted = true; }
          catch (error) { assert.match(String(error), /public booking conflict/); }
          db.exec("DELETE FROM public_booking_admission");
          assert.equal(accepted, expected.has(time(minute)), `${mode}/${cadence}/${duration} at ${time(minute)}`);
        }
      }
    }
  }
});

test("atomic consecutive admission uses the database clock ceiling and rejects past starts", async (t) => {
  const { db } = await twoCompanies(t);
  const clock = db.prepare("SELECT date('now') AS day, strftime('%H:%M', 'now') AS time").get()!;
  if (String(clock.time) >= "23:57") { t.skip("Insufficient room before midnight for full-service clock fixture"); return; }
  const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${clock.day}T00:00:00Z`).getUTCDay()];
  db.prepare("UPDATE companies SET business_hours = ? WHERE id = 1").run(JSON.stringify({ [day]: [["00:00", "23:59"]] }));
  db.exec("UPDATE staff SET scheduling_mode = 'consecutive' WHERE id = 1; UPDATE services SET duration = 1 WHERE id = 1");
  assert.throws(() => db.exec(`INSERT INTO public_booking_admission
    SELECT 'past', 1, 1, 1, date('now', '-1 day'), '12:00', '12:01'`), /public booking conflict/);
  assert.throws(() => db.exec(`INSERT INTO public_booking_admission
    SELECT 'later', 1, 1, 1, date('now'), strftime('%H:%M', 'now', '+2 minutes'), strftime('%H:%M', 'now', '+3 minutes')`), /public booking conflict/);
  // 'now' is stable within a SQLite statement, including all trigger steps.
  db.exec(`INSERT INTO public_booking_admission
    SELECT 'ceiling', 1, 1, 1, date('now'),
      strftime('%H:%M', 'now', CASE WHEN CAST(strftime('%f', 'now') AS REAL) > 0 THEN '+1 minute' ELSE '+0 minutes' END),
      strftime('%H:%M', 'now', CASE WHEN CAST(strftime('%f', 'now') AS REAL) > 0 THEN '+2 minutes' ELSE '+1 minute' END)`);
  assert.equal(db.prepare("SELECT count(*) AS n FROM public_booking_admission").get()?.n, 1);
});

test("public overview answers only for active companies and only with their data", async (t) => {
  const { db, request } = await twoCompanies(t);
  assert.equal((await request("GET", "/api/public/unknown/overview")).status, 404);
  const overview = (await request("GET", "/api/public/acme/overview")).body;
  assert.deepEqual(overview.company, { name: "Acme", slug: "acme", description: "", address: "", phone: "", public_email: "", website: "", social_links: {}, logo_url: null,
    appearance: { background: "#ffffff", text: "#18181b", button: "#6d28d9", welcome: "" }, cover_url: null, business_hours:
    { mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]], wed: [["09:00", "18:00"]], thu: [["09:00", "18:00"]],
      fri: [["09:00", "18:00"]], sat: [["09:00", "18:00"]], sun: [] } });
  assert.deepEqual(overview.services, [{ id: 1, name: "Acme haircut", duration: 60, price: 40 }],
    "inactive services and other companies' services stay hidden");
  assert.deepEqual(overview.staff, [{ id: 1, name: "Ana", title: "Senior", color: "#111111", service_ids: [1], effective_hours: overview.company.business_hours },
    { id: 2, name: "Ben", title: "Jr", color: "#222222", service_ids: [1], effective_hours: overview.company.business_hours }], "inactive staff and other companies' staff stay hidden");
  db.exec("UPDATE companies SET status = 'disabled' WHERE id = 1");
  assert.equal((await request("GET", "/api/public/acme/overview")).status, 404);
  assert.equal(db.prepare("SELECT status FROM companies WHERE slug = 'acme'").get()?.status, "disabled");
});

test("public effective schedules inherit missing days, preserve closure and clip overrides without private fields", async (t) => {
  const { db, request } = await twoCompanies(t);
  db.exec(`UPDATE companies SET business_hours = '{"mon":[["09:00","13:00"],["16:00","20:00"]],"tue":["10:00","15:00"],"wed":["09:00","18:00"],"thu":["09:00","18:00"]}' WHERE id = 1;
    UPDATE staff SET email = 'private@example.test', phone = 'private', working_hours = '{"mon":[["08:00","17:00"],["19:00","21:00"]],"wed":null,"thu":[]}' WHERE id = 1;
    INSERT INTO staff_services VALUES (1, 1, 2);`);
  const response = await request("GET", "/api/public/acme/overview");
  assert.equal(response.status, 200);
  const [ana, ben] = response.body.staff;
  assert.deepEqual(ana.effective_hours, { sun: [], mon: [["09:00", "13:00"], ["16:00", "17:00"], ["19:00", "20:00"]],
    tue: [["10:00", "15:00"]], wed: [], thu: [], fri: [], sat: [] });
  assert.deepEqual(ben.effective_hours, response.body.company.business_hours, "SQL null inherits the whole week");
  assert.deepEqual(ana.service_ids, [1], "inactive assigned services are not publicly eligible");
  assert.deepEqual(Object.keys(ana).sort(), ["id", "name", "title", "color", "service_ids", "effective_hours"].sort());
  assert.ok(!JSON.stringify(response.body).includes("private"));
  db.exec("UPDATE staff SET active = 0 WHERE id = 2");
  assert.deepEqual((await request("GET", "/api/public/acme/overview")).body.staff.map((member: any) => member.id), [1]);
});

test("slots follow business hours, staff busy time, blocked time and company scoping", async (t) => {
  const { db, request } = await twoCompanies(t);
  const slots = (query: string) => request("GET", `/api/public/acme/slots?${query}`);
  db.exec("INSERT INTO clients (id, name) VALUES (1, 'Legacy customer')");
  ownCompany1(db, "clients", 1);
  db.prepare(`INSERT INTO appointments (identifier, client_id, staff_id, scheduled_date, start_time, end_time)
    VALUES ('APT-1', 1, 1, ?, '10:00', '11:00')`).run(MONDAY);
  ownCompany1(db, "appointments", lastAppointmentId(db));
  db.prepare(`INSERT INTO appointments (identifier, client_id, staff_id, scheduled_date, start_time, end_time)
    VALUES ('APT-2', 1, 2, ?, '14:00', '15:00')`).run(MONDAY);
  ownCompany1(db, "appointments", lastAppointmentId(db));

  assert.deepEqual((await slots(`date=${MONDAY}&service_id=1&staff_id=1`)).body,
    { slots: ["09:00", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00"] },
    "Ana's booking removes 09:30, 10:00 and 10:30");
  db.prepare(`INSERT INTO blocked_slots (staff_id, blocked_date, start_time, end_time, reason)
    VALUES (1, ?, '13:00', '14:00', 'Lunch')`).run(MONDAY);
  ownCompany1(db, "blocked_slots", Number(db.prepare("SELECT id FROM blocked_slots").get()!.id));
  assert.deepEqual((await slots(`date=${MONDAY}&service_id=1&staff_id=1`)).body,
    { slots: ["09:00", "11:00", "11:30", "12:00", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00"] },
    "blocked time is as binding as a booking");
  assert.deepEqual((await slots(`date=${SUNDAY}&service_id=1&staff_id=1`)).body, { slots: [] }, "Sunday stays closed");
  assert.deepEqual((await slots(`date=${MONDAY}&service_id=1&staff_id=2`)).body,
    { slots: ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "15:00", "15:30", "16:00", "16:30", "17:00"] },
    "Ana sitting down does not stop Ben");

  // Any-staff availability: 14:30 is gone because BOTH staff members are busy there.
  const anyStaff = (await slots(`date=${MONDAY}&service_id=1`)).body;
  assert.equal(anyStaff.any, true, "no staff chosen reads as any-staff");
  assert.ok(anyStaff.slots.includes("09:00") && !anyStaff.slots.includes("13:30") && anyStaff.slots.includes("14:30"),
    "13:30 is gone because both staff members are busy there, 14:30 survives on Ana");

  assert.equal((await slots(`date=${MONDAY}&service_id=3`)).status, 400, "Beauty's service does not belong to Acme");
  assert.equal((await slots(`date=${MONDAY}&service_id=1&staff_id=3`)).status, 400, "Zoe does not belong to Acme");
  assert.equal((await slots(`date=31-10-2026&service_id=1`)).status, 400, "a fake date is rejected");
  assert.equal((await slots(`date=${MONDAY}&service_id=999`)).status, 400);
  assert.equal((await slots(`date=${MONDAY}&service_id=2`)).status, 400, "retired services are not shown");
});

test("customer session routes guard identity", async (t) => {
  const { request } = await twoCompanies(t);
  assert.equal((await request("GET", "/api/auth/customer/session")).status, 401);
  assert.equal((await request("GET", "/api/auth/customer/session", { headers: { cookie: "yt_book=forged" } })).status, 401);
  const cookie = await bookingCookie();
  assert.deepEqual((await request("GET", "/api/auth/customer/session", { headers: { cookie } })).body,
    { customer: { sub: "google-1", email: "client@example.test", name: "Client Name" } });
  const logout = await request("POST", "/api/auth/customer/logout", { headers: { cookie } });
  assert.equal(logout.status, 200);
  assert.ok(logout.cookies.some((value) => value.startsWith("yt_book=;")), "logout clears the booking cookie");
});

test("public booking creates a confirmed appointment, one client per customer and honest 409s", async (t) => {
  const { db, request } = await twoCompanies(t);
  const cookie = await bookingCookie();
  const book = (body: Record<string, unknown>, headers: Record<string, string> = { cookie }) =>
    request("POST", "/api/public/acme/book", { body: { contact_phone: "+541155550100", ...body }, headers });
  const unauthenticated = { body: { service_id: 1, date: MONDAY, start_time: "10:00" }, headers: {} };

  assert.equal((await request("POST", "/api/public/acme/book", unauthenticated)).status, 401,
    "an unsigned browser cannot book");
  assert.equal((await request("POST", "/api/public/unknown/book", {
    body: { contact_phone: "+541155550100", service_id: 1, date: MONDAY, start_time: "10:00" },
    headers: { cookie: await bookingCookie() },
  })).status, 404);

  const first = (await book({ service_id: 1, date: MONDAY, start_time: "10:00" })).body.appointment;
  assert.deepEqual(first, { id: first.id, identifier: first.identifier,
    scheduled_date: MONDAY, start_time: "10:00", end_time: "11:00", status: "confirmed" });
  assert.match(first.identifier, /^APT-\d+$/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tenant_ownership WHERE resource_type = 'appointments'
    AND resource_id = ? AND company_id = 1`).get(first.id)?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM appointment_services WHERE appointment_id = ?").get(first.id)?.count, 1);
  assert.equal(db.prepare("SELECT company_id FROM tenant_ownership WHERE resource_type = 'appointment_services'").get()?.company_id, 1);
  const client = db.prepare("SELECT id, email, name FROM clients ORDER BY id LIMIT 1").get() as { id: number; email: string; name: string };
  assert.equal(db.prepare("SELECT staff_id FROM appointments WHERE id = ?").get(first.id)?.staff_id, 1,
    "the first active staff member by name got the chair");
  assert.equal(client.email, "client@example.test");
  assert.equal(client.name, "Client Name");

  // The same Google identity reuses this company's client; Ana sits down, so Ben is picked.
  const second = await book({ service_id: 1, date: MONDAY, start_time: "10:00" });
  assert.equal(second.status, 201);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM clients").get()?.count, 1, "no duplicate client for the same email");
  assert.equal(db.prepare("SELECT staff_id FROM appointments WHERE id = ?").get(second.body.appointment.id)?.staff_id, 2,
    "Ben is free where Ana is booked");

  const full = await book({ service_id: 1, date: MONDAY, start_time: "10:00" });
  assert.equal(full.status, 409);
  assert.equal(full.body.error, "El horario ya no está disponible. Actualiza los horarios y elige otro.");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM appointments").get()?.count, 2, "no partial writes on conflict");

  const late = await book({ service_id: 1, date: MONDAY, start_time: "17:30" });
  assert.equal(late.status, 409, "a service must end inside the opening hours");
  const sunday = await book({ service_id: 1, date: SUNDAY, start_time: "10:00" });
  assert.equal(sunday.status, 409, "closed days cannot be booked");

  const crossService = await book({ service_id: 3, date: MONDAY, start_time: "10:00" });
  assert.equal(crossService.status, 400, "Beauty's service is not bookable through Acme");
  const crossStaff = await book({ service_id: 1, date: MONDAY, start_time: "12:00", staff_id: 3 });
  assert.equal(crossStaff.status, 400, "Zoe is not bookable through Acme, even when free");
  db.exec("UPDATE services SET active = 0 WHERE id = 1");
  const retired = await book({ service_id: 1, date: MONDAY, start_time: "12:00" });
  assert.equal(retired.status, 400, "inactive services are not bookable");
});

test("owners set their public slug and cannot claim another company's link", async (t) => {
  const { db, request } = await twoCompanies(t);
  db.exec(`INSERT INTO users (email, password_hash, role, company_id)
    VALUES ('a@example.test', 'test-only', 'tenant', 1), ('b@example.test', 'test-only', 'tenant', 2)`);
  const ownerA = await signToken(secret, 1, 0);
  const ownerB = await signToken(secret, 2, 0);
  const call = (token: { jwt: string; csrf: string }, body: unknown) =>
    request("PUT", "/api/company/slug", { body, headers: { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf } });

  assert.equal((await call(ownerA, { slug: "Mi Salón!" })).status, 400, "only lowercase letters, digits and dashes");
  assert.equal((await call(ownerA, { slug: "ab" })).status, 400, "minimum length");
  assert.equal((await call(ownerA, { slug: "ok-slug-1" })).status, 200);
  assert.equal(db.prepare("SELECT slug FROM companies WHERE id = 1").get()?.slug, "ok-slug-1");
  assert.equal((await call(ownerB, { slug: "ok-slug-1" })).status, 409, "second company cannot steal the link");
  assert.equal(db.prepare("SELECT slug FROM companies WHERE id = 2").get()?.slug, "beauty");
  assert.equal((await request("GET", "/api/public/ok-slug-1/overview")).status, 200);
});

test("Google sign-in refuses to start without configuration", async (t) => {
  const { request } = await twoCompanies(t);
  const started = await request("GET", "/api/auth/customer/google?slug=acme");
  assert.equal(started.status, 503);
  assert.equal(started.body.error, "Google sign-in is not configured");
  const callback = await request("GET", "/api/auth/customer/google/callback?code=x");
  assert.equal(callback.status, 503);
  assert.equal(callback.body.error, "Google sign-in is not configured");
});

test("a configured Google flow redirects, binds the state cookie and opens a customer session", async (t) => {
  const { db, request } = await twoCompanies(t);
  const env = { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" };
  const appOrigin = "https://acme.example";

  assert.equal((await request("GET", "/api/auth/customer/google?slug=unknown", { env })).status, 404);
  const started = await request("GET", "/api/auth/customer/google?slug=acme", { env });
  assert.equal(started.status, 302);
  assert.match(started.location!, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(started.location!, /client_id=client-id/);
  assert.match(started.location!, /scope=openid\+email\+profile/);
  const state = cookieValue(started.cookies, "yt_oauth");
  assert.ok(await verifyCustomerState(secret, state), "the state cookie carries a signed nonce");

  // A forged state cannot reach the exchange.
  assert.equal((await request("GET", "/api/auth/customer/google/callback?code=good",
    { env, headers: { cookie: "yt_oauth=forged" } })).status, 400);

  const realFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const json = calls.length === 1
        ? { access_token: "atok" }
        : { sub: "google-1", email: "CLIENT@example.test", name: "Client Name", email_verified: true };
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const done = await request("GET", `/api/auth/customer/google/callback?code=good&state=${state}`, {
      env: { ...env, APP_ORIGIN: appOrigin }, headers: { cookie: `yt_oauth=${state}` },
    });
    assert.equal(done.status, 302);
    assert.equal(done.location, `${appOrigin}/book/acme`);
    assert.ok(done.cookies.some((value) => value.startsWith("yt_book=")));
    const exchange = String(calls[0]!.init!.body);
    assert.match(exchange, /code=good/);
    assert.match(exchange, /client_id=client-id/);
    assert.match(exchange, /redirect_uri=https%3A%2F%2Facme\.example%2Fapi%2Fauth%2Fcustomer%2Fgoogle%2Fcallback/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "https://oauth2.googleapis.com/token");
    assert.equal(calls[1]!.url, "https://openidconnect.googleapis.com/v1/userinfo");
    assert.equal((calls[1]!.init!.headers as Record<string, string>).authorization, "Bearer atok");
    const identity = db.prepare("SELECT provider, provider_account_id, email, display_name FROM oauth_identities").get() as {
      provider: string; provider_account_id: string; email: string; display_name: string };
    assert.deepEqual({ ...identity }, { provider: "google", provider_account_id: "google-1", email: "client@example.test", display_name: "Client Name" });

    // The session opened by the redirect is usable, and booking runs end to end.
    const cookie = `yt_book=${cookieValue(done.cookies, "yt_book")}`;
    assert.deepEqual((await request("GET", "/api/auth/customer/session", { headers: { cookie } })).body,
      { customer: { sub: "google-1", email: "client@example.test", name: "Client Name" } });
    const book = await request("POST", "/api/public/acme/book",
      { body: { contact_phone: "+541155550100", service_id: 1, date: MONDAY, start_time: "09:00" }, headers: { cookie } });
    assert.equal(book.status, 201);
    assert.equal(book.body.appointment.status, "confirmed");

    // A second sign-in with the same Google account upserts instead of duplicating.
    const again = await request("GET", "/api/auth/customer/google?slug=acme", { env });
    const second = await request("GET", `/api/auth/customer/google/callback?code=good&state=${cookieValue(again.cookies, "yt_oauth")}`, {
      env: { ...env, APP_ORIGIN: appOrigin },
      headers: { cookie: `yt_oauth=${cookieValue(again.cookies, "yt_oauth")}` },
    });
    assert.equal(second.status, 302);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM oauth_identities").get()?.count, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a Google user who declines consent leaves without a session", async (t) => {
  const { request } = await twoCompanies(t);
  const env = { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", APP_ORIGIN: "https://acme.example" };
  const started = await request("GET", "/api/auth/customer/google?slug=acme", { env });
  const done = await request("GET", `/api/auth/customer/google/callback?error=access_denied&state=${cookieValue(started.cookies, "yt_oauth")}`, {
    env, headers: { cookie: `yt_oauth=${cookieValue(started.cookies, "yt_oauth")}` },
  });
  assert.equal(done.status, 302);
  assert.match(done.location!, /\/book\/acme\?auth=failed$/);
  assert.equal(done.cookies.some((value) => value.startsWith("yt_book=")), false);
});

/** Appointments are the last business table the legacy seed creates; rely on max(id). */
function lastAppointmentId(db: DatabaseSync): number {
  return Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM appointments").get()!.id);
}

test("competing public bookings are admitted atomically without orphan clients or ownership", { timeout: 5000 }, async (t) => {
  const { db, request, metrics, synchronizeBatches } = await twoCompanies(t);
  const cookies = await Promise.all([bookingCookie("first@example.test"), bookingCookie("second@example.test")]);
  synchronizeBatches(2);
  const responses = await Promise.all(cookies.map((cookie) => request("POST", "/api/public/acme/book", {
    headers: { cookie }, body: { contact_phone: "+541155550100", service_id: 1, staff_id: 1, date: MONDAY, start_time: "10:00" },
  })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(metrics.admissionConflicts, 1, "the loser passed the stale HTTP availability read and was rejected inside the write transaction");
  for (const table of ["appointments", "clients", "appointment_services"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 1, table);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tenant_ownership WHERE resource_type = ?").get(table)?.n, 1, table);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM public_booking_admission").get()?.n, 0);
  assert.equal(db.prepare("SELECT value FROM _meta WHERE key = 'appointment_counter'").get()?.value, "1");
});

test("dates, duration and mutation origins are validated without private data exposure", async (t) => {
  const { db, request } = await twoCompanies(t);
  const cookie = await bookingCookie();
  const body = { contact_phone: "+541155550100", service_id: 1, staff_id: 1, date: MONDAY, start_time: "10:00" };
  for (const date of ["2026-02-30", "2020-01-01"]) {
    assert.equal((await request("POST", "/api/public/acme/book", { body: { ...body, date }, headers: { cookie } })).status, 400);
    assert.equal((await request("GET", `/api/public/acme/slots?date=${date}&service_id=1`)).status, 400);
  }
  for (const origin of ["https://evil.example", "null", ""]) {
    assert.equal((await request("POST", "/api/public/acme/book", { body, headers: { cookie, origin } })).status, 403);
  }
  assert.equal((await request("POST", "/api/public/acme/book", { body, headers: { cookie, "content-type": "text/plain" } })).status, 403);
  assert.equal((await request("GET", "/api/clients", { headers: { cookie } })).status, 401);
  db.exec("UPDATE services SET duration = -30 WHERE id = 1");
  assert.equal((await request("POST", "/api/public/acme/book", { body, headers: { cookie } })).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients").get()?.n, 0);
});

test("OAuth checks the echoed state, verified email and Vite redirect origin", async (t) => {
  const { request } = await twoCompanies(t);
  const env = { GOOGLE_CLIENT_ID: "test-id", GOOGLE_CLIENT_SECRET: "test-secret" };
  const started = await request("GET", "http://localhost:8787/api/auth/customer/google?slug=acme", { env });
  assert.equal(new URL(started.location!).searchParams.get("redirect_uri"), "http://localhost:5173/api/auth/customer/google/callback");
  const state = cookieValue(started.cookies, "yt_oauth");
  for (const suffix of ["", "&state=forged"]) {
    assert.equal((await request("GET", `/api/auth/customer/google/callback?code=x${suffix}`, {
      env, headers: { cookie: `yt_oauth=${state}` },
    })).status, 400);
  }
  const realFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify(++calls === 1 ? { access_token: "mock" } :
      { sub: "account", email: "client@example.test", email_verified: false }))) as typeof fetch;
    const done = await request("GET", `/api/auth/customer/google/callback?code=x&state=${state}`, {
      env, headers: { cookie: `yt_oauth=${state}` },
    });
    assert.equal(done.location, "http://localhost:5173/book/acme?auth=failed");
    assert.equal(done.cookies.some((value) => value.startsWith("yt_book=")), false);
  } finally { globalThis.fetch = realFetch; }
});

test("weekly hours and slug settings are tenant-scoped and reject invalid windows", async (t) => {
  const { db, request } = await twoCompanies(t);
  db.exec("INSERT INTO users (email, password_hash, role, company_id) VALUES ('owner@example.test', 'test', 'tenant', 1)");
  const token = await signToken(secret, 1, 0);
  const headers = { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf };
  assert.equal((await request("GET", "/api/company/booking", { headers })).body.slug, "acme");
  const hours = { mon: ["12:00", "14:00"], tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
  assert.equal((await request("PUT", "/api/company/business-hours", { headers, body: hours })).status, 200);
  assert.equal((await request("PUT", "/api/company/business-hours", { headers, body: { ...hours, mon: ["18:00", "09:00"] } })).status, 400);
  assert.deepEqual((await request("GET", `/api/public/acme/slots?date=${MONDAY}&service_id=1&staff_id=1`)).body.slots, ["12:00", "12:30", "13:00"]);
  assert.notEqual(db.prepare("SELECT business_hours FROM companies WHERE id = 2").get()?.business_hours, JSON.stringify(hours));
});

test("split hours and personal overrides share slot and booking admission rules", async (t) => {
  const { db, request } = await twoCompanies(t);
  db.prepare("UPDATE companies SET business_hours = ? WHERE id = 1")
    .run(JSON.stringify({ mon: [["09:00", "13:00"], ["16:00", "20:00"]] }));
  const slots = async (staff = "") => (await request("GET", `/api/public/acme/slots?date=${MONDAY}&service_id=1${staff}`)).body.slots;
  const inherited = await slots("&staff_id=1");
  assert.ok(inherited.includes("12:00"));
  assert.ok(inherited.includes("16:00"));
  assert.ok(inherited.includes("19:00"));
  for (const time of ["12:30", "13:00", "15:30", "19:30"]) assert.ok(!inherited.includes(time), time);
  // Ana is explicitly closed, while Ben inherits all company hours.
  db.exec(`UPDATE staff SET working_hours = '{"mon":null}' WHERE id = 1`);
  assert.deepEqual(await slots("&staff_id=1"), []);
  assert.deepEqual(await slots(), inherited);
  const cookie = await bookingCookie();
  for (const time of ["12:30", "13:00", "15:30"]) {
    assert.equal((await request("POST", "/api/public/acme/book", { headers: { cookie },
      body: { contact_phone: "+541155550100", service_id: 1, date: MONDAY, start_time: time } })).status, 409, time);
  }
  assert.equal((await request("POST", "/api/public/acme/book", { headers: { cookie },
    body: { contact_phone: "+541155550100", service_id: 1, date: MONDAY, start_time: "16:00", staff_id: 1 } })).status, 409);
  const booked = await request("POST", "/api/public/acme/book", { headers: { cookie },
    body: { contact_phone: "+541155550100", service_id: 1, date: MONDAY, start_time: "16:00" } });
  assert.equal(booked.status, 201);
  assert.equal(db.prepare("SELECT staff_id FROM appointments WHERE id = ?").get(booked.body.appointment.id)?.staff_id, 2);
  // Personal intervals cannot expand company hours, nor bridge its midday gap.
  db.exec(`UPDATE staff SET working_hours = '{"mon":[["08:00","10:00"],["12:00","17:00"],["19:00","21:00"]]}' WHERE id = 1`);
  assert.deepEqual(await slots("&staff_id=1"), ["09:00", "12:00", "16:00", "19:00"]);
  // A missing weekday inherits even when other days are overridden.
  db.exec(`UPDATE staff SET working_hours = '{"tue":[]}' WHERE id = 1`);
  assert.deepEqual(await slots("&staff_id=1"), inherited);
  db.exec("UPDATE staff SET working_hours = NULL WHERE id = 1");
  assert.deepEqual(await slots("&staff_id=1"), inherited);
  const overview = (await request("GET", "/api/public/acme/overview")).body;
  assert.deepEqual(overview.company.business_hours.mon, [["09:00", "13:00"], ["16:00", "20:00"]]);
});

test("staff schedule edits validate intervals, preserve updates and enforce tenant ownership", async (t) => {
  const { db, request } = await twoCompanies(t);
  db.exec("INSERT INTO users (email, password_hash, role, company_id) VALUES ('owner@example.test', 'test', 'tenant', 1)");
  const token = await signToken(secret, 1, 0);
  const headers = { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf };
  const body = { working_hours: { mon: [["09:00", "13:00"], ["16:00", "20:00"]], tue: null } };
  assert.equal((await request("PUT", "/api/staff/3", { headers, body })).status, 404);
  assert.equal(db.prepare("SELECT working_hours FROM staff WHERE id = 3").get()?.working_hours, null);
  assert.equal((await request("PUT", "/api/staff/1", { headers, body: { ...body, company_id: 2 } })).status, 400);
  assert.equal((await request("PUT", "/api/staff/1", { headers, body })).status, 200);
  assert.equal(db.prepare("SELECT company_id FROM tenant_ownership WHERE resource_type = 'staff' AND resource_id = 1").get()?.company_id, 1);
  assert.deepEqual((await request("GET", "/api/staff", { headers })).body.staff.find((s: any) => s.id === 1).working_hours,
    { mon: [["09:00", "13:00"], ["16:00", "20:00"]], tue: [] });
  for (const mon of [ [["09:00", "13:00"], ["12:00", "14:00"]], [["13:00", "09:00"]], [["9:00", "12:00"]], [["09:00", "24:00"]], [["09:00", "09:00"]] ]) {
    assert.equal((await request("PUT", "/api/staff/1", { headers, body: { working_hours: { mon } } })).status, 400);
    assert.equal((await request("POST", "/api/staff", { headers, body: { name: "Invalid", working_hours: { mon } } })).status, 400);
    assert.equal((await request("PUT", "/api/company/business-hours", { headers,
      body: { mon, tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } })).status, 400);
  }
  assert.equal((await request("PUT", "/api/staff/1", { headers, body: { working_hours: { mon: [["13:00", "16:00"], ["09:00", "13:00"]] } } })).status, 200);
  assert.deepEqual(JSON.parse(String(db.prepare("SELECT working_hours FROM staff WHERE id = 1").get()?.working_hours)).mon, [["09:00", "16:00"]]);
  assert.equal((await request("PUT", "/api/staff/1", { headers, body: { active: 0 } })).status, 200);
  assert.notEqual(db.prepare("SELECT working_hours FROM staff WHERE id = 1").get()?.working_hours, null, "unrelated updates preserve overrides");
  assert.equal((await request("PUT", "/api/staff/1", { headers, body: { working_hours: null } })).status, 200);
  assert.equal(db.prepare("SELECT working_hours FROM staff WHERE id = 1").get()?.working_hours, null);
  assert.equal((await request("POST", "/api/staff", { headers, body: { name: "New", ...body, company_id: 2 } })).status, 400);
  const created = await request("POST", "/api/staff", { headers, body: { name: "New", ...body } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.staff.working_hours.tue, []);
  assert.equal(db.prepare("SELECT company_id FROM tenant_ownership WHERE resource_type = 'staff' AND resource_id = ?").get(created.body.staff.id)?.company_id, 1);
  assert.equal((await request("PUT", "/api/staff/1", { body })).status, 401);
});

test("explicit staff overrides admit only services wholly inside a company/personal intersection", async (t) => {
  const { db, request } = await twoCompanies(t);
  db.exec(`UPDATE companies SET business_hours = '{"mon":[["09:00","13:00"],["16:00","20:00"]]}' WHERE id = 1;
    UPDATE staff SET working_hours = '{"mon":[["08:00","12:00"],["17:00","21:00"]]}' WHERE id = 1;`);
  const cookie = await bookingCookie();
  for (const start_time of ["08:00", "11:30", "12:00", "16:00", "19:30", "20:00"]) {
    assert.equal((await request("POST", "/api/public/acme/book", { headers: { cookie },
      body: { contact_phone: "+541155550100", service_id: 1, staff_id: 1, date: MONDAY, start_time } })).status, 409, start_time);
  }
  for (const start_time of ["11:00", "17:00", "19:00"]) {
    assert.equal((await request("POST", "/api/public/acme/book", { headers: { cookie },
      body: { contact_phone: "+541155550100", service_id: 1, staff_id: 1, date: MONDAY, start_time } })).status, 201, start_time);
  }
});

for (const change of ["company closes", "company splits", "staff closes", "staff narrows", "staff deactivates", "assignment removed", "service deactivates"] as const) {
  test(`atomic admission rechecks current hours after stale reads: ${change}`, async (t) => {
    const { db, request, metrics, beforeNextBatch } = await twoCompanies(t);
    const cookie = await bookingCookie();
    beforeNextBatch(() => {
      if (change === "company closes") db.exec(`UPDATE companies SET business_hours = '{"mon":null}' WHERE id = 1`);
      if (change === "company splits") db.exec(`UPDATE companies SET business_hours = '{"mon":[["09:00","10:30"],["11:00","18:00"]]}' WHERE id = 1`);
      if (change === "staff closes") db.exec(`UPDATE staff SET working_hours = '{"mon":[]}' WHERE id = 1`);
      if (change === "staff narrows") db.exec(`UPDATE staff SET working_hours = '{"mon":[["10:30","18:00"]]}' WHERE id = 1`);
      if (change === "staff deactivates") db.exec("UPDATE staff SET active = 0 WHERE id = 1");
      if (change === "assignment removed") db.exec("DELETE FROM staff_services WHERE company_id = 1 AND staff_id = 1 AND service_id = 1");
      if (change === "service deactivates") db.exec("UPDATE services SET active = 0 WHERE id = 1");
    });
    const booked = await request("POST", "/api/public/acme/book", { headers: { cookie },
      body: { contact_phone: "+541155550100", service_id: 1, staff_id: 1, date: MONDAY, start_time: "10:00" } });
    assert.equal(booked.status, 409);
    assert.equal(metrics.admissionConflicts, 1);
    for (const table of ["appointments", "clients", "appointment_services", "public_booking_admission"]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0, table);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tenant_ownership WHERE resource_type IN ('appointments','clients','appointment_services')").get()?.n, 0);
    assert.equal(db.prepare("SELECT value FROM _meta WHERE key = 'appointment_counter'").get()?.value, undefined);
  });
}

test("unconfigured legacy staff fail closed and any-staff slots and booking use only qualified active staff", async (t) => {
  const { db, request } = await twoCompanies(t);
  db.exec("DELETE FROM staff_services WHERE company_id = 1");
  const slots = (staff = "") => request("GET", `/api/public/acme/slots?date=${MONDAY}&service_id=1${staff}`);
  assert.deepEqual((await slots()).body, { slots: [], any: true });
  const cookie = await bookingCookie();
  const book = (staff_id?: number) => request("POST", "/api/public/acme/book", { headers: { cookie },
    body: { contact_phone: "+541155550100", service_id: 1, date: MONDAY, start_time: "10:00", ...(staff_id === undefined ? {} : { staff_id }) } });
  assert.equal((await book()).status, 409);
  assert.equal((await book(1)).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients").get()?.n, 0);
  assert.deepEqual((await request("GET", "/api/public/acme/overview")).body.staff.map((s: any) => s.service_ids), [[], []]);
  db.exec(`INSERT INTO staff_services VALUES (1, 2, 1), (1, 4, 1);
    UPDATE staff SET working_hours = '{"mon":[["12:00","14:00"]]}' WHERE id = 2;`);
  assert.deepEqual((await slots()).body.slots, ["12:00", "12:30", "13:00"]);
  assert.equal((await slots("&staff_id=1")).status, 400);
  assert.equal((await slots("&staff_id=4")).status, 400);
  assert.equal((await book()).status, 409, "free but unqualified Ana must not be picked");
  db.exec("UPDATE staff SET working_hours = NULL WHERE id = 2");
  const booked = await book();
  assert.equal(booked.status, 201);
  assert.equal(db.prepare("SELECT staff_id FROM appointments WHERE id = ?").get(booked.body.appointment.id)?.staff_id, 2);
});

test("tenant assignment contracts create, read, preserve, replace and clear without changing schedules", async (t) => {
  const { db, request } = await twoCompanies(t);
  db.exec("INSERT INTO users (email, password_hash, role, company_id) VALUES ('owner@example.test', 'test', 'tenant', 1)");
  const token = await signToken(secret, 1, 0);
  const headers = { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf };
  const create = (body: unknown) => request("POST", "/api/staff", { headers, body });
  const update = (id: number, body: unknown) => request("PUT", `/api/staff/${id}`, { headers, body });
  const read = async (id: number) => (await request("GET", "/api/staff", { headers })).body.staff.find((s: any) => s.id === id);
  const empty = await create({ name: "Unconfigured" });
  assert.equal(empty.status, 201);
  assert.deepEqual(empty.body.staff.service_ids, []);
  const created = await create({ name: "Configured", working_hours: { mon: [["10:00", "14:00"]] }, service_ids: [1, 2] });
  assert.equal(created.status, 201);
  const id = created.body.staff.id;
  assert.deepEqual(created.body.staff.service_ids, [1, 2], "inactive services may remain configured");
  assert.deepEqual((await read(id)).service_ids, [1, 2]);
  assert.equal((await update(id, { title: "Updated" })).status, 200);
  assert.deepEqual((await read(id)).service_ids, [1, 2], "omission preserves assignments");
  assert.equal((await update(id, { service_ids: [2] })).status, 200);
  assert.deepEqual((await read(id)).service_ids, [2]);
  assert.deepEqual((await read(id)).working_hours, { mon: [["10:00", "14:00"]] });
  for (const service_ids of [[3], [999], [1, 1], [-1]]) {
    assert.equal((await update(id, { name: "Must not change", service_ids })).status, 400);
    assert.equal((await read(id)).name, "Configured");
    assert.deepEqual((await read(id)).service_ids, [2]);
    assert.equal((await create({ name: "Invalid", service_ids })).status, 400);
  }
  assert.equal((await update(3, { service_ids: [1] })).status, 404, "foreign staff rejected");
  assert.equal((await update(id, { service_ids: [] })).status, 200);
  assert.deepEqual((await read(id)).service_ids, []);
  assert.deepEqual((await read(id)).working_hours, { mon: [["10:00", "14:00"]] });
  assert.equal((await request("PUT", `/api/staff/${id}`, { body: { service_ids: [1] } })).status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staff WHERE name = 'Invalid'").get()?.n, 0);
});

test("qualification integrity rejects cross-company IDs and cleans mappings on resource/ownership deletion", async (t) => {
  const { db } = await twoCompanies(t);
  for (const [company, staff, service] of [[1, 1, 3], [1, 3, 1], [2, 1, 3], [1, 999, 1]]) {
    assert.throws(() => db.prepare("INSERT INTO staff_services VALUES (?, ?, ?)").run(company, staff, service), /staff service must belong to company/);
  }
  assert.throws(() => db.exec("INSERT INTO staff_services VALUES (1, 1, 1)"), /UNIQUE/);
  assert.throws(() => db.exec("UPDATE staff_services SET service_id = 3 WHERE staff_id = 1"), /immutable/);
  db.exec("DELETE FROM staff WHERE id = 1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staff_services WHERE staff_id = 1").get()?.n, 0);
  db.exec("DELETE FROM services WHERE id = 1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staff_services WHERE service_id = 1").get()?.n, 0);
  db.exec("DELETE FROM tenant_ownership WHERE resource_type = 'services' AND resource_id = 3");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staff_services").get()?.n, 0);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("failed atomic assignment replacement rolls back staff fields and existing mappings", async (t) => {
  const { db, request, beforeNextBatch } = await twoCompanies(t);
  db.exec("INSERT INTO users (email, password_hash, role, company_id) VALUES ('owner@example.test', 'test', 'tenant', 1)");
  const token = await signToken(secret, 1, 0);
  beforeNextBatch(() => db.exec("DELETE FROM tenant_ownership WHERE resource_type = 'services' AND resource_id = 2"));
  const result = await request("PUT", "/api/staff/1", {
    headers: { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf }, body: { name: "Must roll back", service_ids: [2] } });
  assert.equal(result.status, 400);
  assert.equal(db.prepare("SELECT name FROM staff WHERE id = 1").get()?.name, "Ana");
  assert.deepEqual(db.prepare("SELECT service_id FROM staff_services WHERE staff_id = 1").all().map((row) => row.service_id), [1]);
  db.exec("INSERT INTO tenant_ownership VALUES ('services', 2, 1)");
  const count = db.prepare("SELECT COUNT(*) AS n FROM staff").get()?.n;
  beforeNextBatch(() => db.exec("DELETE FROM tenant_ownership WHERE resource_type = 'services' AND resource_id = 2"));
  const created = await request("POST", "/api/staff", {
    headers: { cookie: `__Host-youturno=${token.jwt}`, "x-csrf-token": token.csrf }, body: { name: "Must not exist", service_ids: [2] } });
  assert.equal(created.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staff").get()?.n, count);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tenant_ownership WHERE resource_type = 'staff'").get()?.n, count);
});
