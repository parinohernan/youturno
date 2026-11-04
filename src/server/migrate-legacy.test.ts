import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { companyUpgrade, staffUpgrade, admissionUpgrade } from "../../scripts/public-booking-migration.mjs";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("./migrate-legacy.sql", import.meta.url), "utf8");
const types = ["clients", "staff", "services", "appointments", "appointment_services", "appointment_notes", "blocked_slots", "products"];

test("scheduling migration defaults legacy staff to fixed/30 and preserves configured policy on repeat", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema.replace(/^  scheduling_mode .*\n/m, "").replace(/^  scheduling_interval .*\n/m, "")
      .replace(/CREATE TRIGGER IF NOT EXISTS admit_public_booking_policy_v1[\s\S]*?\nEND;/, ""));
    db.exec(`INSERT INTO companies (id, name, status) VALUES (1, 'Preserved', 'active');
      INSERT INTO staff (id, name, email, working_hours) VALUES (7, 'Legacy', 'fixture@example.test', '{"mon":[["09:10","12:00"]]}');
      INSERT INTO services (id, name) VALUES (4, 'Existing');
      INSERT INTO tenant_ownership VALUES ('staff', 7, 1), ('services', 4, 1);
      INSERT INTO staff_services VALUES (1, 7, 4);`);
    const old = db.prepare("SELECT * FROM staff").get()!;
    const counts = () => types.map((type) => db.prepare(`SELECT count(*) AS n FROM ${type}`).get()?.n);
    const before = counts();
    for (let pass = 0; pass < 2; pass++) {
      const upgrade = staffUpgrade(db.prepare("PRAGMA table_info(staff)").all());
      if (upgrade) db.exec(upgrade);
      db.exec(schema);
      db.exec(migration);
      const { scheduling_mode, scheduling_interval, ...original } = db.prepare("SELECT * FROM staff").get()!;
      assert.deepEqual(original, { ...old });
      assert.equal(scheduling_mode, pass ? "service_duration" : "fixed");
      assert.equal(scheduling_interval, pass ? 17 : 30);
      assert.deepEqual(counts(), before);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      db.exec("UPDATE staff SET scheduling_mode = 'service_duration', scheduling_interval = 17");
    }
    assert.equal(staffUpgrade(db.prepare("PRAGMA table_info(staff)").all()), "");
    assert.throws(() => db.exec("UPDATE staff SET scheduling_mode = 'ai'"), /CHECK/);
    assert.throws(() => db.exec("UPDATE staff SET scheduling_interval = 0"), /CHECK/);
    assert.throws(() => db.exec("UPDATE staff SET scheduling_interval = 1.5"), /CHECK/);
  } finally { db.close(); }
});

test("qualification migration is additive, repeatable and leaves legacy staff unassigned", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema.replace("  service_id INTEGER REFERENCES services(id),\n", "")
      .replace(/CREATE TRIGGER IF NOT EXISTS admit_public_booking_service_v1[\s\S]*?\nEND;/, ""));
    db.exec(`INSERT INTO companies (id, name, status) VALUES (1, 'Existing', 'active');
      INSERT INTO staff (id, name) VALUES (1, 'Legacy');
      INSERT INTO services (id, name) VALUES (1, 'Legacy service');
      INSERT INTO tenant_ownership VALUES ('staff', 1, 1), ('services', 1, 1);`);
    for (let pass = 0; pass < 2; pass++) {
      const upgrade = admissionUpgrade(db.prepare("PRAGMA table_info(public_booking_admission)").all());
      if (upgrade) db.exec(upgrade);
      db.exec(schema);
      db.exec(migration);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staff_services").get()?.n, 0);
      assert.equal(db.prepare("SELECT name FROM staff WHERE id = 1").get()?.name, "Legacy");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM services").get()?.n, 1);
    }
    assert.throws(() => db.exec(`INSERT INTO public_booking_admission
      (id, company_id, staff_id, service_id, scheduled_date, start_time, end_time)
      VALUES ('unassigned', 1, 1, 1, '2026-11-02', '10:00', '11:00')`), /public booking conflict/);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { db.close(); }
});

test("existing staff inherit after additive repeatable schedule migration without losing data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema.replace("  working_hours TEXT DEFAULT NULL,\n", "")
      .replace(/CREATE TRIGGER IF NOT EXISTS admit_public_booking_hours_v1[\s\S]*?\nEND;/, ""));
    db.exec(`INSERT INTO companies (id, name, slug, status, business_hours) VALUES
      (1, 'Existing', 'existing', 'active', '{"mon":["10:00","17:00"]}');
      INSERT INTO staff (id, name, email, active) VALUES (9, 'Preserved', 'staff@example.test', 1);
      INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES ('staff', 9, 1);`);
    for (let pass = 0; pass < 2; pass++) {
      const columns = db.prepare("PRAGMA table_info(staff)").all();
      db.exec(schema);
      const upgrade = staffUpgrade(columns);
      if (upgrade) db.exec(upgrade);
      db.exec(migration);
      assert.equal(db.prepare("SELECT working_hours FROM staff WHERE id = 9").get()?.working_hours,
        pass === 0 ? null : '{"mon":[]}');
      if (pass === 0) db.exec(`UPDATE staff SET working_hours = '{"mon":[]}' WHERE id = 9`);
    }
    assert.equal(db.prepare("SELECT name FROM staff WHERE id = 9").get()?.name, "Preserved");
    assert.equal(db.prepare("SELECT email FROM staff WHERE id = 9").get()?.email, "staff@example.test");
    assert.equal(db.prepare("SELECT business_hours FROM companies WHERE id = 1").get()?.business_hours, '{"mon":["10:00","17:00"]}');
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.exec(`INSERT INTO services (id, name, duration) VALUES (1, 'Explicit service', 60);
      INSERT INTO tenant_ownership VALUES ('services', 1, 1);
      INSERT INTO staff_services VALUES (1, 9, 1);`);
    assert.throws(() => db.exec(`INSERT INTO public_booking_admission VALUES ('closed', 1, 9, 1, '2026-11-02', '10:00', '11:00')`), /public booking conflict/);
    db.exec("UPDATE staff SET working_hours = NULL WHERE id = 9");
    db.exec(`INSERT INTO public_booking_admission VALUES ('inherit', 1, 9, 1, '2037-11-02', '10:00', '11:00')`);
    assert.throws(() => db.exec(`INSERT INTO public_booking_admission VALUES ('outside', 1, 9, 1, '2026-11-02', '09:00', '10:00')`), /public booking conflict/);
  } finally { db.close(); }
});

