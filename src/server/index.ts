import { createApp, createRoute, z } from "@clawnify/app";
import { query, get, run } from "./db.js";
import { findConflicts, describeConflicts, toMinutes, slotStarts, minutesToTime, parseBusinessHours, windowsOnDate, effectiveWindows, effectiveWeeklyHours, fitsWindows, normalizeHours, weekdayOf, type Busy } from "./scheduling.js";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { COOKIE, CUSTOMER_COOKIE, CUSTOMER_STATE_COOKIE, CUSTOMER_SECONDS, hashPassword, verifyPassword,
  signToken, verifyToken, signCustomerToken, verifyCustomerToken, signCustomerState, verifyCustomerState, randomNonce,
  safeEqual, type Token, type CustomerClaims } from "./auth.js";

type Actor = { id: number; email: string; role: "superadmin" | "tenant"; company_id: number | null; session_version: number; company_name: string | null; company_status: string | null };
type D1Statement = { bind(...values: (number | string | null)[]): D1Statement };
type D1Database = { prepare(sql: string): D1Statement; batch(statements: D1Statement[]): Promise<{ meta: { changes: number } }[]> };
type Env = { Bindings: { DB: D1Database; AUTH_SECRET: string; APP_ORIGIN?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string }; Variables: { actor: Actor; claims: Token; customer: CustomerClaims } };

const app = createApp<Env>({
  title: "Youturno",
  version: "1.0.0",
  description: "Appointment scheduling and business management for salons, spas, and other appointment-based businesses.",
});

// A configured secret and a freshly loaded DB actor are required even on the
// old single-company routes. Admin never receives implicit business access.
function originAllowed(c: { req: { header: (name: string) => string | undefined; url: string }; env: Env["Bindings"] }): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  const url = new URL(c.req.url);
  if (c.env.APP_ORIGIN) return origin === c.env.APP_ORIGIN;
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return origin === url.origin && url.protocol === "https:";
  // Vite proxies /api to Wrangler on a different localhost port in development.
  try { const source = new URL(origin); return source.protocol === "http:" && source.hostname === url.hostname &&
    (source.port === url.port || /^517\d$/.test(source.port)); } catch { return false; }
}

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!c.env.AUTH_SECRET || c.env.AUTH_SECRET.length < 32) return c.json({ error: "Servicio no configurado" }, 503);
  const path = new URL(c.req.url).pathname;
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  if (mutation && (!originAllowed(c) || !c.req.header("content-type")?.toLowerCase().startsWith("application/json"))) {
    return c.json({ error: "Origen o formato no permitido" }, 403);
  }
  if (path === "/api/auth/login") return next();
  // Public customer flows never carry a staff session. Their mutations are still
  // held to the same origin and content-type rules checked above; the booking
  // endpoints verify the customer cookie themselves.
  if (path.startsWith("/api/public/") || path.startsWith("/api/auth/customer/")) return next();

  const jwt = getCookie(c, COOKIE);
  const claims = jwt ? await verifyToken(c.env.AUTH_SECRET, jwt) : null;
  if (!claims) return c.json({ error: "Iniciá sesión" }, 401);
  const actor = await get<Actor>(`SELECT u.id, u.email, u.role, u.company_id, u.session_version,
    co.name AS company_name, co.status AS company_status FROM users u
    LEFT JOIN companies co ON co.id = u.company_id WHERE u.id = ?`, [claims.sub]);
  if (!actor || actor.session_version !== claims.sv ||
    (actor.role === "tenant" && actor.company_id !== null && !actor.company_status)) return c.json({ error: "Sesión no válida" }, 401);
  c.set("actor", actor);
  c.set("claims", claims);
  if (mutation && !safeEqual(c.req.header("x-csrf-token") || "", claims.csrf)) return c.json({ error: "Token de seguridad inválido" }, 403);
  if (path.startsWith("/api/auth/")) return next();
  if (path.startsWith("/api/admin/")) {
    if (actor.role !== "superadmin") return c.json({ error: "Acceso denegado" }, 403);
    return next();
  }
  if (path === "/api/onboarding/company") {
    if (actor.role !== "tenant" || actor.company_id !== null) return c.json({ error: "La cuenta ya tiene empresa" }, 403);
    return next();
  }
  if (actor.role !== "tenant" || actor.company_status !== "active") return c.json({ error: "Empresa pendiente o inactiva" }, 403);
  await next();
});

const credentials = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(1024) });
const userInput = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(1024) });

app.post("/api/auth/login", async (c) => {
  const parsed = credentials.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Credenciales inválidas" }, 400);
  const email = parsed.data.email.trim().toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const attempts = await get<{ failures: number; locked_until: number }>("SELECT failures, locked_until FROM login_attempts WHERE email = ?", [email]);
  if (attempts && attempts.locked_until > now) return c.json({ error: "Intentá nuevamente más tarde" }, 429);
  const user = await get<Actor & { password_hash: string }>("SELECT id, email, role, company_id, session_version, password_hash FROM users WHERE email = ?", [email]);
  const valid = user && await verifyPassword(parsed.data.password, user.password_hash);
  if (!valid) {
    const failures = attempts?.locked_until && attempts.locked_until <= now ? 1 : (attempts?.failures ?? 0) + 1;
    await run(`INSERT INTO login_attempts (email, failures, locked_until) VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`,
      [email, failures, failures >= 5 ? now + 900 : 0]);
    return c.json({ error: "Credenciales inválidas" }, 401);
  }
  await run("DELETE FROM login_attempts WHERE email = ?", [email]);
  const { jwt, csrf } = await signToken(c.env.AUTH_SECRET, user.id, user.session_version);
  setCookie(c, COOKIE, jwt, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 8 * 60 * 60 });
  return c.json({ ok: true, csrf });
});

app.get("/api/auth/session", (c) => {
  const actor = c.get("actor");
  return c.json({ email: actor.email, role: actor.role, company_id: actor.company_id,
    company_name: actor.company_name, company_status: actor.company_status, csrf: c.get("claims").csrf });
});

app.post("/api/auth/logout", async (c) => {
  await run("UPDATE users SET session_version = session_version + 1 WHERE id = ?", [c.get("actor").id]);
  deleteCookie(c, COOKIE, { secure: true, path: "/" });
  return c.json({ ok: true });
});

// ── Public booking (customer-facing) ───────────────────────────────
//
// End customers book through /book/{slug} in the frontend. These routes carry a
// separate signed identity (CUSTOMER_COOKIE); staff sessions must never grant
// access here and customer cookies must never grant access to staff routes.

const GOOGLE_NOT_CONFIGURED = "Google sign-in is not configured";

/**
 * Where this deployment's frontend (and OAuth consent redirect) lives.
 *
 * Mirrors `originAllowed`: an explicit APP_ORIGIN wins; localhost trusts the
 * request itself in development; everything else must answer over https.
 */
function appBase(c: { req: { url: string }; env: Env["Bindings"] }): string | null {
  const url = new URL(c.req.url);
  if (c.env.APP_ORIGIN) {
    try {
      const configured = new URL(c.env.APP_ORIGIN);
      return configured.origin === c.env.APP_ORIGIN && (configured.protocol === "https:" ||
        (configured.protocol === "http:" && ["localhost", "127.0.0.1"].includes(configured.hostname))) ? configured.origin : null;
    } catch { return null; }
  }
  // Proxy requests have the API port, not the browser's origin. Configure
  // APP_ORIGIN for non-default Vite ports instead of trusting forwarded headers.
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return `http://${url.hostname}:5173`;
  return url.protocol === "https:" ? url.origin : null;
}

/** Company row bookable through `slug`, or null when unknown or not active. */
async function companyBySlug(slug: string): Promise<{ id: number; name: string; slug: string; business_hours: string } | null> {
  return await get<{ id: number; name: string; slug: string; business_hours: string }>(
    "SELECT id, name, slug, business_hours FROM companies WHERE slug = ? AND status = 'active'", [slug]) ?? null;
}

/** Only explicitly qualified active staff participate in public slot math. */
async function activeStaffIds(companyId: number, serviceId: number): Promise<number[]> {
  const rows = await query<{ id: number }>(`SELECT s.id FROM staff s JOIN tenant_ownership o
    ON o.resource_type = 'staff' AND o.resource_id = s.id
    JOIN staff_services ss ON ss.company_id = o.company_id AND ss.staff_id = s.id AND ss.service_id = ?
    WHERE o.company_id = ? AND s.active = 1 ORDER BY s.name ASC, s.id ASC`, [serviceId, companyId]);
  return rows.map((row) => row.id);
}

/** The signed customer identity from the booking cookie, or null. */
async function readCustomer(c: { req: { header(name: string): string | undefined }; env: Env["Bindings"] }): Promise<CustomerClaims | null> {
  const jwt = /(?:^|;\s*)yt_book=([^;]+)/.exec(c.req.header("cookie") ?? "")?.[1] ?? null;
  return jwt ? verifyCustomerToken(c.env.AUTH_SECRET, jwt) : null;
}

// Only these two carry the customer session; overview and slots stay anonymous.
app.use("/api/public/:slug/book", async (c, next) => {
  const customer = await readCustomer(c);
  if (!customer) return c.json({ error: "Necesitás iniciar sesión para reservar" }, 401);
  c.set("customer", customer);
  return next();
});
app.use("/api/auth/customer/session", async (c, next) => {
  const customer = await readCustomer(c);
  if (!customer) return c.json({ error: "Necesitás iniciar sesión" }, 401);
  c.set("customer", customer);
  return next();
});

