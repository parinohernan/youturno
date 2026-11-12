-- Clients (customers who book appointments)
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  trust_state TEXT NOT NULL DEFAULT 'new' CHECK (trust_state IN ('new', 'returning', 'blocked')),
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
  scheduling_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (scheduling_mode IN ('consecutive', 'fixed', 'service_duration')),
  scheduling_interval INTEGER NOT NULL DEFAULT 30 CHECK (typeof(scheduling_interval) = 'integer' AND scheduling_interval BETWEEN 1 AND 240),
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
  latitude REAL,
  longitude REAL,
  phone TEXT NOT NULL DEFAULT '',
  public_email TEXT NOT NULL DEFAULT '',
  social_links TEXT NOT NULL DEFAULT '{}',
  website TEXT NOT NULL DEFAULT '',
  -- Weekday-to-window JSON, e.g. {"mon":["09:00","18:00"],"sun":null}.
  business_hours TEXT NOT NULL DEFAULT '{"mon":["09:00","18:00"],"tue":["09:00","18:00"],"wed":["09:00","18:00"],"thu":["09:00","18:00"],"fri":["09:00","18:00"],"sat":["09:00","18:00"],"sun":null}',
  allow_unverified_bookings INTEGER NOT NULL DEFAULT 0 CHECK (allow_unverified_bookings IN (0, 1)),
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
-- Only a successful transition to completed promotes a new customer. Ownership
-- must match on both sides; blocked/manual returning states are never changed.
CREATE TRIGGER IF NOT EXISTS promote_completed_customer_v1 AFTER UPDATE OF status ON appointments
WHEN NEW.status = 'completed' AND OLD.status != 'completed'
BEGIN
  UPDATE clients SET trust_state = 'returning', updated_at = datetime('now')
  WHERE id = NEW.client_id AND trust_state = 'new' AND EXISTS (
    SELECT 1 FROM tenant_ownership co JOIN tenant_ownership ao ON ao.company_id = co.company_id
      AND ao.resource_type = 'appointments' AND ao.resource_id = NEW.id
    WHERE co.resource_type = 'clients' AND co.resource_id = clients.id);
END;
CREATE INDEX IF NOT EXISTS idx_tenant_ownership_company ON tenant_ownership(company_id, resource_type);
-- Completed attendance is durable evidence, even after an administrator selects
-- new again. Never infer attendance from cancelled, no-show or expired bookings.
CREATE VIEW IF NOT EXISTS completed_customer_history_v2 AS
SELECT DISTINCT a.client_id, ao.company_id FROM appointments a
JOIN tenant_ownership ao ON ao.resource_type = 'appointments' AND ao.resource_id = a.id
JOIN tenant_ownership co ON co.resource_type = 'clients' AND co.resource_id = a.client_id AND co.company_id = ao.company_id
WHERE a.status = 'completed';
CREATE TRIGGER IF NOT EXISTS normalize_customer_trust_v2 AFTER UPDATE OF trust_state ON clients
WHEN NEW.trust_state = 'new'
BEGIN
  UPDATE clients SET trust_state = 'returning' WHERE id = NEW.id
    AND EXISTS (SELECT 1 FROM completed_customer_history_v2 h WHERE h.client_id = NEW.id);
END;
-- Imports and ordinary creation attach ownership after inserting the resource.
CREATE TRIGGER IF NOT EXISTS normalize_owned_customer_v2 AFTER INSERT ON tenant_ownership
WHEN NEW.resource_type IN ('clients', 'appointments')
BEGIN
  UPDATE clients SET trust_state = 'returning' WHERE trust_state = 'new'
    AND EXISTS (SELECT 1 FROM completed_customer_history_v2 h WHERE h.client_id = clients.id AND h.company_id = NEW.company_id)
    AND (NEW.resource_type = 'clients' AND clients.id = NEW.resource_id OR NEW.resource_type = 'appointments'
      AND clients.id = (SELECT client_id FROM appointments WHERE id = NEW.resource_id));
END;
-- Idempotent reconciliation changes only the explicitly approved trust flag.
UPDATE clients SET trust_state = 'returning' WHERE trust_state = 'new'
  AND EXISTS (SELECT 1 FROM completed_customer_history_v2 h WHERE h.client_id = clients.id);
