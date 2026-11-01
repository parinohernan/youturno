-- Explicit, repeatable staging migration for an existing single-company database.
-- Apply schema.sql first. Never create another company while legacy routes remain in use.
-- The legacy company is created only when at least one business row exists.
INSERT OR IGNORE INTO companies (id, name, status)
SELECT 1, 'Empresa existente', 'active'
WHERE EXISTS (SELECT 1 FROM clients)
   OR EXISTS (SELECT 1 FROM staff)
   OR EXISTS (SELECT 1 FROM services)
   OR EXISTS (SELECT 1 FROM appointments)
   OR EXISTS (SELECT 1 FROM appointment_services)
   OR EXISTS (SELECT 1 FROM appointment_notes)
   OR EXISTS (SELECT 1 FROM blocked_slots)
   OR EXISTS (SELECT 1 FROM products);

INSERT OR IGNORE INTO tenant_ownership (resource_type, resource_id, company_id)
SELECT 'clients', id, 1 FROM clients t WHERE (SELECT COUNT(*) FROM companies) = 1
  AND NOT EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'clients' AND o.resource_id = t.id);
INSERT OR IGNORE INTO tenant_ownership (resource_type, resource_id, company_id)
SELECT 'staff', id, 1 FROM staff t WHERE (SELECT COUNT(*) FROM companies) = 1
  AND NOT EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'staff' AND o.resource_id = t.id);
INSERT OR IGNORE INTO tenant_ownership (resource_type, resource_id, company_id)
SELECT 'services', id, 1 FROM services t WHERE (SELECT COUNT(*) FROM companies) = 1
  AND NOT EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'services' AND o.resource_id = t.id);
INSERT OR IGNORE INTO tenant_ownership (resource_type, resource_id, company_id)
SELECT 'appointments', id, 1 FROM appointments t WHERE (SELECT COUNT(*) FROM companies) = 1
  AND NOT EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'appointments' AND o.resource_id = t.id);
INSERT OR IGNORE INTO tenant_ownership (resource_type, resource_id, company_id)
SELECT 'appointment_services', id, 1 FROM appointment_services t WHERE (SELECT COUNT(*) FROM companies) = 1
  AND NOT EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'appointment_services' AND o.resource_id = t.id);
INSERT OR IGNORE INTO tenant_ownership (resource_type, resource_id, company_id)
SELECT 'appointment_notes', id, 1 FROM appointment_notes t WHERE (SELECT COUNT(*) FROM companies) = 1
  AND NOT EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'appointment_notes' AND o.resource_id = t.id);
INSERT OR IGNORE INTO tenant_ownership (resource_type, resource_id, company_id)
SELECT 'blocked_slots', id, 1 FROM blocked_slots t WHERE (SELECT COUNT(*) FROM companies) = 1
  AND NOT EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'blocked_slots' AND o.resource_id = t.id);
INSERT OR IGNORE INTO tenant_ownership (resource_type, resource_id, company_id)
SELECT 'products', id, 1 FROM products t WHERE (SELECT COUNT(*) FROM companies) = 1
  AND NOT EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'products' AND o.resource_id = t.id);

-- A missing counter must not hand out an identifier already used by old bookings.
INSERT OR IGNORE INTO _meta (key, value) VALUES ('appointment_prefix', 'APT');
INSERT OR IGNORE INTO _meta (key, value)
SELECT 'appointment_counter', CAST(COALESCE(MAX(CAST(SUBSTR(identifier, 5) AS INTEGER)), 0) AS TEXT)
FROM appointments WHERE identifier GLOB 'APT-[0-9]*';

-- Existing company tables need introspection-derived additive upgrades, not
-- unconditional ALTER statements. Preview with pnpm migrate:local; stop the dev
-- server, then apply with --apply --backup /absolute/path/to/new-backup.sql.
-- scripts/public-booking-migration.mjs backs up before schema/column/data work.