app.get("/api/auth/customer/google", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return c.json({ error: GOOGLE_NOT_CONFIGURED }, 503);
  const slug = c.req.query("slug") ?? "";
  if (!(await companyBySlug(slug))) return c.json({ error: "Empresa no encontrada" }, 404);
  const base = appBase(c);
  if (!base) return c.json({ error: "Origen no permitido" }, 403);
  // The signed nonce binds Google's redirect to what this browser's cookie
  // carried: a forged callback without the cookie cannot pass the check.
  const state = await signCustomerState(c.env.AUTH_SECRET, { n: randomNonce(), s: slug });
  setCookie(c, CUSTOMER_STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  consent.search = new URLSearchParams({
    response_type: "code",
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${base}/api/auth/customer/google/callback`,
    scope: "openid email profile",
    state,
  }).toString();
  return c.redirect(consent.toString(), 302);
});

app.get("/api/auth/customer/google/callback", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return c.json({ error: GOOGLE_NOT_CONFIGURED }, 503);
  const stateCookie = getCookie(c, CUSTOMER_STATE_COOKIE) ?? "";
  const state = safeEqual(c.req.query("state") ?? "", stateCookie) ? await verifyCustomerState(c.env.AUTH_SECRET, stateCookie) : null;
  if (!state) {
    deleteCookie(c, CUSTOMER_STATE_COOKIE, { secure: true, path: "/" });
    return c.json({ error: "Estado de inicio inválido" }, 400);
  }
  deleteCookie(c, CUSTOMER_STATE_COOKIE, { secure: true, path: "/" });
  const base = appBase(c);
  if (!base) return c.json({ error: "Origen no permitido" }, 403);
  const redirectUri = `${base}/api/auth/customer/google/callback`;
  const target = `${base}/book/${encodeURIComponent(state.s)}`;
  const code = c.req.query("code") ?? "";
  if (!base || !code || c.req.query("error")) return c.redirect(`${target}?auth=failed`, 302);

  // Exchange the consent code for a token, then read the verified profile.
  // Direct userinfo fetch keeps this dependency-free: no JWKS, no SDK.
  const tokens = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  }).then((response) => response.ok ? response.json() : null).catch(() => null) as { access_token?: string } | null;
  const profile = tokens?.access_token ? await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  }).then((response) => response.ok ? response.json() : null).catch(() => null) as
    { sub?: string; email?: string; name?: string; email_verified?: boolean } | null : null;
  if (typeof profile?.sub !== "string" || !profile.sub || profile.sub.length > 255 ||
    typeof profile.email !== "string" || !z.string().email().max(254).safeParse(profile.email).success ||
    profile.email_verified !== true || (profile.name !== undefined && typeof profile.name !== "string")) {
    return c.redirect(`${target}?auth=failed`, 302);
  }
  const email = profile.email.trim().toLowerCase();
  const name = profile.name ? profile.name.slice(0, 200) : "";
  await run(`INSERT INTO oauth_identities (provider, provider_account_id, email, display_name, created_at)
    VALUES ('google', ?, ?, ?, ?)
    ON CONFLICT(provider, provider_account_id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name`,
    [profile.sub, email, name, Math.floor(Date.now() / 1000)]);
  setCookie(c, CUSTOMER_COOKIE, await signCustomerToken(c.env.AUTH_SECRET, { sub: profile.sub, email, name }),
    { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: CUSTOMER_SECONDS });
  return c.redirect(target, 302);
});

app.get("/api/auth/customer/session", (c) => {
  const customer = c.get("customer");
  return c.json({ customer: { sub: customer.sub, email: customer.email, name: customer.name } });
});

app.post("/api/auth/customer/logout", (c) => {
  deleteCookie(c, CUSTOMER_COOKIE, { secure: true, path: "/" });
  deleteCookie(c, CUSTOMER_STATE_COOKIE, { secure: true, path: "/" });
  return c.json({ ok: true });
});

app.get("/api/admin/companies", async (c) => {
  const companies = await query<{ id: number; name: string; status: string; created_at: string; users: number }>(
    `SELECT co.id, co.name, co.status, co.created_at, COUNT(u.id) AS users
     FROM companies co LEFT JOIN users u ON u.company_id = co.id GROUP BY co.id ORDER BY co.id`);
  return c.json({ companies });
});

app.post("/api/admin/users", async (c) => {
  const parsed = userInput.extend({ company_id: z.number().int().positive().nullable().optional(), agreement_confirmed: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos inválidos" }, 400);
  const companyId = parsed.data.company_id ?? null;
  if (companyId && !(await get("SELECT id FROM companies WHERE id = ?", [companyId]))) return c.json({ error: "Empresa inexistente" }, 404);
  if (companyId) {
    const existing = await get<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE company_id = ?", [companyId]);
    if ((existing?.count ?? 0) > 0 && parsed.data.agreement_confirmed !== true) {
      return c.json({ error: "Confirmá el acuerdo antes de crear cuentas adicionales" }, 403);
    }
  }
  const passwordHash = await hashPassword(parsed.data.password);
  try {
    const result = await run("INSERT INTO users (email, password_hash, role, company_id) VALUES (?, ?, 'tenant', ?)",
      [parsed.data.email.trim().toLowerCase(), passwordHash, companyId]);
    return c.json({ id: result.lastInsertRowid }, 201);
  } catch { return c.json({ error: "La cuenta ya existe" }, 409); }
});

app.put("/api/admin/companies/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const body = z.object({ status: z.enum(["active", "disabled"]) }).safeParse(await c.req.json().catch(() => null));
  if (!Number.isSafeInteger(id) || id < 1 || !body.success) return c.json({ error: "Datos inválidos" }, 400);
  const result = await run("UPDATE companies SET status = ? WHERE id = ?", [body.data.status, id]);
  return result.changes ? c.json({ ok: true }) : c.json({ error: "Empresa inexistente" }, 404);
});

app.post("/api/onboarding/company", async (c) => {
  const body = z.object({ name: z.string().trim().min(2).max(120) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Nombre inválido" }, 400);
  // Schema DDL alone does not backfill the legacy company. Never let a first
  // user claim unmigrated business rows by creating the first company as id 1.
  const unmigrated = await get<{ present: number }>(`SELECT CASE WHEN
    EXISTS (SELECT 1 FROM clients) OR EXISTS (SELECT 1 FROM staff) OR
    EXISTS (SELECT 1 FROM services) OR EXISTS (SELECT 1 FROM appointments) OR
    EXISTS (SELECT 1 FROM appointment_services) OR EXISTS (SELECT 1 FROM appointment_notes) OR
    EXISTS (SELECT 1 FROM blocked_slots) OR EXISTS (SELECT 1 FROM products)
    THEN 1 ELSE 0 END AS present`);
  const companies = await get<{ count: number }>("SELECT COUNT(*) AS count FROM companies");
  if ((companies?.count ?? 0) === 0 && unmigrated?.present) {
    return c.json({ error: "Migrá los datos existentes antes de crear una empresa" }, 503);
  }
  const db = c.env.DB;
  if (!db?.batch) return c.json({ error: "Onboarding requiere transacciones D1" }, 503);
  const id = c.get("actor").id;
  const reservation = `__onboarding:${crypto.randomUUID()}`;
  try {
    // A random reservation identifies ONLY this transaction's insert. Never
    // reuse last_insert_rowid(): concurrent batches could attach another user
    // to the first company's ID when their conditional insert did nothing.
    const results = await db.batch([
      db.prepare(`INSERT INTO companies (name, status) SELECT ?, 'pending'
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'tenant' AND company_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM company_onboarding WHERE user_id = ?)`).bind(reservation, id, id),
      db.prepare(`INSERT INTO company_onboarding (user_id, company_id)
        SELECT ?, id FROM companies WHERE name = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND company_id IS NULL)`).bind(id, reservation, id),
      db.prepare("UPDATE companies SET name = ? WHERE name = ?").bind(body.data.name, reservation),
      db.prepare(`UPDATE users SET company_id = (SELECT company_id FROM company_onboarding WHERE user_id = ?)
        WHERE id = ? AND company_id IS NULL`).bind(id, id),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1 || results[3].meta.changes !== 1) {
      return c.json({ error: "El alta de nuevas empresas todavía no está disponible" }, 503);
    }
    return c.json({ ok: true, status: "pending" }, 201);
  } catch { return c.json({ error: "No se pudo crear la empresa" }, 409); }
});

// ── Shared Schemas ─────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");
const NotFoundResponse = { description: "Not found", content: { "application/json": { schema: ErrorSchema } } };

const ConflictSchema = z.object({
  error: z.string(),
  conflicts: z.array(z.object({
    kind: z.enum(["appointment", "blocked"]),
    start_time: z.string(),
    end_time: z.string(),
    label: z.string(),
  })),
}).openapi("Conflict");

const ClientSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  notes: z.string(),
  appointment_count: z.number().int().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Client");

const HoursWindow = z.union([z.tuple([z.string(), z.string()]), z.array(z.tuple([z.string(), z.string()])), z.null()]);
const BusinessHoursSchema = z.object({
  mon: HoursWindow.optional(), tue: HoursWindow.optional(), wed: HoursWindow.optional(),
  thu: HoursWindow.optional(), fri: HoursWindow.optional(), sat: HoursWindow.optional(), sun: HoursWindow.optional(),
}).strict().openapi("BusinessHours");
const StaffHoursSchema = BusinessHoursSchema.refine((value) => normalizeHours(value, true) !== null,
  "Invalid hours: use HH:mm, increasing non-overlapping intervals").transform((value) => normalizeHours(value, true)!).nullable();

const StaffSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  title: z.string(),
  color: z.string(),
  active: z.number().int(),
  working_hours: BusinessHoursSchema.nullable().optional(),
  service_ids: z.array(z.number().int()),
  appointment_count: z.number().int().optional(),
  completed_appointment_count: z.number().int().optional(),
  completed_service_value: z.number().optional().describe("Sum of booked prices for completed appointments; not payments, tips, commission, or take-home pay"),
  created_at: z.string(),
}).openapi("Staff");

type StoredStaff = Omit<z.infer<typeof StaffSchema>, "working_hours" | "service_ids"> & { working_hours?: string | null };

const ServiceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string(),
  duration: z.number().int(),
  price: z.number(),
  color: z.string(),
  category: z.string(),
  active: z.number().int(),
  created_at: z.string(),
}).openapi("Service");

const AppointmentNoteSchema = z.object({
  id: z.number().int(),
  appointment_id: z.number().int(),
  content: z.string(),
  created_at: z.string(),
}).openapi("AppointmentNote");

const AppointmentServiceSchema = z.object({
  id: z.number().int(),
  appointment_id: z.number().int(),
  service_id: z.number().int(),
  service_name: z.string().optional(),
  price: z.number(),
  duration: z.number().int(),
}).openapi("AppointmentService");

const AppointmentSchema = z.object({
  id: z.number().int(),
  identifier: z.string(),
  client_id: z.number().int(),
  staff_id: z.number().int().nullable(),
  status: z.string(),
  scheduled_date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  total_price: z.number(),
  notes: z.string(),
  is_recurring: z.number().int(),
  recurrence_interval: z.string(),
  client_name: z.string().optional(),
  client_phone: z.string().optional(),
  staff_name: z.string().nullable().optional(),
  staff_color: z.string().nullable().optional(),
  service_names: z.string().nullable().optional(),
  latest_note: z.string().nullable().optional(),
  appointment_services: z.array(AppointmentServiceSchema).optional(),
  appointment_notes: z.array(AppointmentNoteSchema).optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Appointment");

const BlockedSlotSchema = z.object({
  id: z.number().int(),
  staff_id: z.number().int(),
  staff_name: z.string().optional(),
  blocked_date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  reason: z.string(),
  created_at: z.string(),
}).openapi("BlockedSlot");

const ProductSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  brand: z.string(),
  category: z.string(),
  sku: z.string(),
  price: z.number(),
  cost: z.number(),
  stock: z.number().int(),
  low_stock_alert: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Product");

const IdParam = z.object({ id: z.string().openapi({ description: "Resource ID" }) });

// ── Helpers ────────────────────────────────────────────────────────

type TenantContext = { env: Env["Bindings"]; get(key: "actor"): Actor };
type OwnedTable = "clients" | "staff" | "services" | "appointments" | "appointment_services" | "appointment_notes" | "blocked_slots" | "products";

function tenant(c: TenantContext): number {
  const id = c.get("actor").company_id;
  if (id === null) throw new Error("Tenant context required");
  return id;
}

async function ownsIn(ownerId: number, table: OwnedTable, id: number | string): Promise<boolean> {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) return false;
  return !!(await get(`SELECT 1 FROM tenant_ownership WHERE resource_type = ? AND resource_id = ? AND company_id = ?`,
    [table, id, ownerId]));
}

async function owns(c: TenantContext, table: OwnedTable, id: number | string): Promise<boolean> {
  return ownsIn(tenant(c), table, id);
}

/** An unconditional insert and its ownership record commit together or not at all. */
async function insertOwnedIn(db: D1Database, ownerId: number, table: OwnedTable, sql: string, values: (string | number | null)[]): Promise<number> {
  if (!db?.batch) throw new Error("D1 transactions required for tenant writes");
  const results = await db.batch([
    db.prepare(sql).bind(...values),
    db.prepare("INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES (?, last_insert_rowid(), ?)")
      .bind(table, ownerId),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) throw new Error("Tenant insert failed");
  // The second INSERT sets last_insert_rowid to the ownership table rowid;
  // the first result retains the business ID from its own statement.
  return Number((results[0].meta as { last_row_id?: number }).last_row_id);
}

async function insertOwned(c: TenantContext, table: OwnedTable, sql: string, values: (string | number | null)[]): Promise<number> {
  return insertOwnedIn(c.env.DB, tenant(c), table, sql, values);
}

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * What already occupies `staffId` on `date`: their other appointments, plus any
 * time blocked off for lunch, holiday and the like.
 *
 * Cancelled appointments free the chair, and are the one status left out. That
 * matches what `/api/calendar` draws, so the rule an owner sees is simply
 * "if it is on the calendar, it is taken".
 */
async function busyForOwner(db: D1Database, ownerId: number, staffId: number, date: string, excludeAppointmentId?: number): Promise<Busy[]> {
  const appts = await query<{ start_time: string; end_time: string; client_name: string | null }>(
    `SELECT a.start_time, a.end_time, cl.name as client_name
     FROM appointments a
     LEFT JOIN clients cl ON cl.id = a.client_id AND EXISTS
       (SELECT 1 FROM tenant_ownership co WHERE co.resource_type = 'clients' AND co.resource_id = cl.id AND co.company_id = ?)
     JOIN tenant_ownership o ON o.resource_type = 'appointments' AND o.resource_id = a.id AND o.company_id = ?
     WHERE a.staff_id = ? AND a.scheduled_date = ? AND a.status != 'cancelled'
       ${excludeAppointmentId ? "AND a.id != ?" : ""}`,
    excludeAppointmentId ? [ownerId, ownerId, staffId, date, excludeAppointmentId] : [ownerId, ownerId, staffId, date],
  );
  const blocks = await query<{ start_time: string; end_time: string; reason: string | null }>(
    `SELECT b.start_time, b.end_time, b.reason FROM blocked_slots b JOIN tenant_ownership o
      ON o.resource_type = 'blocked_slots' AND o.resource_id = b.id AND o.company_id = ?
      WHERE b.staff_id = ? AND b.blocked_date = ?`,
    [ownerId, staffId, date],
  );
  return [
    ...appts.map((a): Busy => ({
      kind: "appointment", start_time: a.start_time, end_time: a.end_time,
      label: a.client_name || "another booking",
    })),
    ...blocks.map((b): Busy => ({
      kind: "blocked", start_time: b.start_time, end_time: b.end_time,
      label: b.reason || "blocked",
    })),
  ];
}

async function busyFor(c: TenantContext, staffId: number, date: string, excludeAppointmentId?: number): Promise<Busy[]> {
  return busyForOwner(c.env.DB, tenant(c), staffId, date, excludeAppointmentId);
}

/** The staff member's name, for the conflict message. */
async function staffName(c: TenantContext, staffId: number): Promise<string> {
  const s = await get<{ name: string }>(`SELECT s.name FROM staff s JOIN tenant_ownership o
    ON o.resource_type = 'staff' AND o.resource_id = s.id WHERE s.id = ? AND o.company_id = ?`, [staffId, tenant(c)]);
  return s?.name || "";
}

// ── Stats ──────────────────────────────────────────────────────────

const getStats = createRoute({
  method: "get",
  path: "/api/stats",
  responses: {
    200: {
      description: "Dashboard stats",
      content: { "application/json": { schema: z.object({
        appointments: z.number().int(),
        clients: z.number().int(),
        staff: z.number().int(),
        services: z.number().int(),
        products: z.number().int(),
        today_appointments: z.number().int(),
        upcoming_appointments: z.number().int(),
        completed_appointments: z.number().int(),
        revenue: z.number().describe("Completed booked service value; retained as revenue for API compatibility, not settled payment revenue"),
        low_stock_products: z.number().int(),
      }) } },
    },
  },
});

app.openapi(getStats, async (c) => {
  const today = new Date().toISOString().split("T")[0];
  const scoped = async (table: "appointments" | "clients" | "staff" | "services" | "products", expression: string, filter = "", args: unknown[] = []) => {
    return get<{ value: number }>(`SELECT ${expression} AS value FROM ${table} t
      JOIN tenant_ownership o ON o.resource_type = ? AND o.resource_id = t.id AND o.company_id = ? ${filter}`,
      [table, tenant(c), ...args]);
  };
  const appointments = await scoped("appointments", "COUNT(*)");
  const clients = await scoped("clients", "COUNT(*)");
  const staff = await scoped("staff", "COUNT(*)", "WHERE t.active = 1");
  const services = await scoped("services", "COUNT(*)", "WHERE t.active = 1");
  const products = await scoped("products", "COUNT(*)");
  const todayAppointments = await scoped("appointments", "COUNT(*)", "WHERE t.scheduled_date = ?", [today]);
  const upcomingAppointments = await scoped("appointments", "COUNT(*)", "WHERE t.status IN ('booked', 'confirmed') AND t.scheduled_date >= ?", [today]);
  const completedAppointments = await scoped("appointments", "COUNT(*)", "WHERE t.status = 'completed'");
  const completedServiceValue = await scoped("appointments", "COALESCE(SUM(t.total_price), 0)", "WHERE t.status = 'completed'");
  const lowStock = await scoped("products", "COUNT(*)", "WHERE t.stock <= t.low_stock_alert");
  return c.json({
    appointments: appointments?.value || 0,
    clients: clients?.value || 0,
    staff: staff?.value || 0,
    services: services?.value || 0,
    products: products?.value || 0,
    today_appointments: todayAppointments?.value || 0,
    upcoming_appointments: upcomingAppointments?.value || 0,
    completed_appointments: completedAppointments?.value || 0,
    revenue: completedServiceValue?.value || 0,
    low_stock_products: lowStock?.value || 0,
  }, 200);
});

// ── Appointments ───────────────────────────────────────────────────

const listAppointments = createRoute({
  method: "get",
  path: "/api/appointments",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
      status: z.string().optional(),
      date: z.string().optional(),
      staff_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated appointment list",
      content: { "application/json": { schema: z.object({ appointments: z.array(AppointmentSchema), total: z.number().int() }) } },
    },
  },
});

app.openapi(listAppointments, async (c) => {
  const q = c.req.valid("query");
  const page = parseInt(q.page || "1", 10);
  const limit = parseInt(q.limit || "50", 10);
  const offset = (page - 1) * limit;

  let where = "WHERE o.resource_type = 'appointments' AND o.company_id = ?";
  const params: unknown[] = [tenant(c)];

  if (q.search) {
    where += " AND (a.identifier LIKE ? OR cl.name LIKE ?)";
    const s = `%${q.search}%`;
    params.push(s, s);
  }
  if (q.status) { where += " AND a.status = ?"; params.push(q.status); }
  if (q.date) { where += " AND a.scheduled_date = ?"; params.push(q.date); }
  if (q.staff_id) { where += " AND a.staff_id = ?"; params.push(q.staff_id); }

  const total = await get<{ count: number }>(
    `SELECT COUNT(*) as count FROM appointments a JOIN tenant_ownership o ON o.resource_id = a.id
     LEFT JOIN clients cl ON cl.id = a.client_id AND EXISTS (SELECT 1 FROM tenant_ownership co
       WHERE co.resource_type = 'clients' AND co.resource_id = cl.id AND co.company_id = o.company_id) ${where}`,
    params,
  );

  const appointments = await query<Record<string, unknown>>(
    `SELECT a.*, cl.name as client_name, cl.phone as client_phone,
            s.name as staff_name, s.color as staff_color
     FROM appointments a
     JOIN tenant_ownership o ON o.resource_id = a.id
     LEFT JOIN clients cl ON cl.id = a.client_id AND EXISTS (SELECT 1 FROM tenant_ownership co
       WHERE co.resource_type = 'clients' AND co.resource_id = cl.id AND co.company_id = o.company_id)
     LEFT JOIN staff s ON s.id = a.staff_id AND EXISTS (SELECT 1 FROM tenant_ownership so
       WHERE so.resource_type = 'staff' AND so.resource_id = s.id AND so.company_id = o.company_id)
     ${where}
     ORDER BY a.scheduled_date DESC, a.start_time ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return c.json({ appointments, total: total?.count || 0 }, 200);
});

// Calendar view - appointments for a date range
const getCalendar = createRoute({
  method: "get",
  path: "/api/calendar",
  request: {
    query: z.object({ start: z.string(), end: z.string() }),
  },
  responses: {
    200: {
      description: "Calendar appointments and blocked slots",
      content: { "application/json": { schema: z.object({
        appointments: z.array(AppointmentSchema),
        blocked_slots: z.array(BlockedSlotSchema),
      }) } },
    },
  },
});

app.openapi(getCalendar, async (c) => {
  const { start, end } = c.req.valid("query");
  const appointments = await query<Record<string, unknown>>(
    `SELECT a.*, cl.name as client_name, cl.phone as client_phone,
            s.name as staff_name, s.color as staff_color
     FROM appointments a
     JOIN tenant_ownership o ON o.resource_type = 'appointments' AND o.resource_id = a.id AND o.company_id = ?
     LEFT JOIN clients cl ON cl.id = a.client_id AND EXISTS (SELECT 1 FROM tenant_ownership co
       WHERE co.resource_type = 'clients' AND co.resource_id = cl.id AND co.company_id = o.company_id)
     LEFT JOIN staff s ON s.id = a.staff_id AND EXISTS (SELECT 1 FROM tenant_ownership so
       WHERE so.resource_type = 'staff' AND so.resource_id = s.id AND so.company_id = o.company_id)
     WHERE a.scheduled_date >= ? AND a.scheduled_date <= ? AND a.status != 'cancelled'
     ORDER BY a.start_time ASC`,
    [tenant(c), start, end],
  );

  // Attach services to each appointment
  for (const apt of appointments) {
    const svcs = await query<Record<string, unknown>>(
      `SELECT aps.*, sv.name as service_name FROM appointment_services aps
       JOIN tenant_ownership o ON o.resource_type = 'appointment_services' AND o.resource_id = aps.id AND o.company_id = ?
       LEFT JOIN services sv ON sv.id = aps.service_id AND EXISTS (SELECT 1 FROM tenant_ownership so
         WHERE so.resource_type = 'services' AND so.resource_id = sv.id AND so.company_id = o.company_id)
       WHERE aps.appointment_id = ?`,
      [tenant(c), apt.id],
    );
    (apt as Record<string, unknown>).appointment_services = svcs;
  }

  const blocked = await query<Record<string, unknown>>(
    `SELECT b.*, s.name as staff_name FROM blocked_slots b
     JOIN tenant_ownership o ON o.resource_type = 'blocked_slots' AND o.resource_id = b.id AND o.company_id = ?
     LEFT JOIN staff s ON s.id = b.staff_id AND EXISTS (SELECT 1 FROM tenant_ownership so
       WHERE so.resource_type = 'staff' AND so.resource_id = s.id AND so.company_id = o.company_id)
     WHERE b.blocked_date >= ? AND b.blocked_date <= ?
     ORDER BY b.start_time ASC`,
    [tenant(c), start, end],
  );

  return c.json({ appointments, blocked_slots: blocked }, 200);
});

// Get single appointment
const getAppointment = createRoute({
  method: "get",
  path: "/api/appointments/{id}",
  request: { params: IdParam },
  responses: {
    200: {
      description: "Appointment detail",
      content: { "application/json": { schema: z.object({ appointment: AppointmentSchema }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getAppointment, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "appointments", id))) return c.json({ error: "No encontrado" }, 404);
  const apt = await get<Record<string, unknown>>(
    `SELECT a.*, cl.name as client_name, cl.phone as client_phone,
            s.name as staff_name, s.color as staff_color
     FROM appointments a
     LEFT JOIN clients cl ON cl.id = a.client_id AND EXISTS (SELECT 1 FROM tenant_ownership co
       WHERE co.resource_type = 'clients' AND co.resource_id = cl.id AND co.company_id = ?)
     LEFT JOIN staff s ON s.id = a.staff_id AND EXISTS (SELECT 1 FROM tenant_ownership so
       WHERE so.resource_type = 'staff' AND so.resource_id = s.id AND so.company_id = ?)
     WHERE a.id = ?`,
    [tenant(c), tenant(c), id],
  );
  if (!apt) return c.json({ error: "No encontrado" }, 404);

  const svcs = await query<Record<string, unknown>>(
    `SELECT aps.*, sv.name as service_name FROM appointment_services aps
     JOIN tenant_ownership o ON o.resource_type = 'appointment_services' AND o.resource_id = aps.id AND o.company_id = ?
     LEFT JOIN services sv ON sv.id = aps.service_id AND EXISTS (SELECT 1 FROM tenant_ownership so
       WHERE so.resource_type = 'services' AND so.resource_id = sv.id AND so.company_id = o.company_id)
     WHERE aps.appointment_id = ?`,
    [tenant(c), id],
  );
  apt.appointment_services = svcs;

  const notes = await query<Record<string, unknown>>(
    `SELECT n.* FROM appointment_notes n JOIN tenant_ownership o ON o.resource_type = 'appointment_notes'
       AND o.resource_id = n.id AND o.company_id = ? WHERE n.appointment_id = ? ORDER BY n.created_at DESC`,
    [tenant(c), id],
  );
  apt.appointment_notes = notes;

  return c.json({ appointment: apt }, 200);
});

// Create appointment
const createAppointment = createRoute({
  method: "post",
  path: "/api/appointments",
  request: {
    body: { content: { "application/json": { schema: z.object({
      client_id: z.number().int(),
      staff_id: z.number().int().nullable().optional(),
      scheduled_date: z.string(),
      start_time: z.string().optional(),
      notes: z.string().optional(),
      is_recurring: z.number().int().optional(),
      recurrence_interval: z.string().optional(),
      service_ids: z.array(z.number().int()).optional(),
      allow_conflict: z.boolean().optional().openapi({
        description: "Book even though the staff member is already busy then. Salons do deliberately overlap (a colour processes while the next client is cut), so this is allowed, but never by accident.",
      }),
    }) } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ appointment: AppointmentSchema }) } } },
    400: { description: "Invalid times", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Staff member is already busy", content: { "application/json": { schema: ConflictSchema } } },
  },
});

app.openapi(createAppointment, async (c) => {
  const body = c.req.valid("json");
  if (!(await owns(c, "clients", body.client_id)) ||
    (body.staff_id != null && !(await owns(c, "staff", body.staff_id)))) {
    return c.json({ error: "Cliente o personal no encontrado" }, 400);
  }
  const startTime = body.start_time ?? "09:00";

  // Calculate total duration and price from services
  let totalDuration = 60;
  let totalPrice = 0;
  const serviceIds = body.service_ids || [];

  if (serviceIds.length > 0) {
    if (!(await Promise.all(serviceIds.map((id) => owns(c, "services", id)))).every(Boolean)) {
      return c.json({ error: "Servicio no encontrado" }, 400);
    }
    const svcs = await Promise.all(serviceIds.map((id) => get<{ duration: number; price: number }>(
      "SELECT duration, price FROM services WHERE id = ?", [id])));
    if (svcs.some((svc) => !svc)) return c.json({ error: "Servicio no encontrado" }, 400);
    totalDuration = svcs.reduce((sum, s) => sum + s!.duration, 0);
    totalPrice = svcs.reduce((sum, s) => sum + s!.price, 0);
  }

  const start = toMinutes(startTime);
  if (start === null) return c.json({ error: "Los horarios deben tener formato HH:MM" }, 400);
  if (totalDuration <= 0) return c.json({ error: "El turno debe tener una duración mayor a cero" }, 400);
  if (start + totalDuration >= 24 * 60) {
    return c.json({ error: "El turno debe comenzar y terminar el mismo día" }, 400);
  }
  const endTime = addMinutes(startTime, totalDuration);

  // Nothing to contend for when the booking is unassigned.
  if (body.staff_id && !body.allow_conflict) {
    const conflicts = findConflicts(startTime, endTime, await busyFor(c, body.staff_id, body.scheduled_date));
    if (conflicts.length > 0) {
      return c.json({ error: describeConflicts(await staffName(c, body.staff_id), conflicts), conflicts }, 409);
    }
  }

  const db = c.env.DB;
  if (!db?.batch) return c.json({ error: "Se requieren transacciones D1" }, 503);
  // Global identifier sequence remains unique across companies. Its increment,
  // booking, links and ownership all commit in one D1 transaction.
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO _meta (key, value)
      SELECT 'appointment_counter', CAST(COALESCE(MAX(CAST(SUBSTR(identifier, 5) AS INTEGER)), 0) AS TEXT)
      FROM appointments WHERE identifier GLOB 'APT-[0-9]*'`).bind(),
    db.prepare("UPDATE _meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'appointment_counter'").bind(),
    db.prepare(`INSERT INTO appointments (identifier, client_id, staff_id, scheduled_date, start_time, end_time, total_price, notes, is_recurring, recurrence_interval)
      VALUES (COALESCE((SELECT value FROM _meta WHERE key = 'appointment_prefix'), 'APT') || '-' ||
      (SELECT value FROM _meta WHERE key = 'appointment_counter'), ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      body.client_id, body.staff_id ?? null, body.scheduled_date, startTime, endTime, totalPrice,
      body.notes || "", body.is_recurring || 0, body.recurrence_interval || ""),
    db.prepare("INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES ('appointments', last_insert_rowid(), ?)").bind(tenant(c)),
  ];
  for (const svcId of serviceIds) {
    const svc = await get<{ duration: number; price: number }>("SELECT duration, price FROM services WHERE id = ?", [svcId]);
    if (!svc) return c.json({ error: "Servicio no encontrado" }, 400);
    statements.push(db.prepare(`INSERT INTO appointment_services (appointment_id, service_id, price, duration)
      VALUES ((SELECT a.id FROM appointments a JOIN tenant_ownership o ON o.resource_type = 'appointments'
        AND o.resource_id = a.id AND o.company_id = ? WHERE a.identifier =
        COALESCE((SELECT value FROM _meta WHERE key = 'appointment_prefix'), 'APT') || '-' ||
        (SELECT value FROM _meta WHERE key = 'appointment_counter')), ?, ?, ?)`).bind(tenant(c), svcId, svc.price, svc.duration));
    statements.push(db.prepare("INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES ('appointment_services', last_insert_rowid(), ?)").bind(tenant(c)));
  }
  const result = await db.batch(statements);
  const aptId = Number((result[2].meta as { last_row_id?: number }).last_row_id);

  const apt = await get<Record<string, unknown>>(
    `SELECT a.*, cl.name as client_name, cl.phone as client_phone,
            s.name as staff_name, s.color as staff_color
     FROM appointments a
     LEFT JOIN clients cl ON cl.id = a.client_id
     LEFT JOIN staff s ON s.id = a.staff_id
     WHERE a.id = ?`,
    [aptId],
  );

  return c.json({ appointment: apt }, 201);
});