-- One database-clock definition shared by advisory eligibility and atomic admission.
CREATE VIEW IF NOT EXISTS public_customer_policy_v2 AS
SELECT co.company_id, lower(trim(c.email)) AS email,
  max(c.trust_state = 'blocked') AS blocked,
  max(c.trust_state = 'returning' OR EXISTS (SELECT 1 FROM completed_customer_history_v2 h
    WHERE h.client_id = c.id AND h.company_id = co.company_id)) AS is_returning,
  max(EXISTS (SELECT 1 FROM appointments a JOIN tenant_ownership ao
    ON ao.resource_type = 'appointments' AND ao.resource_id = a.id AND ao.company_id = co.company_id
    WHERE a.client_id = c.id AND a.status IN ('booked', 'confirmed', 'in_progress')
      AND julianday(a.scheduled_date || ' ' || a.end_time) > julianday('now'))) AS active
 FROM clients c JOIN tenant_ownership co ON co.resource_type = 'clients' AND co.resource_id = c.id
 GROUP BY co.company_id, lower(trim(c.email));
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
-- A sidecar restricts an existing tenant identity without rebuilding users' role
-- CHECK. A deleted staff member leaves the restriction intact (NULL => denied).
CREATE TABLE IF NOT EXISTS professional_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  staff_id INTEGER UNIQUE REFERENCES staff(id) ON DELETE SET NULL
);
CREATE TRIGGER IF NOT EXISTS check_professional_account_insert BEFORE INSERT ON professional_accounts
BEGIN
  SELECT RAISE(ABORT, 'invalid professional binding') WHERE NOT EXISTS (
    SELECT 1 FROM users u JOIN tenant_ownership o ON o.company_id = u.company_id
      AND o.resource_type = 'staff' AND o.resource_id = NEW.staff_id
    WHERE u.id = NEW.user_id AND u.role = 'tenant' AND u.company_id = NEW.company_id);
END;
CREATE TRIGGER IF NOT EXISTS check_professional_account_update BEFORE UPDATE ON professional_accounts
WHEN NEW.staff_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid professional binding') WHERE NOT EXISTS (
    SELECT 1 FROM users u JOIN tenant_ownership o ON o.company_id = u.company_id
      AND o.resource_type = 'staff' AND o.resource_id = NEW.staff_id
    WHERE u.id = NEW.user_id AND u.role = 'tenant' AND u.company_id = NEW.company_id);
END;
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
-- Immutable action history and its updates commit together. This guard is
-- separate from public cadence and does not change administrators' override policy.
CREATE TABLE IF NOT EXISTS professional_appointment_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  session_version INTEGER NOT NULL,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('completed', 'cancelled', 'reschedule')),
  old_status TEXT NOT NULL,
  old_date TEXT NOT NULL,
  old_start TEXT NOT NULL,
  old_end TEXT NOT NULL,
  new_date TEXT NOT NULL,
  new_start TEXT NOT NULL,
  new_end TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS admit_professional_change BEFORE INSERT ON professional_appointment_changes
BEGIN
  SELECT RAISE(ABORT, 'professional change conflict') WHERE NOT EXISTS (
    SELECT 1 FROM appointments a
    JOIN tenant_ownership o ON o.resource_type = 'appointments' AND o.resource_id = a.id
    JOIN professional_accounts pa ON pa.staff_id = a.staff_id AND pa.company_id = o.company_id
    JOIN users u ON u.id = pa.user_id AND u.company_id = pa.company_id AND u.role = 'tenant'
    JOIN companies c ON c.id = pa.company_id AND c.status = 'active'
    JOIN staff s ON s.id = pa.staff_id AND s.active = 1
    JOIN tenant_ownership so ON so.resource_type = 'staff' AND so.resource_id = s.id AND so.company_id = c.id
    WHERE a.id = NEW.appointment_id AND pa.user_id = NEW.actor_id AND u.session_version = NEW.session_version
      AND a.status IN ('booked', 'confirmed', 'in_progress') AND a.status = NEW.old_status
      AND a.scheduled_date = NEW.old_date AND a.start_time = NEW.old_start AND a.end_time = NEW.old_end);
  SELECT RAISE(ABORT, 'professional change conflict') WHERE NEW.action != 'reschedule' AND
    (NEW.new_date != NEW.old_date OR NEW.new_start != NEW.old_start OR NEW.new_end != NEW.old_end);
