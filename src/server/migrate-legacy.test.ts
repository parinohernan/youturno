import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("./migrate-legacy.sql", import.meta.url), "utf8");
const types = ["clients", "staff", "services", "appointments", "appointment_services", "appointment_notes", "blocked_slots", "products"];

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