// Update appointment
const updateAppointment = createRoute({
  method: "put",
  path: "/api/appointments/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      client_id: z.number().int().optional(),
      staff_id: z.number().int().nullable().optional(),
      status: z.string().optional(),
      scheduled_date: z.string().optional(),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      total_price: z.number().optional(),
      notes: z.string().optional(),
      allow_conflict: z.boolean().optional().openapi({
        description: "Move the appointment even though the staff member is already busy then.",
      }),
    }) } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid times", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Staff member is already busy", content: { "application/json": { schema: ConflictSchema } } },
  },
});

app.openapi(updateAppointment, async (c) => {
  const { id } = c.req.valid("param");
  const { allow_conflict, ...body } = c.req.valid("json");
  if (!(await owns(c, "appointments", id))) return c.json({ error: "No encontrado" }, 404);
  if ((body.client_id !== undefined && !(await owns(c, "clients", body.client_id))) ||
      (body.staff_id != null && !(await owns(c, "staff", body.staff_id)))) {
    return c.json({ error: "Cliente o personal no encontrado" }, 400);
  }

  const existing = await get<{
    staff_id: number | null; scheduled_date: string; start_time: string; end_time: string; status: string;
  }>("SELECT staff_id, scheduled_date, start_time, end_time, status FROM appointments WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "No encontrado" }, 404);

  // Where the appointment lands once this patch is applied.
  const staffId = body.staff_id !== undefined ? body.staff_id : existing.staff_id;
  const date = body.scheduled_date ?? existing.scheduled_date;
  const startTime = body.start_time ?? existing.start_time;

  // Moving an appointment keeps its length. Without this, patching start_time
  // alone left the old end_time behind and silently resized the booking.
  let endTime = body.end_time ?? existing.end_time;
  if (body.start_time !== undefined && body.start_time !== existing.start_time && body.end_time === undefined) {
    const was = toMinutes(existing.start_time);
    const wasEnd = toMinutes(existing.end_time);
    const duration = was !== null && wasEnd !== null ? Math.max(wasEnd - was, 0) : 0;
    endTime = addMinutes(startTime, duration);
    body.end_time = endTime;
  }

  const moved = staffId !== existing.staff_id || date !== existing.scheduled_date
    || startTime !== existing.start_time || endTime !== existing.end_time;
  const status = body.status ?? existing.status;
  const restored = existing.status === "cancelled" && status !== "cancelled";

  // An existing deliberate overlap must not block notes, check-in, completion,
  // or cancellation. Restoring a cancelled booking occupies its slot again.
  if (moved || restored) {
    const start = toMinutes(startTime);
    const end = toMinutes(endTime);
    if (start === null || end === null) return c.json({ error: "Los horarios deben tener formato HH:MM" }, 400);
    if (end <= start) return c.json({ error: "El turno debe terminar después de comenzar en el mismo día" }, 400);

    if (status !== "cancelled" && staffId && !allow_conflict) {
      const conflicts = findConflicts(startTime, endTime, await busyFor(c, staffId, date, Number(id)));
      if (conflicts.length > 0) {
        return c.json({ error: describeConflicts(await staffName(c, staffId), conflicts), conflicts }, 409);
      }
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  sets.push("updated_at = datetime('now')");
  await run(`UPDATE appointments SET ${sets.join(", ")} WHERE id = ? AND EXISTS
    (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'appointments' AND o.resource_id = appointments.id AND o.company_id = ?)`,
    [...params, id, tenant(c)]);
  return c.json({ ok: true }, 200);
});

// Delete appointment
const deleteAppointment = createRoute({
  method: "delete",
  path: "/api/appointments/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(deleteAppointment, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "appointments", id))) return c.json({ error: "No encontrado" }, 404);
  await run(`DELETE FROM appointments WHERE id = ? AND EXISTS (SELECT 1 FROM tenant_ownership o
    WHERE o.resource_type = 'appointments' AND o.resource_id = appointments.id AND o.company_id = ?)`, [id, tenant(c)]);
  return c.json({ ok: true }, 200);
});

// Appointment notes
const addAppointmentNote = createRoute({
  method: "post",
  path: "/api/appointments/{id}/notes",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ content: z.string() }) } } },
  },
  responses: { 201: { description: "Note added", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(addAppointmentNote, async (c) => {
  const { id } = c.req.valid("param");
  const { content } = c.req.valid("json");
  if (!(await owns(c, "appointments", id))) return c.json({ error: "No encontrado" }, 404);
  await insertOwned(c, "appointment_notes", "INSERT INTO appointment_notes (appointment_id, content) VALUES (?, ?)", [id, content]);
  return c.json({ ok: true }, 201);
});

const deleteNote = createRoute({
  method: "delete",
  path: "/api/notes/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(deleteNote, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "appointment_notes", id))) return c.json({ error: "No encontrado" }, 404);
  await run(`DELETE FROM appointment_notes WHERE id = ? AND EXISTS (SELECT 1 FROM tenant_ownership o
    WHERE o.resource_type = 'appointment_notes' AND o.resource_id = appointment_notes.id AND o.company_id = ?)`, [id, tenant(c)]);
  return c.json({ ok: true }, 200);
});

// ── Clients ───────────────────────────────────────────────────────

const listClients = createRoute({
  method: "get",
  path: "/api/clients",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated client list",
      content: { "application/json": { schema: z.object({ clients: z.array(ClientSchema), total: z.number().int() }) } },
    },
  },
});