END;
CREATE TRIGGER IF NOT EXISTS admit_professional_reschedule BEFORE INSERT ON professional_appointment_changes
WHEN NEW.action = 'reschedule'
BEGIN
  SELECT RAISE(ABORT, 'professional change conflict') WHERE
    NEW.new_date != date(NEW.new_date, '+0 days') OR date(NEW.new_date, '+0 days') IS NULL
    OR NEW.new_start NOT GLOB '[0-2][0-9]:[0-5][0-9]' OR NEW.new_start >= '24:00'
    OR NEW.new_end NOT GLOB '[0-2][0-9]:[0-5][0-9]' OR NEW.new_end >= '24:00'
    OR NEW.new_end <= NEW.new_start
    OR julianday(NEW.new_date || ' ' || NEW.new_start) < julianday('now')
    OR (strftime('%s', '2000-01-01 ' || NEW.new_end) - strftime('%s', '2000-01-01 ' || NEW.new_start)) !=
       (strftime('%s', '2000-01-01 ' || NEW.old_end) - strftime('%s', '2000-01-01 ' || NEW.old_start));
  SELECT RAISE(ABORT, 'professional change conflict') WHERE NOT EXISTS
    (SELECT 1 FROM appointment_services WHERE appointment_id = NEW.appointment_id)
    OR EXISTS (
      SELECT 1 FROM appointment_services aps JOIN professional_accounts pa ON pa.user_id = NEW.actor_id
      WHERE aps.appointment_id = NEW.appointment_id AND NOT EXISTS (
        SELECT 1 FROM staff_services ss JOIN services sv ON sv.id = ss.service_id AND sv.active = 1
        JOIN tenant_ownership so ON so.resource_type = 'services' AND so.resource_id = sv.id AND so.company_id = pa.company_id
        JOIN tenant_ownership ao ON ao.resource_type = 'appointment_services' AND ao.resource_id = aps.id AND ao.company_id = pa.company_id
        WHERE ss.company_id = pa.company_id AND ss.staff_id = pa.staff_id AND ss.service_id = aps.service_id));
  SELECT RAISE(ABORT, 'professional change conflict') WHERE EXISTS (
    SELECT 1 FROM appointments a JOIN professional_accounts pa ON pa.staff_id = a.staff_id
    JOIN tenant_ownership o ON o.resource_type = 'appointments' AND o.resource_id = a.id AND o.company_id = pa.company_id
    WHERE pa.user_id = NEW.actor_id AND a.id != NEW.appointment_id AND a.status != 'cancelled'
      AND a.scheduled_date = NEW.new_date AND a.start_time < NEW.new_end AND a.end_time > NEW.new_start);
  SELECT RAISE(ABORT, 'professional change conflict') WHERE EXISTS (
    SELECT 1 FROM blocked_slots b JOIN professional_accounts pa ON pa.staff_id = b.staff_id
    JOIN tenant_ownership o ON o.resource_type = 'blocked_slots' AND o.resource_id = b.id AND o.company_id = pa.company_id
    WHERE pa.user_id = NEW.actor_id AND b.blocked_date = NEW.new_date AND b.start_time < NEW.new_end AND b.end_time > NEW.new_start);
  SELECT RAISE(ABORT, 'professional change conflict') WHERE NOT EXISTS (
    WITH source AS (
      SELECT CASE WHEN json_valid(c.business_hours) THEN c.business_hours ELSE '{}' END AS company_hours,
        CASE WHEN json_valid(s.working_hours) THEN s.working_hours ELSE '{}' END AS personal_hours,
        s.working_hours IS NULL OR (json_valid(s.working_hours) AND json_type(CASE WHEN json_valid(s.working_hours) THEN s.working_hours ELSE '{}' END) = 'object') AS valid_personal,
        '$.' || CASE strftime('%w', NEW.new_date) WHEN '0' THEN 'sun' WHEN '1' THEN 'mon' WHEN '2' THEN 'tue'
          WHEN '3' THEN 'wed' WHEN '4' THEN 'thu' WHEN '5' THEN 'fri' WHEN '6' THEN 'sat' END AS path
      FROM professional_accounts pa JOIN companies c ON c.id = pa.company_id JOIN staff s ON s.id = pa.staff_id
      WHERE pa.user_id = NEW.actor_id
    ), days AS (
      SELECT *, json_extract(company_hours, path) AS company_day,
        CASE WHEN json_type(personal_hours, path) IS NULL THEN json_extract(company_hours, path)
          ELSE json_extract(personal_hours, path) END AS personal_day FROM source
    )
    SELECT 1 FROM days,
      json_each(CASE WHEN json_type(company_day, '$[0]') = 'text' THEN json_array(json(company_day)) ELSE company_day END) c,
      json_each(CASE WHEN json_type(personal_day, '$[0]') = 'text' THEN json_array(json(personal_day)) ELSE personal_day END) p
    WHERE valid_personal AND max(json_extract(c.value, '$[0]'), json_extract(p.value, '$[0]')) <= NEW.new_start
      AND min(json_extract(c.value, '$[1]'), json_extract(p.value, '$[1]')) >= NEW.new_end);
