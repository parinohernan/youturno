# YouTurno — Self-Hosted Appointment Scheduling

YouTurno is an open-source booking and business-management platform for salons, barbershops, spas, tattoo studios, and any appointment-based business. It runs entirely on your own infrastructure — **Preact + Tailwind CSS v4 + shadcn/ui** on the client, **Hono on Cloudflare Workers** with **SQLite (D1)** storage. No external services, no per-seat fees, no vendor lock-in.

One deployment can operate **many companies at once** (multi-tenant). See [Multi-Tenancy](#multi-tenancy).

## Features

- **Day calendar view** — staff columns, colored appointment blocks, day navigation, click-to-book empty slots
- **Appointment booking** — client, staff, date/time, multiple services; auto-calculated duration and total price
- **Rescheduling** — move a booking to a new date/time; staff conflicts require an explicit override
- **Blocked time slots** — breaks, lunch hours, or days off per staff member
- **Client management** — contact info, notes, preferences, appointment history
- **Staff management** — color-coded directory, roles, activate/deactivate, booking counts
- **Service catalog** — duration, price, color, category grouping
- **Product inventory** — cost/price, stock levels, low-stock alerts, brand and SKU
- **Multi-tenant** — many companies on one deployment, server-enforced isolation
- **Status workflow** — booked → confirmed → in progress → completed (or cancelled / no-show)
- **Dashboard** — today's appointments, upcoming count, booked service value, low-stock alerts
- **Dual-mode UI** — human-optimized plus agent-friendly (`?agent`) with always-visible actions and large targets

## Quickstart

```bash
git clone https://github.com/parinohernan/youturno.git
cd youturno
pnpm install
pnpm migrate:local
# Apply explicitly with a new absolute backup path (see migration section).
pnpm migrate:local --apply --backup /absolute/private/path/unused-initial-backup.sql
pnpm run dev
```

1. Migrate local D1 explicitly before starting. `pnpm run dev` only starts the UI (Vite, usually `http://localhost:5173`) and the API (`wrangler`, port `8787`); it does not migrate the database.
2. Before the first start, create `.dev.vars` with `AUTH_SECRET=<random secret of at least 32 characters>`. The file is gitignored; keep it private. On production, configure the Worker secret through your own deployment tooling.
3. Sign in from the UI. Local D1 state persists in `.wrangler/`.

## Multi-Tenancy

A single deployment hosts many companies with server-enforced isolation:

- **Roles.** A `superadmin` operates the platform (provisions companies and users); `tenant` users belong to exactly one company.
- **Company scoping.** Every business route — lists, stats, details, calendar, conflict checks, updates, deletes, and every referenced ID — is restricted to the company resolved server-side from the session. Another company's resource IDs return `404`; invalid references return `400`. Database triggers reject cross-company appointment links.
- **Server-side authority only.** Company membership is never taken from client input; the server resolves it from the authenticated session for every request.
- **Onboarding.** An unattached first user names their own company; the company stays **pending** until the platform operator activates it. Additional users require the operator's confirmation.
- **Global identifiers.** Appointment identifiers come from one global atomic counter: `APT-123` is unique across all companies. IDs can have gaps and carry no company information.
- **Session security.** Short-lived signed HttpOnly Secure SameSite cookies, a server-side session version for logout revocation, and a CSRF header supplied by the same-origin UI. On localhost, browsers treat Secure cookies as a localhost exception; use HTTPS on non-local hosts.

**Platform-operator accounts are provisioned privately** by whoever deploys the service — through a local, stdin-based bootstrap command that is never documented with credentials and never published in this repository. There is no public signup or invitation endpoint: ask the platform operator for an account. Even a superadmin has **no access to business data** — operator routes are separate from company routes.

## Existing Databases and Migration

The migration is additive and repeatable: it adds `companies` and `tenant_ownership`, associates existing business rows with one legacy company, and preserves all original tables, IDs, foreign keys, and counter values. It never reassigns existing ownership, and empty databases remain empty.

1. Stop the API. From the project directory, run `pnpm migrate:local` to preview missing columns.
2. Run `pnpm migrate:local --apply --backup /absolute/private/path/unused-backup.sql` with a new path outside the repository. The script verifies a nonempty backup before changing schema.
3. Restart the API. Keep `.wrangler/` intact — never reset local D1 to perform this migration.

These commands support **Wrangler local D1 only**, including a VPS running that same runtime and default persistence directory. They do not support `--remote` or a different persistence location. Match the running API's database before applying. Applying `schema.sql` alone does not upgrade existing columns. For other runtimes, the operator must adapt the introspection/additive column upgrades and schema guards to that deployment's backup/migration tooling. VPS updates are the operator's responsibility.

### Public scheduling upgrade

Existing staff gain `scheduling_mode = 'fixed'` and `scheduling_interval = 30`, preserving the existing public cadence until edited in **Equipo**. Run the preview/apply commands above before starting the new API. The migration also installs the versioned public admission policy trigger. It does not change existing appointments, staff schedules or service assignments.

| Method | Offered starts |
|--------|----------------|
| Consecutive | Only the earliest full-service fit in each effective work interval (morning and afternoon separately). Busy gaps remain part of that interval, not additional choices. |
| Fixed interval | Every X minutes on a midnight-aligned grid; X is an integer from 1 to 240, default 30. For a 09:10 opening and X=30, the first start is 09:30. |
| Service duration | Every selected-service duration from each effective interval's opening. At 09:10 with 45-minute service: 09:10, 09:55, 10:40. Occupied starts are filtered without restarting the sequence. |

Effective intervals intersect company and professional hours. Missing personal days inherit; explicit empty/null days close. All modes occupy the full service duration, allow back-to-back boundaries, reject gaps/conflicts and exclude past starts. Times remain UTC; consecutive starts today use the next whole minute when seconds have elapsed. Switching methods preserves the saved fixed interval. Manual tenant appointments retain their existing explicit-overlap policy.

“Cualquiera” unions eligible professionals' actual candidates and assigns only a professional accepting the selected start. Public admission rechecks current mode/cadence, earliest availability, service duration, qualification, activity, hours and conflicts inside the atomic D1 batch, before any client or appointment insert. A stale selection returns `409`; malformed requests return `400`.

### Company social links upgrade

Existing databases need `companies.social_links` before running the updated API. For a VPS using this repository's Wrangler **local D1** runtime, stop its API and run from the project directory, preserving its existing `.wrangler` state:

```bash
pnpm migrate:local
umask 077
pnpm migrate:local --apply --backup /absolute/private/path/new-social-links-backup.sql
```

The first command previews changes; the second exports and verifies a new nonempty backup before applying missing columns and additive schema. Restart the API afterward. The script is local-only: do not pass `--remote`. If the deployment uses a different database runtime, use its own backup/migration tooling to inspect `PRAGMA table_info(companies)` and, only if missing, apply `ALTER TABLE companies ADD COLUMN social_links TEXT NOT NULL DEFAULT '{}';` before updating the API. Applying `schema.sql` alone does not upgrade an existing table. VPS updates are the operator's responsibility.

The company profile supports optional Instagram, Facebook, TikTok, YouTube and LinkedIn links. URLs must use HTTP(S), contain no username/password, and fit within 500 characters after trimming; HTTPS is recommended. Links are ordinary public outbound links, without embedded content or social SDKs. Profile updates preserve omitted fields; an empty social-link string removes that network, and `social_links: {}` clears all networks. Other social keys are rejected.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Preact, TypeScript, Vite |
| **Styling** | Tailwind CSS v4, shadcn/ui |
| **Backend** | Hono on Cloudflare Workers (`wrangler`) |
| **Database** | SQLite via Cloudflare D1 (local development with `wrangler dev`) |
| **Validation** | Zod, @hono/zod-openapi |
| **Icons** | Lucide |

## Architecture

```
src/
  server/
    schema.sql          — SQLite schema (business + auth + company tables)
    migrate-legacy.sql  — additive legacy migration for existing databases
    db.ts               — D1 helpers (query, get, run)
    auth.ts             — password hashing, tokens, session helpers
    scheduling.ts       — overlap detection and conflict descriptions
    index.ts            — Hono REST API with OpenAPI schemas
  client/
    app.tsx             — Root component: session, login, routing
    context.tsx         — App context (state interface)
    hooks/
      use-app.ts        — State management, CRUD operations, API calls
      use-router.ts     — pushState URL routing
    components/
      ui/                          — shadcn/ui primitives
      sidebar.tsx                  — Navigation with live counts
      calendar-view.tsx            — Day calendar with staff columns
      appointment-*.tsx            — List, detail, booking dialog
      client-*.tsx                 — List, detail with history, dialog
      staff-list.tsx, create-staff.tsx
      service-list.tsx, create-service.tsx
      product-list.tsx, create-product.tsx
      status-badge.tsx, pagination.tsx, error-banner.tsx
```

### Data Model

```sql
companies            (id, name, status, created_at)
tenant_ownership     (table_name, row_id, company_id)   -- one row per business row
users                (id, email, password_hash, role, company_id, session_version)
auth_audit           (role, event, ...)
business tables
  clients              (id, name, email, phone, notes)
  staff                (id, name, email, phone, title, color, active)
  services             (id, name, description, duration, price, color, category, active)
  appointments         (id, identifier, client_id, staff_id, status, scheduled_date,
                        start_time, end_time, total_price, notes, is_recurring,
                        recurrence_interval)
  appointment_services (id, appointment_id, service_id, price, duration)
  appointment_notes    (id, appointment_id, content)
  blocked_slots        (id, staff_id, blocked_date, start_time, end_time, reason)
  products             (id, name, brand, category, sku, price, cost, stock,
                        low_stock_alert)
```

### API

All business endpoints below require an authenticated session of an **active company**; responses are always company-scoped. Operator endpoints live under `/api/admin/*` and require the superadmin role.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Sign in (email + password) |
| GET | `/api/auth/session` | Current session |
| POST | `/api/auth/logout` | Revoke the session |
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/calendar` | Appointments + blocked slots for a date range |
| GET | `/api/appointments` | List appointments (paginated, filterable) |
| POST | `/api/appointments` | Create appointment with service IDs |
| GET/PUT/DELETE | `/api/appointments/:id` | Detail, update, delete |
| POST | `/api/appointments/:id/notes` | Add note · `DELETE /api/notes/:id` |
| GET | `/api/clients` | List clients (paginated, searchable) |
| GET/POST | `/api/clients` | `…/all` lookup list · create |
| GET/PUT/DELETE | `/api/clients/:id` | Detail with history, update, delete |
| GET | `/api/staff` | List staff with counts · `…/all` lookups |
| POST | `/api/staff` | Create · `PUT /api/staff/:id` update · `DELETE` |
| GET | `/api/services` | List · create · `PUT /:id` · `DELETE /:id` |
| POST | `/api/blocked-slots` | Block time · `DELETE /api/blocked-slots/:id` |
| GET | `/api/products` | List products, searchable · CRUD same shape |

## License

AGPL-3.0