app.openapi(listClients, async (c) => {
  const q = c.req.valid("query");
  const page = parseInt(q.page || "1", 10);
  const limit = parseInt(q.limit || "50", 10);
  const offset = (page - 1) * limit;

  let where = "WHERE o.resource_type = 'clients' AND o.company_id = ?";
  const params: unknown[] = [tenant(c)];
  if (q.search) {
    where += " AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)";
    const s = `%${q.search}%`;
    params.push(s, s, s);
  }

  const total = await get<{ count: number }>(`SELECT COUNT(*) as count FROM clients c JOIN tenant_ownership o ON o.resource_id = c.id ${where}`, params);
  const clients = await query<Record<string, unknown>>(
    `SELECT c.*, (SELECT COUNT(*) FROM appointments a JOIN tenant_ownership ao
       ON ao.resource_type = 'appointments' AND ao.resource_id = a.id AND ao.company_id = o.company_id
       WHERE a.client_id = c.id) as appointment_count
     FROM clients c JOIN tenant_ownership o ON o.resource_id = c.id ${where} ORDER BY c.name ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return c.json({ clients, total: total?.count || 0 }, 200);
});

const getAllClients = createRoute({
  method: "get",
  path: "/api/clients/all",
  responses: {
    200: {
      description: "All clients for lookup",
      content: { "application/json": { schema: z.object({ clients: z.array(z.object({ id: z.number().int(), name: z.string() })) }) } },
    },
  },
});

app.openapi(getAllClients, async (c) => {
  const clients = await query<{ id: number; name: string }>(`SELECT c.id, c.name FROM clients c JOIN tenant_ownership o
    ON o.resource_type = 'clients' AND o.resource_id = c.id WHERE o.company_id = ? ORDER BY c.name ASC`, [tenant(c)]);
  return c.json({ clients }, 200);
});

const getClient = createRoute({
  method: "get",
  path: "/api/clients/{id}",
  request: { params: IdParam },
  responses: {
    200: {
      description: "Client detail with appointments",
      content: { "application/json": { schema: z.object({ client: ClientSchema, appointments: z.array(AppointmentSchema) }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getClient, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "clients", id))) return c.json({ error: "No encontrado" }, 404);
  const client = await get<Record<string, unknown>>("SELECT * FROM clients WHERE id = ?", [id]);
  if (!client) return c.json({ error: "No encontrado" }, 404);
  const appointments = await query<Record<string, unknown>>(
    `SELECT a.*, s.name as staff_name, s.color as staff_color,
            (SELECT GROUP_CONCAT(name, ', ')
             FROM (
                SELECT sv.name
                FROM appointment_services aps
                JOIN tenant_ownership aso ON aso.resource_type = 'appointment_services'
                  AND aso.resource_id = aps.id AND aso.company_id = ?
                JOIN services sv ON sv.id = aps.service_id
               JOIN tenant_ownership so ON so.resource_type = 'services' AND so.resource_id = sv.id AND so.company_id = ?
               WHERE aps.appointment_id = a.id
               ORDER BY aps.id
             )) as service_names,
            (SELECT an.content
             FROM appointment_notes an
             JOIN tenant_ownership no ON no.resource_type = 'appointment_notes' AND no.resource_id = an.id AND no.company_id = ?
             WHERE an.appointment_id = a.id
             ORDER BY an.created_at DESC, an.id DESC
             LIMIT 1) as latest_note
     FROM appointments a
     JOIN tenant_ownership ao ON ao.resource_type = 'appointments' AND ao.resource_id = a.id AND ao.company_id = ?
      LEFT JOIN staff s ON s.id = a.staff_id AND EXISTS (SELECT 1 FROM tenant_ownership sto
        WHERE sto.resource_type = 'staff' AND sto.resource_id = s.id AND sto.company_id = ao.company_id)
      WHERE a.client_id = ? ORDER BY a.scheduled_date DESC LIMIT 50`,
    [tenant(c), tenant(c), tenant(c), tenant(c), id],
  );
  return c.json({ client, appointments }, 200);
});

const createClient = createRoute({
  method: "post",
  path: "/api/clients",
  request: {
    body: { content: { "application/json": { schema: z.object({
      name: z.string(),
      email: z.string().optional(),
      phone: z.string().optional(),
      notes: z.string().optional(),
    }) } } },
  },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ client: ClientSchema }) } } } },
});

app.openapi(createClient, async (c) => {
  const body = c.req.valid("json");
  const id = await insertOwned(c, "clients",
    "INSERT INTO clients (name, email, phone, notes) VALUES (?, ?, ?, ?)",
    [body.name, body.email || "", body.phone || "", body.notes || ""],
  );
  const client = await get<Record<string, unknown>>("SELECT * FROM clients WHERE id = ?", [id]);
  return c.json({ client }, 201);
});

const updateClient = createRoute({
  method: "put",
  path: "/api/clients/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      notes: z.string().optional(),
    }) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(updateClient, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "clients", id))) return c.json({ error: "No encontrado" }, 404);
  const body = c.req.valid("json");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    await run(`UPDATE clients SET ${sets.join(", ")} WHERE id = ? AND EXISTS
      (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'clients' AND o.resource_id = clients.id AND o.company_id = ?)`, [...params, id, tenant(c)]);
  }
  return c.json({ ok: true }, 200);
});

const deleteClient = createRoute({
  method: "delete",
  path: "/api/clients/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(deleteClient, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "clients", id))) return c.json({ error: "No encontrado" }, 404);
  await run(`DELETE FROM clients WHERE id = ? AND EXISTS (SELECT 1 FROM tenant_ownership o
    WHERE o.resource_type = 'clients' AND o.resource_id = clients.id AND o.company_id = ?)`, [id, tenant(c)]);
  return c.json({ ok: true }, 200);
});

// ── Staff ─────────────────────────────────────────────────────────

const ServiceIdsSchema = z.array(z.number().int().positive()).max(500)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate service IDs");

async function assignedServices(companyId: number, staffId: number): Promise<number[]> {
  const rows = await query<{ service_id: number }>(
    "SELECT service_id FROM staff_services WHERE company_id = ? AND staff_id = ? ORDER BY service_id", [companyId, staffId]);
  return rows.map((row) => row.service_id);
}

// Inactive services may stay configured, but never admit a public booking.
async function validServiceAssignments(c: TenantContext, ids: number[] = []): Promise<boolean> {
  return (await Promise.all(ids.map((id) => owns(c, "services", id)))).every(Boolean);
}

const listStaff = createRoute({
  method: "get",
  path: "/api/staff",
  responses: {
    200: {
      description: "All staff members",
      content: { "application/json": { schema: z.object({ staff: z.array(StaffSchema) }) } },
    },
  },
});

app.openapi(listStaff, async (c) => {
  const staff = await query<StoredStaff>(
    `SELECT s.*,
            COUNT(a.id) as appointment_count,
            COALESCE(SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END), 0) as completed_appointment_count,
            COALESCE(SUM(CASE WHEN a.status = 'completed' THEN a.total_price ELSE 0 END), 0) as completed_service_value
     FROM staff s
     JOIN tenant_ownership o ON o.resource_type = 'staff' AND o.resource_id = s.id AND o.company_id = ?
     LEFT JOIN appointments a ON a.staff_id = s.id AND EXISTS
       (SELECT 1 FROM tenant_ownership ao WHERE ao.resource_type = 'appointments' AND ao.resource_id = a.id AND ao.company_id = o.company_id)
     GROUP BY s.id
     ORDER BY s.name ASC`,
    [tenant(c)],
  );
  return c.json({ staff: await Promise.all(staff.map(async (member) => ({ ...member,
    service_ids: await assignedServices(tenant(c), member.id),
    working_hours: member.working_hours ? JSON.parse(String(member.working_hours)) : null }))) }, 200);
});

const getAllStaff = createRoute({
  method: "get",
  path: "/api/staff/all",
  responses: {
    200: {
      description: "All staff for lookup",
      content: { "application/json": { schema: z.object({ staff: z.array(z.object({ id: z.number().int(), name: z.string(), color: z.string() })) }) } },
    },
  },
});

app.openapi(getAllStaff, async (c) => {
  const staff = await query<{ id: number; name: string; color: string }>(`SELECT s.id, s.name, s.color FROM staff s
    JOIN tenant_ownership o ON o.resource_type = 'staff' AND o.resource_id = s.id
    WHERE o.company_id = ? AND s.active = 1 ORDER BY s.name ASC`, [tenant(c)]);
  return c.json({ staff }, 200);
});

const createStaff = createRoute({
  method: "post",
  path: "/api/staff",
  request: {
    body: { content: { "application/json": { schema: z.object({
      name: z.string(),
      email: z.string().optional(),
      phone: z.string().optional(),
      title: z.string().optional(),
      color: z.string().optional(),
      working_hours: StaffHoursSchema.optional(),
      service_ids: ServiceIdsSchema.optional(),
    }) } } },
  },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ staff: StaffSchema }) } } }, 400: { description: "Invalid service assignment", content: { "application/json": { schema: ErrorSchema } } } },
});

app.openapi(createStaff, async (c) => {
  const body = c.req.valid("json");
  if (!(await validServiceAssignments(c, body.service_ids))) return c.json({ error: "Servicio no encontrado en la empresa" }, 400);
  const db = c.env.DB;
  let result;
  try {
    result = await db.batch([
      db.prepare("INSERT INTO staff (name, email, phone, title, color, working_hours) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(body.name, body.email || "", body.phone || "", body.title || "", body.color || "#7c3aed", body.working_hours == null ? null : JSON.stringify(body.working_hours)),
      db.prepare("INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES ('staff', last_insert_rowid(), ?)").bind(tenant(c)),
      // One INSERT reads the ownership rowid before any mapping can change it.
      db.prepare(`INSERT INTO staff_services (company_id, staff_id, service_id)
        SELECT ?, o.resource_id, j.value FROM tenant_ownership o, json_each(?) j
        WHERE o.rowid = last_insert_rowid() AND o.resource_type = 'staff' AND o.company_id = ?`)
        .bind(tenant(c), JSON.stringify(body.service_ids ?? []), tenant(c)),
    ]);
  } catch (cause) {
    if (String(cause).includes("staff service must belong to company")) return c.json({ error: "Servicio no encontrado en la empresa" }, 400);
    throw cause;
  }
  const id = Number((result[0].meta as { last_row_id?: number }).last_row_id);
  const staff = (await get<StoredStaff>("SELECT * FROM staff WHERE id = ?", [id]))!;
  return c.json({ staff: { ...staff, service_ids: await assignedServices(tenant(c), id), working_hours: staff.working_hours ? JSON.parse(staff.working_hours) : null } }, 201);
});

const updateStaff = createRoute({
  method: "put",
  path: "/api/staff/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      title: z.string().optional(),
      color: z.string().optional(),
      active: z.number().int().optional(),
      working_hours: StaffHoursSchema.optional(),
      service_ids: ServiceIdsSchema.optional(),
    }) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: OkSchema } } }, 400: { description: "Invalid service assignment", content: { "application/json": { schema: ErrorSchema } } }, 404: NotFoundResponse },
});

app.openapi(updateStaff, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "staff", id))) return c.json({ error: "No encontrado" }, 404);
  const body = c.req.valid("json");
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (!(await validServiceAssignments(c, body.service_ids))) return c.json({ error: "Servicio no encontrado en la empresa" }, 400);
  for (const [key, val] of Object.entries(body)) {
    if (key !== "service_ids" && val !== undefined) {
      sets.push(`${key} = ?`);
      params.push(key === "working_hours" && val !== null ? JSON.stringify(val) : val as string | number | null);
    }
  }
  const db = c.env.DB;
  const statements = [];
  if (sets.length > 0) {
    statements.push(db.prepare(`UPDATE staff SET ${sets.join(", ")} WHERE id = ? AND EXISTS
      (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'staff' AND o.resource_id = staff.id AND o.company_id = ?)`).bind(...params, id, tenant(c)));
  }
  if (body.service_ids !== undefined) {
    statements.push(db.prepare("DELETE FROM staff_services WHERE company_id = ? AND staff_id = ?").bind(tenant(c), id));
    statements.push(db.prepare(`INSERT INTO staff_services (company_id, staff_id, service_id)
      SELECT ?, ?, value FROM json_each(?)`).bind(tenant(c), Number(id), JSON.stringify(body.service_ids)));
  }
  if (statements.length) {
    try { await db.batch(statements); }
    catch (cause) {
      if (String(cause).includes("staff service must belong to company")) return c.json({ error: "Servicio no encontrado en la empresa" }, 400);
      throw cause;
    }
  }
  return c.json({ ok: true }, 200);
});

const deleteStaff = createRoute({
  method: "delete",
  path: "/api/staff/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(deleteStaff, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "staff", id))) return c.json({ error: "No encontrado" }, 404);
  await run(`DELETE FROM staff WHERE id = ? AND EXISTS (SELECT 1 FROM tenant_ownership o
    WHERE o.resource_type = 'staff' AND o.resource_id = staff.id AND o.company_id = ?)`, [id, tenant(c)]);
  return c.json({ ok: true }, 200);
});

// ── Services ──────────────────────────────────────────────────────

const listServices = createRoute({
  method: "get",
  path: "/api/services",
  responses: {
    200: {
      description: "All services",
      content: { "application/json": { schema: z.object({ services: z.array(ServiceSchema) }) } },
    },
  },
});

app.openapi(listServices, async (c) => {
  const services = await query<Record<string, unknown>>(`SELECT s.* FROM services s JOIN tenant_ownership o
    ON o.resource_type = 'services' AND o.resource_id = s.id WHERE o.company_id = ?
    ORDER BY s.category ASC, s.name ASC`, [tenant(c)]);
  return c.json({ services }, 200);
});

const createService = createRoute({
  method: "post",
  path: "/api/services",
  request: {
    body: { content: { "application/json": { schema: z.object({
      name: z.string(),
      description: z.string().optional(),
      duration: z.number().int().optional(),
      price: z.number().optional(),
      color: z.string().optional(),
      category: z.string().optional(),
    }) } } },
  },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ service: ServiceSchema }) } } } },
});

app.openapi(createService, async (c) => {
  const body = c.req.valid("json");
  const id = await insertOwned(c, "services",
    "INSERT INTO services (name, description, duration, price, color, category) VALUES (?, ?, ?, ?, ?, ?)",
    [body.name, body.description || "", body.duration || 60, body.price || 0, body.color || "#6b7280", body.category || ""],
  );
  const service = await get<Record<string, unknown>>("SELECT * FROM services WHERE id = ?", [id]);
  return c.json({ service }, 201);
});

const updateService = createRoute({
  method: "put",
  path: "/api/services/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      duration: z.number().int().optional(),
      price: z.number().optional(),
      color: z.string().optional(),
      category: z.string().optional(),
      active: z.number().int().optional(),
    }) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(updateService, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "services", id))) return c.json({ error: "No encontrado" }, 404);
  const body = c.req.valid("json");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  if (sets.length > 0) {
    await run(`UPDATE services SET ${sets.join(", ")} WHERE id = ? AND EXISTS
      (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'services' AND o.resource_id = services.id AND o.company_id = ?)`, [...params, id, tenant(c)]);
  }
  return c.json({ ok: true }, 200);
});

const deleteService = createRoute({
  method: "delete",
  path: "/api/services/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(deleteService, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "services", id))) return c.json({ error: "No encontrado" }, 404);
  await run(`DELETE FROM services WHERE id = ? AND EXISTS (SELECT 1 FROM tenant_ownership o
    WHERE o.resource_type = 'services' AND o.resource_id = services.id AND o.company_id = ?)`, [id, tenant(c)]);
  return c.json({ ok: true }, 200);
});

// ── Blocked Slots ─────────────────────────────────────────────────

const createBlockedSlot = createRoute({
  method: "post",
  path: "/api/blocked-slots",
  request: {
    body: { content: { "application/json": { schema: z.object({
      staff_id: z.number().int(),
      blocked_date: z.string(),
      start_time: z.string(),
      end_time: z.string(),
      reason: z.string().optional(),
      allow_conflict: z.boolean().optional().openapi({
        description: "Block the time even though it overlaps an appointment or another blocked slot.",
      }),
    }) } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid times", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Staff member already has an appointment or blocked time", content: { "application/json": { schema: ConflictSchema } } },
  },
});

app.openapi(createBlockedSlot, async (c) => {
  const { allow_conflict, ...body } = c.req.valid("json");
  if (!(await owns(c, "staff", body.staff_id))) return c.json({ error: "Personal no encontrado" }, 400);
  const start = toMinutes(body.start_time);
  const end = toMinutes(body.end_time);
  if (start === null || end === null) return c.json({ error: "Los horarios deben tener formato HH:MM" }, 400);
  if (end <= start) return c.json({ error: "El horario bloqueado debe terminar después de comenzar en el mismo día" }, 400);

  if (!allow_conflict) {
    const conflicts = findConflicts(
      body.start_time,
      body.end_time,
      await busyFor(c, body.staff_id, body.blocked_date),
    );
    if (conflicts.length > 0) {
      return c.json({ error: describeConflicts(await staffName(c, body.staff_id), conflicts, "block"), conflicts }, 409);
    }
  }

  await insertOwned(c, "blocked_slots",
    "INSERT INTO blocked_slots (staff_id, blocked_date, start_time, end_time, reason) VALUES (?, ?, ?, ?, ?)",
    [body.staff_id, body.blocked_date, body.start_time, body.end_time, body.reason || ""],
  );
  return c.json({ ok: true }, 201);
});

const deleteBlockedSlot = createRoute({
  method: "delete",
  path: "/api/blocked-slots/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(deleteBlockedSlot, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "blocked_slots", id))) return c.json({ error: "No encontrado" }, 404);
  await run(`DELETE FROM blocked_slots WHERE id = ? AND EXISTS (SELECT 1 FROM tenant_ownership o
    WHERE o.resource_type = 'blocked_slots' AND o.resource_id = blocked_slots.id AND o.company_id = ?)`, [id, tenant(c)]);
  return c.json({ ok: true }, 200);
});

// ── Products ──────────────────────────────────────────────────────

const listProducts = createRoute({
  method: "get",
  path: "/api/products",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
      category: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated product list",
      content: { "application/json": { schema: z.object({ products: z.array(ProductSchema), total: z.number().int() }) } },
    },
  },
});

app.openapi(listProducts, async (c) => {
  const q = c.req.valid("query");
  const page = parseInt(q.page || "1", 10);
  const limit = parseInt(q.limit || "50", 10);
  const offset = (page - 1) * limit;

  let where = "WHERE o.resource_type = 'products' AND o.company_id = ?";
  const params: unknown[] = [tenant(c)];
  if (q.search) {
    where += " AND (p.name LIKE ? OR p.brand LIKE ? OR p.sku LIKE ?)";
    const s = `%${q.search}%`;
    params.push(s, s, s);
  }
  if (q.category) { where += " AND p.category = ?"; params.push(q.category); }

  const total = await get<{ count: number }>(`SELECT COUNT(*) as count FROM products p JOIN tenant_ownership o ON o.resource_id = p.id ${where}`, params);
  const products = await query<Record<string, unknown>>(
    `SELECT p.* FROM products p JOIN tenant_ownership o ON o.resource_id = p.id ${where} ORDER BY p.name ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return c.json({ products, total: total?.count || 0 }, 200);
});