END;
CREATE TRIGGER IF NOT EXISTS apply_professional_change AFTER INSERT ON professional_appointment_changes
BEGIN
  UPDATE appointments SET status = CASE WHEN NEW.action = 'reschedule' THEN status ELSE NEW.action END,
    scheduled_date = NEW.new_date, start_time = NEW.new_start, end_time = NEW.new_end, updated_at = datetime('now')
    WHERE id = NEW.appointment_id;
END;
CREATE TRIGGER IF NOT EXISTS immutable_professional_change BEFORE UPDATE ON professional_appointment_changes
BEGIN
  SELECT RAISE(ABORT, 'professional history is immutable');
END;
-- An admission row is inserted and removed in the public booking D1 batch.
-- The trigger sees the latest committed schedule, not an earlier HTTP read.
-- Staff's explicit allow_conflict policy is intentionally unaffected.
CREATE TABLE IF NOT EXISTS public_booking_admission (
  id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  service_id INTEGER REFERENCES services(id),
  customer_email TEXT,
  scheduled_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);
-- A phone is never proof of identity. This ledger only prevents repeat anonymous
-- reservations; it cannot be exchanged for a customer session or appointment access.
CREATE TABLE IF NOT EXISTS unverified_booking_phones (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  phone_digits TEXT NOT NULL,
  client_id INTEGER NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, phone_digits)
);
-- Persistent, bounded hourly counters; no raw network addresses are stored.
CREATE TABLE IF NOT EXISTS unverified_booking_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
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
-- Email is normalized from the signed Google session, never request input.
-- Check before find/create in the SAME batch: concurrent first bookings cannot
-- both pass. Count all same-company matching files, including legacy duplicates.
DROP TRIGGER IF EXISTS admit_public_customer_v1;
CREATE TRIGGER IF NOT EXISTS admit_public_customer_v2 BEFORE INSERT ON public_booking_admission
WHEN NEW.customer_email IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'public customer blocked') WHERE EXISTS (
    SELECT 1 FROM public_customer_policy_v2 WHERE company_id = NEW.company_id AND email = NEW.customer_email AND blocked);
  SELECT RAISE(ABORT, 'public customer active limit') WHERE EXISTS (
    SELECT 1 FROM public_customer_policy_v2 WHERE company_id = NEW.company_id AND email = NEW.customer_email AND NOT is_returning AND active);
