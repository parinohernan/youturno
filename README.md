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
pnpm run dev
```

1. `pnpm run dev` applies the schema and the additive legacy migration to **local D1**, then starts the UI (Vite, usually `http://localhost:5173`) and the API (`wrangler`, port `8787`).
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

1. Stop the dev server and back up first — for local D1: `pnpm exec wrangler d1 export youturno-db --local --output=backup.sql` (store the export outside the repository).
2. Run `pnpm migrate:local` (or just start `pnpm dev`, which applies it).
3. Keep `.wrangler/` intact — never reset local D1 to perform this migration.

For an existing deployment, back up first, then apply `src/server/schema.sql` followed by `src/server/migrate-legacy.sql` using that deployment's own D1 migration procedure.

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