const createProduct = createRoute({
  method: "post",
  path: "/api/products",
  request: {
    body: { content: { "application/json": { schema: z.object({
      name: z.string(),
      brand: z.string().optional(),
      category: z.string().optional(),
      sku: z.string().optional(),
      price: z.number().min(0).optional(),
      cost: z.number().min(0).optional(),
      stock: z.number().int().min(0).optional(),
      low_stock_alert: z.number().int().min(0).optional(),
    }) } } },
  },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ product: ProductSchema }) } } } },
});

app.openapi(createProduct, async (c) => {
  const body = c.req.valid("json");
  const id = await insertOwned(c, "products",
    "INSERT INTO products (name, brand, category, sku, price, cost, stock, low_stock_alert) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [body.name, body.brand || "", body.category || "", body.sku || "",
    body.price ?? 0, body.cost ?? 0, body.stock ?? 0, body.low_stock_alert ?? 5],
  );
  const product = await get<Record<string, unknown>>("SELECT * FROM products WHERE id = ?", [id]);
  return c.json({ product }, 201);
});

const updateProduct = createRoute({
  method: "put",
  path: "/api/products/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      name: z.string().optional(),
      brand: z.string().optional(),
      category: z.string().optional(),
      sku: z.string().optional(),
      price: z.number().min(0).optional(),
      cost: z.number().min(0).optional(),
      stock: z.number().int().min(0).optional(),
      low_stock_alert: z.number().int().min(0).optional(),
    }) } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(updateProduct, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "products", id))) return c.json({ error: "No encontrado" }, 404);
  const body = c.req.valid("json");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (val !== undefined) { sets.push(`${key} = ?`); params.push(val); }
  }
  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    await run(`UPDATE products SET ${sets.join(", ")} WHERE id = ? AND EXISTS
      (SELECT 1 FROM tenant_ownership o WHERE o.resource_type = 'products' AND o.resource_id = products.id AND o.company_id = ?)`, [...params, id, tenant(c)]);
  }
  return c.json({ ok: true }, 200);
});