END;
CREATE TRIGGER IF NOT EXISTS reserve_unverified_phone_v1 BEFORE INSERT ON unverified_booking_phones
BEGIN
  SELECT RAISE(ABORT, 'unverified phone unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM companies WHERE id = NEW.company_id AND status = 'active' AND allow_unverified_bookings = 1);
  SELECT RAISE(ABORT, 'unverified phone unavailable') WHERE EXISTS (
    SELECT 1 FROM clients c JOIN tenant_ownership o ON o.resource_type = 'clients' AND o.resource_id = c.id
    WHERE o.company_id = NEW.company_id AND replace(replace(replace(replace(replace(trim(c.phone), '+', ''), ' ', ''), '(', ''), ')', ''), '-', '') = NEW.phone_digits
      AND c.id != NEW.client_id);
  SELECT RAISE(ABORT, 'unverified phone unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM tenant_ownership o JOIN clients c ON c.id = o.resource_id
    WHERE o.company_id = NEW.company_id AND o.resource_type = 'clients' AND o.resource_id = NEW.client_id
      AND c.email = '' AND replace(c.phone, '+', '') = NEW.phone_digits);
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
-- Re-evaluate the public start policy inside the admission transaction. Candidate
-- boundaries suffice for earliest-fit: opening, busy ends and the current minute
-- ceiling. Busy gaps do not become separate working intervals. No minute grid
-- is imposed on consecutive mode; fixed mode retains midnight alignment.
CREATE TRIGGER IF NOT EXISTS admit_public_booking_policy_v1 BEFORE INSERT ON public_booking_admission
BEGIN
  SELECT RAISE(ABORT, 'public booking conflict') WHERE NOT EXISTS (
    WITH source AS (
      SELECT s.scheduling_mode AS mode, s.scheduling_interval AS cadence, sv.duration,
        CAST(substr(NEW.start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(NEW.start_time, 4, 2) AS INTEGER) AS requested,
        CASE WHEN json_valid(c.business_hours) THEN c.business_hours ELSE '{}' END AS company_hours,
        CASE WHEN json_valid(s.working_hours) THEN s.working_hours ELSE '{}' END AS personal_hours,
        s.working_hours IS NULL AS inherit,
        '$.' || CASE strftime('%w', NEW.scheduled_date)
          WHEN '0' THEN 'sun' WHEN '1' THEN 'mon' WHEN '2' THEN 'tue'
          WHEN '3' THEN 'wed' WHEN '4' THEN 'thu' WHEN '5' THEN 'fri' WHEN '6' THEN 'sat' END AS path
      FROM staff s, companies c, services sv
      WHERE s.id = NEW.staff_id AND c.id = NEW.company_id AND sv.id = NEW.service_id
    ), days AS (
      SELECT *, json_extract(company_hours, path) AS company_day,
        CASE WHEN inherit OR json_type(personal_hours, path) IS NULL
          THEN json_extract(company_hours, path) ELSE json_extract(personal_hours, path) END AS personal_day
      FROM source
    ), pairs AS (
      SELECT max(json_extract(c.value, '$[0]'), json_extract(p.value, '$[0]')) AS opening,
        min(json_extract(c.value, '$[1]'), json_extract(p.value, '$[1]')) AS closing,
        mode, cadence, duration, requested
      FROM days,
        json_each(CASE WHEN json_type(company_day, '$[0]') = 'text' THEN json_array(json(company_day)) ELSE company_day END) c,
        json_each(CASE WHEN json_type(personal_day, '$[0]') = 'text' THEN json_array(json(personal_day)) ELSE personal_day END) p
    ), windows AS (
      SELECT CAST(substr(opening, 1, 2) AS INTEGER) * 60 + CAST(substr(opening, 4, 2) AS INTEGER) AS lo,
        CAST(substr(closing, 1, 2) AS INTEGER) * 60 + CAST(substr(closing, 4, 2) AS INTEGER) AS hi,
        mode, cadence, duration, requested FROM pairs WHERE opening < closing
    ), busy AS (
      SELECT a.start_time AS start, a.end_time AS finish FROM appointments a
      JOIN tenant_ownership o ON o.resource_type = 'appointments' AND o.resource_id = a.id
      WHERE o.company_id = NEW.company_id AND a.staff_id = NEW.staff_id
        AND a.scheduled_date = NEW.scheduled_date AND a.status != 'cancelled'
      UNION ALL
      SELECT b.start_time, b.end_time FROM blocked_slots b
      JOIN tenant_ownership o ON o.resource_type = 'blocked_slots' AND o.resource_id = b.id
      WHERE o.company_id = NEW.company_id AND b.staff_id = NEW.staff_id AND b.blocked_date = NEW.scheduled_date
    ), occupied AS (
      SELECT CAST(substr(start, 1, 2) AS INTEGER) * 60 + CAST(substr(start, 4, 2) AS INTEGER) AS lo,
        CAST(substr(finish, 1, 2) AS INTEGER) * 60 + CAST(substr(finish, 4, 2) AS INTEGER) AS hi FROM busy
    ), boundaries AS (
      SELECT lo AS start FROM windows UNION SELECT hi FROM occupied UNION
      SELECT CAST(strftime('%H', 'now') AS INTEGER) * 60 + CAST(strftime('%M', 'now') AS INTEGER)
        + CASE WHEN CAST(strftime('%f', 'now') AS REAL) > 0 THEN 1 ELSE 0 END
      WHERE NEW.scheduled_date = date('now')
    )
    SELECT 1 FROM windows w
    WHERE duration > 0 AND typeof(duration) = 'integer'
      AND NEW.scheduled_date = date(NEW.scheduled_date, '+0 days')
      AND julianday(NEW.scheduled_date || ' ' || NEW.start_time) >= julianday('now')
      AND NEW.end_time = printf('%02d:%02d', (requested + duration) / 60, (requested + duration) % 60)
      AND requested >= lo AND requested + duration <= hi
      AND ((mode = 'fixed' AND cadence BETWEEN 1 AND 240 AND requested % cadence = 0)
        OR (mode = 'service_duration' AND (requested - lo) % duration = 0)
        OR (mode = 'consecutive' AND requested = (
          SELECT min(start) FROM boundaries
          WHERE start >= w.lo AND start + w.duration <= w.hi
            AND julianday(NEW.scheduled_date || ' ' || printf('%02d:%02d', start / 60, start % 60)) >= julianday('now')
            AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.lo < start + w.duration AND o.hi > start)
        )))
  );
END;
-- Customer actions never reuse professional authority or create a second booking.
-- The snapshot includes every service link so even same-second edits are detected.
CREATE VIEW IF NOT EXISTS customer_appointment_snapshots_v1 AS
SELECT a.id, json_array(a.client_id, a.staff_id, a.status, a.scheduled_date, a.start_time,
  a.end_time, a.total_price, a.updated_at,
  (SELECT json_group_array(json_array(id, service_id, price, duration)) FROM
    (SELECT id, service_id, price, duration FROM appointment_services WHERE appointment_id = a.id ORDER BY id))) AS snapshot
FROM appointments a;
CREATE TABLE IF NOT EXISTS customer_appointment_admission (
  id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  customer_email TEXT NOT NULL,
  expected_snapshot TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('cancel', 'reschedule')),
  scheduled_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);
