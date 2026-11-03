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
  working_hours TEXT DEFAULT NULL,
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
  -- Public booking link. NULL while the owner has not chosen one; several
  -- companies may stay unlisted side by side.
  slug TEXT UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  public_email TEXT NOT NULL DEFAULT '',
  social_links TEXT NOT NULL DEFAULT '{}',
  website TEXT NOT NULL DEFAULT '',
  -- Weekday-to-window JSON, e.g. {"mon":["09:00","18:00"],"sun":null}.
  business_hours TEXT NOT NULL DEFAULT '{"mon":["09:00","18:00"],"tue":["09:00","18:00"],"wed":["09:00","18:00"],"thu":["09:00","18:00"],"fri":["09:00","18:00"],"sat":["09:00","18:00"],"sun":null}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Logos are bounded, validated raster bytes, never external URLs or SVG.
-- Appearance and cover publish in one statement; an absent row uses client/server defaults.
CREATE TABLE IF NOT EXISTS company_booking_appearance (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  bytes BLOB,
  content_type TEXT,
  revision TEXT
);

CREATE TABLE IF NOT EXISTS company_logos (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL CHECK (typeof(bytes) = 'blob' AND length(bytes) BETWEEN 1 AND 524288),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  revision TEXT NOT NULL
);
-- Federated Google identities for public bookings. One row per (provider,
-- provider account); `email` mirrors the verified address of that account.
CREATE TABLE IF NOT EXISTS oauth_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_account_id)
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
-- Explicit qualifications only: legacy staff deliberately receive no mappings.
CREATE TABLE IF NOT EXISTS staff_services (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, staff_id, service_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_services_service ON staff_services(company_id, service_id, staff_id);
CREATE TRIGGER IF NOT EXISTS check_staff_service_owner BEFORE INSERT ON staff_services
BEGIN
  SELECT RAISE(ABORT, 'staff service must belong to company') WHERE NOT EXISTS (
    SELECT 1 FROM tenant_ownership st JOIN tenant_ownership sv ON sv.resource_type = 'services'
      AND sv.resource_id = NEW.service_id AND sv.company_id = st.company_id
    WHERE st.resource_type = 'staff' AND st.resource_id = NEW.staff_id AND st.company_id = NEW.company_id);
END;
CREATE TRIGGER IF NOT EXISTS immutable_staff_service BEFORE UPDATE ON staff_services
BEGIN
  SELECT RAISE(ABORT, 'staff service mapping is immutable');
END;
CREATE TRIGGER IF NOT EXISTS clean_staff_service_ownership AFTER DELETE ON tenant_ownership
BEGIN
  DELETE FROM staff_services WHERE company_id = OLD.company_id AND
    ((OLD.resource_type = 'staff' AND staff_id = OLD.resource_id) OR
     (OLD.resource_type = 'services' AND service_id = OLD.resource_id));
END;
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
-- An admission row is inserted and removed in the public booking D1 batch.
-- The trigger sees the latest committed schedule, not an earlier HTTP read.
-- Staff's explicit allow_conflict policy is intentionally unaffected.
CREATE TABLE IF NOT EXISTS public_booking_admission (
  id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  service_id INTEGER REFERENCES services(id),
  scheduled_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS admit_public_booking BEFORE INSERT ON public_booking_admission
BEGIN
  SELECT RAISE(ABORT, 'public booking conflict') WHERE NOT EXISTS (
    SELECT 1 FROM staff s JOIN tenant_ownership o ON o.resource_type = 'staff' AND o.resource_id = s.id
    JOIN companies c ON c.id = o.company_id
    WHERE s.id = NEW.staff_id AND s.active = 1 AND c.id = NEW.company_id AND c.status = 'active');
  SELECT RAISE(ABORT, 'public booking conflict') WHERE EXISTS (
    SELECT 1 FROM appointments a JOIN tenant_ownership o ON o.resource_type = 'appointments' AND o.resource_id = a.id
    WHERE o.company_id = NEW.company_id AND a.staff_id = NEW.staff_id AND a.scheduled_date = NEW.scheduled_date
      AND a.status != 'cancelled' AND a.start_time < NEW.end_time AND a.end_time > NEW.start_time);
  SELECT RAISE(ABORT, 'public booking conflict') WHERE EXISTS (
    SELECT 1 FROM blocked_slots b JOIN tenant_ownership o ON o.resource_type = 'blocked_slots' AND o.resource_id = b.id
    WHERE o.company_id = NEW.company_id AND b.staff_id = NEW.staff_id AND b.blocked_date = NEW.scheduled_date
      AND b.start_time < NEW.end_time AND b.end_time > NEW.start_time);
END;
-- Public-only qualification guard; manual tenant bookings retain their policy.
CREATE TRIGGER IF NOT EXISTS admit_public_booking_service_v1 BEFORE INSERT ON public_booking_admission
BEGIN
  SELECT RAISE(ABORT, 'public booking conflict') WHERE NOT EXISTS (
    SELECT 1 FROM staff_services ss
    JOIN services sv ON sv.id = ss.service_id AND sv.active = 1
    JOIN tenant_ownership so ON so.resource_type = 'services' AND so.resource_id = sv.id AND so.company_id = ss.company_id
    WHERE ss.company_id = NEW.company_id AND ss.staff_id = NEW.staff_id AND ss.service_id = NEW.service_id);
END;
-- The additional guard is versioned so upgrading an existing database installs
-- it without replacing the conflict/ownership trigger. Legacy pairs stay valid.
CREATE TRIGGER IF NOT EXISTS admit_public_booking_hours_v1 BEFORE INSERT ON public_booking_admission
BEGIN
  SELECT RAISE(ABORT, 'public booking conflict') WHERE NEW.start_time >= NEW.end_time;
  SELECT RAISE(ABORT, 'public booking conflict') WHERE NOT EXISTS (
    WITH source AS (
      SELECT CASE WHEN json_valid(c.business_hours) THEN c.business_hours ELSE '{}' END AS hours,
        '$.' || CASE strftime('%w', NEW.scheduled_date)
          WHEN '0' THEN 'sun' WHEN '1' THEN 'mon' WHEN '2' THEN 'tue'
          WHEN '3' THEN 'wed' WHEN '4' THEN 'thu' WHEN '5' THEN 'fri' WHEN '6' THEN 'sat' END AS path
      FROM companies c WHERE c.id = NEW.company_id
    ), day AS (SELECT json_extract(hours, path) AS intervals FROM source)
    SELECT 1 FROM day, json_each(CASE WHEN json_type(intervals, '$[0]') = 'text'
      THEN json_array(json(intervals)) ELSE intervals END) AS interval
    WHERE json_extract(interval.value, '$[0]') <= NEW.start_time
      AND json_extract(interval.value, '$[1]') >= NEW.end_time
  );
  SELECT RAISE(ABORT, 'public booking conflict') WHERE NOT EXISTS (
    WITH source AS (
      SELECT CASE WHEN json_valid(s.working_hours) THEN s.working_hours ELSE '{}' END AS hours,
        s.working_hours IS NULL AS inherit,
        s.working_hours IS NULL OR json_valid(s.working_hours) AS valid,
        '$.' || CASE strftime('%w', NEW.scheduled_date)
          WHEN '0' THEN 'sun' WHEN '1' THEN 'mon' WHEN '2' THEN 'tue'
          WHEN '3' THEN 'wed' WHEN '4' THEN 'thu' WHEN '5' THEN 'fri' WHEN '6' THEN 'sat' END AS path
      FROM staff s WHERE s.id = NEW.staff_id
    ), day AS (SELECT *, json_extract(hours, path) AS intervals FROM source)
    SELECT 1 FROM day WHERE valid AND (inherit OR (json_type(hours) = 'object' AND json_type(hours, path) IS NULL))
    UNION ALL
    SELECT 1 FROM day, json_each(CASE WHEN json_type(intervals, '$[0]') = 'text'
      THEN json_array(json(intervals)) ELSE intervals END) AS interval
    WHERE valid AND json_extract(interval.value, '$[0]') <= NEW.start_time
      AND json_extract(interval.value, '$[1]') >= NEW.end_time
  );
END;
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