const deleteProduct = createRoute({
  method: "delete",
  path: "/api/products/{id}",
  request: { params: IdParam },
  responses: { 200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } }, 404: NotFoundResponse },
});

app.openapi(deleteProduct, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await owns(c, "products", id))) return c.json({ error: "No encontrado" }, 404);
  await run(`DELETE FROM products WHERE id = ? AND EXISTS (SELECT 1 FROM tenant_ownership o
    WHERE o.resource_type = 'products' AND o.resource_id = products.id AND o.company_id = ?)`, [id, tenant(c)]);
  return c.json({ ok: true }, 200);
});

// ── Public booking (customer-facing) ──────────────────────────────

const SlugParam = z.object({ slug: z.string().min(1).max(120).openapi({ description: "Public booking slug" }) });

app.get("/api/company/booking", async (c) => {
  const company = await get<{ slug: string | null; business_hours: string }>(
    "SELECT slug, business_hours FROM companies WHERE id = ?", [tenant(c)]);
  return c.json({ slug: company?.slug ?? null, business_hours: JSON.parse(company?.business_hours ?? "{}") });
});

app.put("/api/company/business-hours", async (c) => {
  const hours = normalizeHours(await c.req.json().catch(() => null));
  if (!hours) return c.json({ error: "Horarios inválidos: use HH:mm, apertura anterior al cierre e intervalos sin superposición para cada día" }, 400);
  await run("UPDATE companies SET business_hours = ? WHERE id = ?", [JSON.stringify(hours), tenant(c)]);
  return c.json({ ok: true });
});