DROP TRIGGER IF EXISTS admit_customer_appointment_v1;
CREATE TRIGGER IF NOT EXISTS admit_customer_appointment_v2 BEFORE INSERT ON customer_appointment_admission
BEGIN
  SELECT RAISE(ABORT, 'customer appointment changed') WHERE NOT EXISTS (
    SELECT 1 FROM appointments a JOIN customer_appointment_snapshots_v1 v ON v.id = a.id
    JOIN tenant_ownership ao ON ao.resource_type = 'appointments' AND ao.resource_id = a.id AND ao.company_id = NEW.company_id
    JOIN clients cl ON cl.id = a.client_id
    JOIN tenant_ownership co ON co.resource_type = 'clients' AND co.resource_id = cl.id AND co.company_id = NEW.company_id
    JOIN companies c ON c.id = NEW.company_id AND c.status = 'active'
    WHERE a.id = NEW.appointment_id AND lower(trim(cl.email)) = NEW.customer_email
      AND a.status IN ('booked', 'confirmed') AND v.snapshot = NEW.expected_snapshot
      AND julianday(a.scheduled_date || ' ' || a.start_time) > julianday('now')
      AND (a.staff_id IS NULL OR EXISTS (SELECT 1 FROM tenant_ownership so
        WHERE so.resource_type = 'staff' AND so.resource_id = a.staff_id AND so.company_id = NEW.company_id))
      AND NOT EXISTS (SELECT 1 FROM appointment_services aps WHERE aps.appointment_id = a.id AND
        (NOT EXISTS (SELECT 1 FROM tenant_ownership so WHERE so.resource_type = 'services'
          AND so.resource_id = aps.service_id AND so.company_id = NEW.company_id)
        OR NOT EXISTS (SELECT 1 FROM tenant_ownership po WHERE po.resource_type = 'appointment_services'
          AND po.resource_id = aps.id AND po.company_id = NEW.company_id))));
END;
CREATE TRIGGER IF NOT EXISTS deny_unverified_customer_actions_v1 BEFORE INSERT ON customer_appointment_admission
WHEN EXISTS (SELECT 1 FROM appointments a JOIN unverified_booking_phones u ON u.client_id = a.client_id
  WHERE a.id = NEW.appointment_id AND u.company_id = NEW.company_id)
BEGIN
  SELECT RAISE(ABORT, 'customer appointment changed');