test("old companies schema gains booking columns repeatedly without changing existing data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO companies (id, name, status) VALUES (42, 'Preserved company', 'active');`);
    for (let pass = 0; pass < 2; pass++) {
      const columns = db.prepare("PRAGMA table_info(companies)").all();
      db.exec(schema);
      db.exec(companyUpgrade(columns));
      db.exec(migration);
    }
    const company = db.prepare("SELECT * FROM companies WHERE id = 42").get()!;
    assert.equal(company.name, "Preserved company");
    assert.equal(company.status, "active");
    assert.equal(company.slug, null);
    assert.deepEqual(JSON.parse(String(company.business_hours)).mon, ["09:00", "18:00"]);
    db.exec("UPDATE companies SET slug = 'preserved' WHERE id = 42");
    assert.throws(() => db.exec("INSERT INTO companies (id, name, status, slug) VALUES (43, 'Other', 'active', 'preserved')"), /UNIQUE/);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { db.close(); }
});

test("legacy migration keeps IDs, links and counters and is repeatable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(schema);
    db.exec(`
      INSERT INTO clients (id, name) VALUES (42, 'Existing client');
      INSERT INTO staff (id, name) VALUES (12, 'Existing staff');
      INSERT INTO services (id, name) VALUES (9, 'Existing service');
      INSERT INTO appointments (id, identifier, client_id, staff_id) VALUES (83, 'APT-81', 42, 12);
      INSERT INTO appointment_services (id, appointment_id, service_id) VALUES (7, 83, 9);
      INSERT INTO appointment_notes (id, appointment_id, content) VALUES (18, 83, 'History');
      INSERT INTO blocked_slots (id, staff_id, blocked_date, start_time, end_time) VALUES (21, 12, '2026-01-01', '10:00', '11:00');
      INSERT INTO products (id, name) VALUES (33, 'Existing product');
      INSERT INTO _meta (key, value) VALUES ('appointment_counter', '92');
    `);
    db.exec(migration);
    db.exec(schema);
    db.exec(migration);
    assert.deepEqual(db.prepare("SELECT id, name, status FROM companies").all().map((row) => ({ ...row })), [{ id: 1, name: "Empresa existente", status: "active" }]);
    for (const type of types) {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_ownership WHERE resource_type = ? AND company_id = 1").get(type)?.count, 1, type);
    }
    assert.equal(db.prepare("SELECT value FROM _meta WHERE key = 'appointment_counter'").get()?.value, "92");
    assert.equal(db.prepare("SELECT client_id, staff_id FROM appointments WHERE id = 83").get()?.client_id, 42);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    db.exec(`
      INSERT INTO companies (name, status) VALUES ('Second', 'active');
      INSERT INTO clients (id, name) VALUES (43, 'Second client');
      INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES ('clients', 43, 2);
      INSERT INTO appointments (id, identifier, client_id, staff_id) VALUES (84, 'APT-82', 43, NULL);
      INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES ('appointments', 84, 2);
      INSERT INTO products (id, name) VALUES (34, 'Unowned external row');
    `);
    db.exec(migration);
    assert.equal(db.prepare("SELECT company_id FROM tenant_ownership WHERE resource_type = 'appointments' AND resource_id = 84").get()?.company_id, 2);
    assert.equal(db.prepare("SELECT company_id FROM tenant_ownership WHERE resource_type = 'clients' AND resource_id = 43").get()?.company_id, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_ownership WHERE resource_type = 'products' AND resource_id = 34").get()?.count, 0,
      "a rerun must not assign unknown multi-company data to the legacy tenant");
  } finally { db.close(); }
});

test("empty database migration does not create a company or demo records", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema);
    db.exec(migration);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM companies").get()?.count, 0);
    for (const type of types) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${type}`).get()?.count, 0, type);
    }
    assert.equal(db.prepare("SELECT value FROM _meta WHERE key = 'appointment_counter'").get()?.value, "0");
  } finally { db.close(); }
});

test("missing counter is recovered from legacy identifiers", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema);
    db.exec("INSERT INTO clients (id, name) VALUES (1, 'Existing client')");
    db.exec("INSERT INTO appointments (identifier, client_id) VALUES ('APT-43', 1)");
    db.exec(migration);
    assert.equal(db.prepare("SELECT value FROM _meta WHERE key = 'appointment_counter'").get()?.value, "43");
  } finally { db.close(); }
});