// Until business timezones are configurable, booking wall clocks explicitly use UTC.
function futureBooking(date: string, time = "23:59"): boolean {
  return weekdayOf(date) !== null && `${date}T${time}` > new Date().toISOString().slice(0, 16);
}

/** Open the owner can set: the public link customers are invited through. */
const setCompanySlug = createRoute({
  method: "put",
  path: "/api/company/slug",
  request: {
    body: { content: { "application/json": { schema: z.object({
      slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and dashes")
        .min(3).max(60),
    }) } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.object({ ok: z.boolean(), slug: z.string() }) } } },
    400: { description: "Invalid slug", content: { "application/json": { schema: ErrorSchema } } },
    404: NotFoundResponse,
    409: { description: "Slug already taken", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(setCompanySlug, async (c) => {
  const { slug } = c.req.valid("json");
  try {
    const result = await run("UPDATE companies SET slug = ? WHERE id = ?", [slug, tenant(c)]);
    return result.changes ? c.json({ ok: true, slug }, 200) : c.json({ error: "Empresa inexistente" }, 404);
  } catch { return c.json({ error: "El enlace ya está en uso" }, 409); }
});

const publicOverview = createRoute({
  method: "get",
  path: "/api/public/{slug}/overview",
  request: { params: SlugParam },
  responses: {
    200: {
      description: "What a customer sees before booking",
      content: { "application/json": { schema: z.object({
        company: z.object({ name: z.string(), slug: z.string(), business_hours: BusinessHoursSchema }),
        services: z.array(z.object({ id: z.number().int(), name: z.string(), duration: z.number().int(), price: z.number() })),
        staff: z.array(z.object({ id: z.number().int(), name: z.string(), title: z.string(), color: z.string(), service_ids: z.array(z.number().int()), effective_hours: BusinessHoursSchema })),
        google_sign_in: z.boolean(),
      }) } },
    },
    404: NotFoundResponse,
  },
});

app.openapi(publicOverview, async (c) => {
  const company = await companyBySlug(c.req.valid("param").slug);
  if (!company) return c.json({ error: "Empresa no encontrada" }, 404);
  const services = await query<{ id: number; name: string; duration: number; price: number }>(
    `SELECT s.id, s.name, s.duration, s.price FROM services s JOIN tenant_ownership o
     ON o.resource_type = 'services' AND o.resource_id = s.id
     WHERE o.company_id = ? AND s.active = 1 ORDER BY s.name ASC, s.id ASC`, [company.id]);
  const staff = await query<{ id: number; name: string; title: string; color: string; working_hours: string | null }>(
    `SELECT s.id, s.name, s.title, s.color, s.working_hours FROM staff s JOIN tenant_ownership o
     ON o.resource_type = 'staff' AND o.resource_id = s.id
     WHERE o.company_id = ? AND s.active = 1 ORDER BY s.name ASC, s.id ASC`, [company.id]);
  const hours = parseBusinessHours(company.business_hours);
  return c.json({
    company: {
      name: company.name,
      slug: company.slug,
      business_hours: Object.fromEntries(Object.entries(hours).map(([day, windows]) =>
        [day, windows.map((window) => [minutesToTime(window.start), minutesToTime(window.end)])])),
    },
    services,
    staff: await Promise.all(staff.map(async ({ working_hours, ...member }) => ({ ...member,
      effective_hours: Object.fromEntries(Object.entries(effectiveWeeklyHours(hours, working_hours)).map(([day, windows]) =>
        [day, windows.map((window) => [minutesToTime(window.start), minutesToTime(window.end)])])),
      service_ids: (await assignedServices(company.id, member.id)).filter((id) => services.some((service) => service.id === id)) }))),
    google_sign_in: Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
  }, 200);
});

const publicSlots = createRoute({
  method: "get",
  path: "/api/public/{slug}/slots",
  request: {
    params: SlugParam,
    query: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ description: "Booking date, business local time" }),
      service_id: z.string().openapi({ description: "Service ID listed in the overview" }),
      staff_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Free start times for the day",
      content: { "application/json": { schema: z.object({
        slots: z.array(z.string()),
        any: z.boolean().optional().openapi({ description: "Present when no staff member was picked: any free staff member would do" }),
      }) } },
    },
    400: { description: "Unknown service or staff member for this company", content: { "application/json": { schema: ErrorSchema } } },
    404: NotFoundResponse,
  },
});