END;
CREATE TRIGGER IF NOT EXISTS admit_customer_reschedule_v1 BEFORE INSERT ON customer_appointment_admission
WHEN NEW.action = 'reschedule'
BEGIN
  -- Existing blocked customers may manage their appointment, never gain quota or change trust.
  SELECT RAISE(ABORT, 'customer schedule unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM appointments a JOIN staff s ON s.id = a.staff_id AND s.active = 1
    JOIN tenant_ownership so ON so.resource_type = 'staff' AND so.resource_id = s.id AND so.company_id = NEW.company_id
    WHERE a.id = NEW.appointment_id
      AND EXISTS (SELECT 1 FROM appointment_services WHERE appointment_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM appointment_services aps LEFT JOIN services sv ON sv.id = aps.service_id
        WHERE aps.appointment_id = a.id AND (sv.active IS NOT 1 OR NOT EXISTS (
          SELECT 1 FROM staff_services ss WHERE ss.company_id = NEW.company_id AND ss.staff_id = s.id AND ss.service_id = aps.service_id)))) ;
  SELECT RAISE(ABORT, 'customer schedule unavailable') WHERE EXISTS (
    SELECT 1 FROM appointments a JOIN appointments current ON current.id = NEW.appointment_id
    JOIN tenant_ownership o ON o.resource_type = 'appointments' AND o.resource_id = a.id AND o.company_id = NEW.company_id
    WHERE a.id != current.id AND a.staff_id = current.staff_id AND a.scheduled_date = NEW.scheduled_date
      AND a.status != 'cancelled' AND a.start_time < NEW.end_time AND a.end_time > NEW.start_time);
  SELECT RAISE(ABORT, 'customer schedule unavailable') WHERE EXISTS (
    SELECT 1 FROM blocked_slots b JOIN appointments a ON a.id = NEW.appointment_id
    JOIN tenant_ownership o ON o.resource_type = 'blocked_slots' AND o.resource_id = b.id AND o.company_id = NEW.company_id
    WHERE b.staff_id = a.staff_id AND b.blocked_date = NEW.scheduled_date
      AND b.start_time < NEW.end_time AND b.end_time > NEW.start_time);
  -- Same public cadence rules, using the WHOLE reserved interval, excluding self.
  SELECT RAISE(ABORT, 'customer schedule unavailable') WHERE NOT EXISTS (
    WITH source AS (
      SELECT s.scheduling_mode AS mode, s.scheduling_interval AS cadence,
        (CAST(substr(a.end_time,1,2) AS INTEGER)*60 + CAST(substr(a.end_time,4,2) AS INTEGER)) -
        (CAST(substr(a.start_time,1,2) AS INTEGER)*60 + CAST(substr(a.start_time,4,2) AS INTEGER)) AS duration,
        CAST(substr(NEW.start_time,1,2) AS INTEGER)*60 + CAST(substr(NEW.start_time,4,2) AS INTEGER) AS requested,
        CASE WHEN json_valid(c.business_hours) THEN c.business_hours ELSE '{}' END AS company_hours,
        CASE WHEN json_valid(s.working_hours) THEN s.working_hours ELSE '{}' END AS personal_hours,
        s.working_hours IS NULL AS inherit,
        s.working_hours IS NULL OR (json_valid(s.working_hours) AND json_type(CASE WHEN json_valid(s.working_hours) THEN s.working_hours ELSE '{}' END) = 'object') AS valid_personal,
        '$.' || CASE strftime('%w', NEW.scheduled_date) WHEN '0' THEN 'sun' WHEN '1' THEN 'mon' WHEN '2' THEN 'tue'
          WHEN '3' THEN 'wed' WHEN '4' THEN 'thu' WHEN '5' THEN 'fri' WHEN '6' THEN 'sat' END AS path
      FROM appointments a JOIN staff s ON s.id = a.staff_id JOIN companies c ON c.id = NEW.company_id
      WHERE a.id = NEW.appointment_id
    ), days AS (
      SELECT *, json_extract(company_hours,path) AS company_day,
        CASE WHEN inherit OR json_type(personal_hours,path) IS NULL THEN json_extract(company_hours,path)
          ELSE json_extract(personal_hours,path) END AS personal_day FROM source WHERE valid_personal
    ), pairs AS (
      SELECT max(json_extract(c.value,'$[0]'),json_extract(p.value,'$[0]')) AS opening,
        min(json_extract(c.value,'$[1]'),json_extract(p.value,'$[1]')) AS closing, mode,cadence,duration,requested
      FROM days,
        json_each(CASE WHEN json_type(company_day,'$[0]') = 'text' THEN json_array(json(company_day)) ELSE company_day END) c,
        json_each(CASE WHEN json_type(personal_day,'$[0]') = 'text' THEN json_array(json(personal_day)) ELSE personal_day END) p
    ), windows AS (
      SELECT CAST(substr(opening,1,2) AS INTEGER)*60 + CAST(substr(opening,4,2) AS INTEGER) AS lo,
        CAST(substr(closing,1,2) AS INTEGER)*60 + CAST(substr(closing,4,2) AS INTEGER) AS hi,
        mode,cadence,duration,requested FROM pairs WHERE opening < closing
    ), busy AS (
      SELECT a.start_time AS start,a.end_time AS finish FROM appointments a JOIN appointments current ON current.id = NEW.appointment_id
      JOIN tenant_ownership o ON o.resource_type = 'appointments' AND o.resource_id = a.id AND o.company_id = NEW.company_id
      WHERE a.id != current.id AND a.staff_id = current.staff_id AND a.scheduled_date = NEW.scheduled_date AND a.status != 'cancelled'
      UNION ALL SELECT b.start_time,b.end_time FROM blocked_slots b JOIN appointments a ON a.id = NEW.appointment_id
      JOIN tenant_ownership o ON o.resource_type = 'blocked_slots' AND o.resource_id = b.id AND o.company_id = NEW.company_id
      WHERE b.staff_id = a.staff_id AND b.blocked_date = NEW.scheduled_date
    ), occupied AS (
      SELECT CAST(substr(start,1,2) AS INTEGER)*60 + CAST(substr(start,4,2) AS INTEGER) AS lo,
        CAST(substr(finish,1,2) AS INTEGER)*60 + CAST(substr(finish,4,2) AS INTEGER) AS hi FROM busy
    ), boundaries AS (
      SELECT lo AS start FROM windows UNION SELECT hi FROM occupied UNION
      SELECT CAST(strftime('%H','now') AS INTEGER)*60 + CAST(strftime('%M','now') AS INTEGER)
        + CASE WHEN CAST(strftime('%f','now') AS REAL) > 0 THEN 1 ELSE 0 END WHERE NEW.scheduled_date = date('now')
    )
    SELECT 1 FROM windows w WHERE duration > 0 AND duration < 1440
      AND NEW.scheduled_date = date(NEW.scheduled_date,'+0 days')
      AND julianday(NEW.scheduled_date || ' ' || NEW.start_time) >= julianday('now')
      AND NEW.end_time = printf('%02d:%02d',(requested+duration)/60,(requested+duration)%60)
      AND requested >= lo AND requested+duration <= hi
      AND ((mode = 'fixed' AND cadence BETWEEN 1 AND 240 AND requested % cadence = 0)
        OR (mode = 'service_duration' AND (requested-lo) % duration = 0)
        OR (mode = 'consecutive' AND requested = (SELECT min(start) FROM boundaries
          WHERE start >= w.lo AND start+w.duration <= w.hi
            AND julianday(NEW.scheduled_date || ' ' || printf('%02d:%02d',start/60,start%60)) >= julianday('now')
            AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.lo < start+w.duration AND o.hi > start)))));
