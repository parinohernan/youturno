-- Clients (customers who book appointments)
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Staff members (stylists, therapists, technicians, etc.)
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  title TEXT DEFAULT '',
  color TEXT NOT NULL DEFAULT '#7c3aed',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Services offered (haircut, massage, manicure, etc.)
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  duration INTEGER NOT NULL DEFAULT 60,
  price REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#6b7280',
  category TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Appointments (bookings)
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'booked',
  scheduled_date TEXT NOT NULL DEFAULT (date('now')),
  start_time TEXT NOT NULL DEFAULT '09:00',
  end_time TEXT NOT NULL DEFAULT '10:00',
  total_price REAL NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurrence_interval TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Services included in an appointment (many-to-many)
CREATE TABLE IF NOT EXISTS appointment_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  price REAL NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL DEFAULT 60
);

-- Appointment notes / activity log
CREATE TABLE IF NOT EXISTS appointment_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Blocked time slots (breaks, days off, lunch, etc.)
CREATE TABLE IF NOT EXISTS blocked_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  blocked_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Products (inventory: shampoo, creams, tools, etc.)
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT DEFAULT '',
  category TEXT DEFAULT '',
  sku TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  low_stock_alert INTEGER NOT NULL DEFAULT 5,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Auto-incrementing identifier counter
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Additive ownership staging: the legacy tables are deliberately not rebuilt.
-- No additional company may be served until every route is tenant-aware.
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tenant_ownership (
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'clients', 'staff', 'services', 'appointments', 'appointment_services',
    'appointment_notes', 'blocked_slots', 'products'
  )),
  resource_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  PRIMARY KEY (resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_tenant_ownership_company ON tenant_ownership(company_id, resource_type);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin', 'tenant')),
  company_id INTEGER REFERENCES companies(id) ON DELETE RESTRICT,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((role = 'superadmin' AND company_id IS NULL) OR role = 'tenant')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_superadmin ON users(role) WHERE role = 'superadmin';
CREATE TABLE IF NOT EXISTS company_onboarding (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS auth_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  subject_id INTEGER REFERENCES users(id),
  company_id INTEGER REFERENCES companies(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS audit_superadmin_bootstrap AFTER INSERT ON users
WHEN NEW.role = 'superadmin'
BEGIN
  INSERT INTO auth_audit (action, subject_id) VALUES ('bootstrap_superadmin', NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_tenant_provision AFTER INSERT ON users
WHEN NEW.role = 'tenant'
BEGIN
  INSERT INTO auth_audit (action, subject_id, company_id) VALUES ('provision_user', NEW.id, NEW.company_id);
END;
CREATE TRIGGER IF NOT EXISTS audit_company_status AFTER UPDATE OF status ON companies
WHEN OLD.status != NEW.status
BEGIN
  INSERT INTO auth_audit (action, company_id) VALUES ('company_' || NEW.status, NEW.id);
END;
CREATE TABLE IF NOT EXISTS login_attempts (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
-- Cascading SQLite deletes also fire these triggers, so sidecar rows cannot
-- outlive a deleted resource and be mistaken for a future resource ID.
CREATE TRIGGER IF NOT EXISTS clean_client_ownership AFTER DELETE ON clients BEGIN
  DELETE FROM tenant_ownership WHERE resource_type = 'clients' AND resource_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS clean_staff_ownership AFTER DELETE ON staff BEGIN
  DELETE FROM tenant_ownership WHERE resource_type = 'staff' AND resource_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS clean_service_ownership AFTER DELETE ON services BEGIN
  DELETE FROM tenant_ownership WHERE resource_type = 'services' AND resource_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS clean_appointment_ownership AFTER DELETE ON appointments BEGIN
  DELETE FROM tenant_ownership WHERE resource_type = 'appointments' AND resource_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS clean_appointment_service_ownership AFTER DELETE ON appointment_services BEGIN
  DELETE FROM tenant_ownership WHERE resource_type = 'appointment_services' AND resource_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS clean_appointment_note_ownership AFTER DELETE ON appointment_notes BEGIN
  DELETE FROM tenant_ownership WHERE resource_type = 'appointment_notes' AND resource_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS clean_blocked_slot_ownership AFTER DELETE ON blocked_slots BEGIN
  DELETE FROM tenant_ownership WHERE resource_type = 'blocked_slots' AND resource_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS clean_product_ownership AFTER DELETE ON products BEGIN
  DELETE FROM tenant_ownership WHERE resource_type = 'products' AND resource_id = OLD.id;
END;
-- Ownership is attached only after each resource INSERT. The mapping insert
-- validates same-company references inside the same D1 batch transaction.
CREATE TRIGGER IF NOT EXISTS check_appointment_owner BEFORE INSERT ON tenant_ownership
WHEN NEW.resource_type = 'appointments'
BEGIN
  SELECT RAISE(ABORT, 'appointment client must belong to company') WHERE NOT EXISTS (
    SELECT 1 FROM appointments a JOIN tenant_ownership co ON co.resource_type = 'clients'
      AND co.resource_id = a.client_id AND co.company_id = NEW.company_id
    WHERE a.id = NEW.resource_id);
  SELECT RAISE(ABORT, 'appointment staff must belong to company') WHERE EXISTS (
    SELECT 1 FROM appointments a WHERE a.id = NEW.resource_id AND a.staff_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM tenant_ownership so WHERE so.resource_type = 'staff'
        AND so.resource_id = a.staff_id AND so.company_id = NEW.company_id));
END;
CREATE TRIGGER IF NOT EXISTS check_appointment_service_owner BEFORE INSERT ON tenant_ownership
WHEN NEW.resource_type = 'appointment_services'
BEGIN
  SELECT RAISE(ABORT, 'appointment service must belong to company') WHERE NOT EXISTS (
    SELECT 1 FROM appointment_services aps
    JOIN tenant_ownership ao ON ao.resource_type = 'appointments' AND ao.resource_id = aps.appointment_id AND ao.company_id = NEW.company_id
    JOIN tenant_ownership so ON so.resource_type = 'services' AND so.resource_id = aps.service_id AND so.company_id = NEW.company_id
    WHERE aps.id = NEW.resource_id);
END;
CREATE TRIGGER IF NOT EXISTS check_appointment_note_owner BEFORE INSERT ON tenant_ownership
WHEN NEW.resource_type = 'appointment_notes'
BEGIN
  SELECT RAISE(ABORT, 'appointment note must belong to company') WHERE NOT EXISTS (
    SELECT 1 FROM appointment_notes n JOIN tenant_ownership ao
    ON ao.resource_type = 'appointments' AND ao.resource_id = n.appointment_id AND ao.company_id = NEW.company_id
    WHERE n.id = NEW.resource_id);
END;
CREATE TRIGGER IF NOT EXISTS check_blocked_slot_owner BEFORE INSERT ON tenant_ownership
WHEN NEW.resource_type = 'blocked_slots'
BEGIN
  SELECT RAISE(ABORT, 'blocked slot staff must belong to company') WHERE NOT EXISTS (
    SELECT 1 FROM blocked_slots b JOIN tenant_ownership so
    ON so.resource_type = 'staff' AND so.resource_id = b.staff_id AND so.company_id = NEW.company_id
    WHERE b.id = NEW.resource_id);
END;
CREATE TRIGGER IF NOT EXISTS check_appointment_links BEFORE UPDATE OF client_id, staff_id ON appointments
WHEN EXISTS (SELECT 1 FROM tenant_ownership ao WHERE ao.resource_type = 'appointments' AND ao.resource_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'appointment client must belong to company') WHERE NOT EXISTS (
    SELECT 1 FROM tenant_ownership ao JOIN tenant_ownership co ON co.resource_type = 'clients'
      AND co.resource_id = NEW.client_id AND co.company_id = ao.company_id
    WHERE ao.resource_type = 'appointments' AND ao.resource_id = OLD.id);
  SELECT RAISE(ABORT, 'appointment staff must belong to company') WHERE NEW.staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tenant_ownership ao JOIN tenant_ownership so ON so.resource_type = 'staff'
      AND so.resource_id = NEW.staff_id AND so.company_id = ao.company_id
    WHERE ao.resource_type = 'appointments' AND ao.resource_id = OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS check_service_links BEFORE UPDATE OF appointment_id, service_id ON appointment_services
WHEN EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'appointment_services' AND o.resource_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'appointment service must belong to company') WHERE NOT EXISTS (
    SELECT 1 FROM tenant_ownership owner
    JOIN tenant_ownership ao ON ao.resource_type = 'appointments' AND ao.resource_id = NEW.appointment_id AND ao.company_id = owner.company_id
    JOIN tenant_ownership so ON so.resource_type = 'services' AND so.resource_id = NEW.service_id AND so.company_id = owner.company_id
    WHERE owner.resource_type = 'appointment_services' AND owner.resource_id = OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS check_note_link BEFORE UPDATE OF appointment_id ON appointment_notes
WHEN EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'appointment_notes' AND o.resource_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'appointment note must belong to company') WHERE NOT EXISTS (
    SELECT 1 FROM tenant_ownership owner JOIN tenant_ownership ao
    ON ao.resource_type = 'appointments' AND ao.resource_id = NEW.appointment_id AND ao.company_id = owner.company_id
    WHERE owner.resource_type = 'appointment_notes' AND owner.resource_id = OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS check_blocked_slot_link BEFORE UPDATE OF staff_id ON blocked_slots
WHEN EXISTS (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'blocked_slots' AND o.resource_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'blocked slot staff must belong to company') WHERE NOT EXISTS (
    SELECT 1 FROM tenant_ownership owner JOIN tenant_ownership so
    ON so.resource_type = 'staff' AND so.resource_id = NEW.staff_id AND so.company_id = owner.company_id
    WHERE owner.resource_type = 'blocked_slots' AND owner.resource_id = OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS prevent_ownership_transfer BEFORE UPDATE OF resource_type, resource_id, company_id ON tenant_ownership
BEGIN
  SELECT RAISE(ABORT, 'resource ownership is immutable');
END;
-- Clawnify applies this file as DDL only. Existing data and counters are
-- staged explicitly by migrate-legacy.sql; requests never insert demo rows.

-- Indexes
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id);
CREATE INDEX IF NOT EXISTS idx_appointments_staff ON appointments(staff_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointment_services_apt ON appointment_services(appointment_id);
CREATE INDEX IF NOT EXISTS idx_appointment_notes_apt ON appointment_notes(appointment_id);
CREATE INDEX IF NOT EXISTS idx_blocked_slots_staff ON blocked_slots(staff_id);
CREATE INDEX IF NOT EXISTS idx_blocked_slots_date ON blocked_slots(blocked_date);
CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);