app.openapi(publicSlots, async (c) => {
  const query = c.req.valid("query");
  if (!futureBooking(query.date)) return c.json({ error: "La fecha debe ser válida y no estar en el pasado" }, 400);
  const company = await companyBySlug(c.req.valid("param").slug);
  if (!company) return c.json({ error: "Empresa no encontrada" }, 404);
  const service = await get<{ duration: number }>(
    `SELECT s.duration FROM services s JOIN tenant_ownership o ON o.resource_type = 'services'
     AND o.resource_id = s.id WHERE s.id = ? AND o.company_id = ? AND s.active = 1`,
    [Number(query.service_id), company.id]);
  if (!service) return c.json({ error: "Servicio no encontrado" }, 400);
  const staffIds: number[] = [];
  const eligible = await activeStaffIds(company.id, Number(query.service_id));
  if (query.staff_id) {
    if (!eligible.includes(Number(query.staff_id))) return c.json({ error: "El profesional no ofrece este servicio" }, 400);
    staffIds.push(Number(query.staff_id));
  } else {
    staffIds.push(...eligible);
  }
  const hours = parseBusinessHours(company.business_hours);
  const candidates = await Promise.all(staffIds.map(async (staffId) => {
    const member = await get<{ working_hours?: string | null }>("SELECT * FROM staff WHERE id = ?", [staffId]);
    const busy = await busyForOwner(c.env.DB, company.id, staffId, query.date);
    return effectiveWindows(hours, member?.working_hours, query.date).flatMap((window) => slotStarts(window, service.duration))
      .filter((time) => futureBooking(query.date, time) && findConflicts(time, addMinutes(time, service.duration), busy).length === 0);
  }));
  return c.json({
    slots: [...new Set(candidates.flat())].sort(),
    ...(query.staff_id ? {} : { any: true }),
  }, 200);
});

const publicBook = createRoute({
  method: "post",
  path: "/api/public/{slug}/book",
  request: {
    params: SlugParam,
    body: { content: { "application/json": { schema: z.object({
      service_id: z.number().int(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      staff_id: z.number().int().optional(),
    }) } } },
  },
  responses: {
    201: {
      description: "Confirmed booking",
      content: { "application/json": { schema: z.object({ appointment: z.object({
        id: z.number().int(), identifier: z.string(), scheduled_date: z.string(),
        start_time: z.string(), end_time: z.string(), status: z.string(),
      }) }) } },
    },
    400: { description: "Unknown service or staff member for this company", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Customer sign-in required", content: { "application/json": { schema: ErrorSchema } } },
    404: NotFoundResponse,
    409: { description: "Slot is no longer available", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Booking requires D1 transactions", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(publicBook, async (c) => {
  const body = c.req.valid("json");
  const company = await companyBySlug(c.req.valid("param").slug);
  if (!company) return c.json({ error: "Empresa no encontrada" }, 404);
  if (!futureBooking(body.date, body.start_time)) return c.json({ error: "La fecha y hora deben ser válidas y futuras" }, 400);
  const db = c.env.DB;
  if (!db?.batch) return c.json({ error: "Se requieren transacciones D1" }, 503);
  const service = await get<{ duration: number; price: number }>(
    `SELECT s.duration, s.price FROM services s JOIN tenant_ownership o ON o.resource_type = 'services'
     AND o.resource_id = s.id WHERE s.id = ? AND o.company_id = ? AND s.active = 1`,
    [body.service_id, company.id]);
  if (!service) return c.json({ error: "Servicio no encontrado" }, 400);
  const start = toMinutes(body.start_time);
  if (start === null) return c.json({ error: "Los horarios deben tener formato HH:MM" }, 400);
  const hours = parseBusinessHours(company.business_hours);
  const endTime = addMinutes(body.start_time, service.duration);
  if (start % 30 !== 0 || !fitsWindows(windowsOnDate(hours, body.date), start, service.duration)) {
    return c.json({ error: "Slot is no longer available" }, 409);
  }

  let staffId: number | null = null;
  if (body.staff_id !== undefined) {
    const member = await get<{ id: number; working_hours?: string | null }>(
      `SELECT s.* FROM staff s JOIN tenant_ownership o ON o.resource_type = 'staff'
        AND o.resource_id = s.id JOIN staff_services ss ON ss.staff_id = s.id AND ss.company_id = o.company_id
        WHERE s.id = ? AND o.company_id = ? AND s.active = 1 AND ss.service_id = ?`,
       [body.staff_id, company.id, body.service_id]);
    if (!member) return c.json({ error: "El profesional no ofrece este servicio" }, 400);
    if (!fitsWindows(effectiveWindows(hours, member.working_hours, body.date), start, service.duration)) return c.json({ error: "Slot is no longer available" }, 409);
    staffId = member.id;
  } else {
    for (const candidate of await query<{ id: number; working_hours?: string | null }>(`SELECT s.* FROM staff s JOIN tenant_ownership o
        ON o.resource_type = 'staff' AND o.resource_id = s.id
        JOIN staff_services ss ON ss.staff_id = s.id AND ss.company_id = o.company_id AND ss.service_id = ?
        WHERE o.company_id = ? AND s.active = 1 ORDER BY s.name ASC, s.id ASC`, [body.service_id, company.id])) {
      if (fitsWindows(effectiveWindows(hours, candidate.working_hours, body.date), start, service.duration) && findConflicts(body.start_time, endTime, await busyForOwner(c.env.DB, company.id, candidate.id, body.date)).length === 0) {
        staffId = candidate.id;
        break;
      }
    }
    if (staffId === null) return c.json({ error: "Slot is no longer available" }, 409);
  }
  if (staffId !== null && findConflicts(body.start_time, endTime,
    await busyForOwner(c.env.DB, company.id, staffId, body.date)).length > 0) {
    return c.json({ error: "Slot is no longer available" }, 409);
  }

  // One file per customer per company, matched on the verified email.
  const email = c.get("customer").email.trim().toLowerCase();
  const client = await get<{ id: number }>(`SELECT c.id FROM clients c JOIN tenant_ownership o
    ON o.resource_type = 'clients' AND o.resource_id = c.id
    WHERE o.company_id = ? AND lower(trim(c.email)) = ? ORDER BY c.id LIMIT 1`, [company.id, email]);
  const clientStatements = client ? [] : [
    db.prepare("INSERT INTO clients (name, email, phone, notes) VALUES (?, ?, '', '')")
      .bind(c.get("customer").name.trim().slice(0, 120) || email, email),
    db.prepare("INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES ('clients', last_insert_rowid(), ?)").bind(company.id),
  ];
  const admissionId = crypto.randomUUID();

  // Global identifier sequence remains unique across companies. Its increment,
  // booking, service link and ownership all commit in one D1 transaction — same
  // pattern as the tenant's `/api/appointments`, with a hard 'confirmed' status.
  let results;
  try {
    results = await db.batch([
    db.prepare("INSERT INTO public_booking_admission (id, company_id, staff_id, service_id, scheduled_date, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(admissionId, company.id, staffId, body.service_id, body.date, body.start_time, endTime),
    ...clientStatements,
    db.prepare(`INSERT OR IGNORE INTO _meta (key, value)
      SELECT 'appointment_counter', CAST(COALESCE(MAX(CAST(SUBSTR(identifier, 5) AS INTEGER)), 0) AS TEXT)
      FROM appointments WHERE identifier GLOB 'APT-[0-9]*'`).bind(),
    db.prepare("UPDATE _meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'appointment_counter'").bind(),
    db.prepare(`INSERT INTO appointments (identifier, client_id, staff_id, status, scheduled_date, start_time, end_time, total_price, notes, is_recurring, recurrence_interval)
      VALUES (COALESCE((SELECT value FROM _meta WHERE key = 'appointment_prefix'), 'APT') || '-' ||
       (SELECT value FROM _meta WHERE key = 'appointment_counter'),
       (SELECT c.id FROM clients c JOIN tenant_ownership o ON o.resource_type = 'clients' AND o.resource_id = c.id
         WHERE o.company_id = ? AND lower(trim(c.email)) = ? ORDER BY c.id LIMIT 1), ?, 'confirmed', ?, ?, ?, ?, '', 0, '')`).bind(
       company.id, email, staffId, body.date, body.start_time, endTime, service.price,
    ),
    db.prepare("INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES ('appointments', last_insert_rowid(), ?)").bind(company.id),
    db.prepare(`INSERT INTO appointment_services (appointment_id, service_id, price, duration)
      VALUES ((SELECT a.id FROM appointments a JOIN tenant_ownership o ON o.resource_type = 'appointments'
        AND o.resource_id = a.id AND o.company_id = ? WHERE a.identifier =
        COALESCE((SELECT value FROM _meta WHERE key = 'appointment_prefix'), 'APT') || '-' ||
        (SELECT value FROM _meta WHERE key = 'appointment_counter')), ?, ?, ?)`).bind(company.id, body.service_id, service.price, service.duration),
    db.prepare("INSERT INTO tenant_ownership (resource_type, resource_id, company_id) VALUES ('appointment_services', last_insert_rowid(), ?)").bind(company.id),
    db.prepare("DELETE FROM public_booking_admission WHERE id = ?").bind(admissionId),
  ]);
  } catch (cause) {
    if (String(cause).includes("public booking conflict")) return c.json({ error: "Slot is no longer available" }, 409);
    throw cause;
  }
  const inserted = results[3 + clientStatements.length];
  if (inserted.meta.changes !== 1) return c.json({ error: "No se pudo crear el turno" }, 503);
  const appointmentId = Number((inserted.meta as { last_row_id?: number }).last_row_id);
  const appointment = await get<{ identifier: string; scheduled_date: string; start_time: string; end_time: string; status: string }>(
    "SELECT identifier, scheduled_date, start_time, end_time, status FROM appointments WHERE id = ?", [appointmentId]);
  if (!appointment) return c.json({ error: "No se pudo crear el turno" }, 503);
  return c.json({ appointment: { id: appointmentId, ...appointment } }, 201);
});

export default app;