END;
CREATE TRIGGER IF NOT EXISTS apply_customer_appointment_v1 AFTER INSERT ON customer_appointment_admission
BEGIN
  UPDATE appointments SET status = CASE WHEN NEW.action = 'cancel' THEN 'cancelled' ELSE status END,
    scheduled_date = CASE WHEN NEW.action = 'reschedule' THEN NEW.scheduled_date ELSE scheduled_date END,
    start_time = CASE WHEN NEW.action = 'reschedule' THEN NEW.start_time ELSE start_time END,
    end_time = CASE WHEN NEW.action = 'reschedule' THEN NEW.end_time ELSE end_time END,
    updated_at = datetime('now') WHERE id = NEW.appointment_id;
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
-- Optional professional portraits. No existing staff or accounts are modified.
CREATE TABLE IF NOT EXISTS staff_photos (
  staff_id INTEGER PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 524288),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  revision TEXT NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS staff_photo_owner_insert BEFORE INSERT ON staff_photos
WHEN NOT EXISTS (SELECT 1 FROM tenant_ownership WHERE resource_type = 'staff' AND resource_id = NEW.staff_id AND company_id = NEW.company_id)
BEGIN SELECT RAISE(ABORT, 'staff photo must belong to company'); END;
CREATE TRIGGER IF NOT EXISTS staff_photo_owner_update BEFORE UPDATE ON staff_photos
WHEN NOT EXISTS (SELECT 1 FROM tenant_ownership WHERE resource_type = 'staff' AND resource_id = NEW.staff_id AND company_id = NEW.company_id)
BEGIN SELECT RAISE(ABORT, 'staff photo must belong to company'); END;
