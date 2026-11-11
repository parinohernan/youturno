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
- **Private professional agenda** — own appointments, manual customer contact, completion/cancellation/rescheduling, and in-app polling alerts
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

- **Roles.** A `superadmin` operates the platform (provisions companies and users); `tenant` administrators manage their company. A server-side `professional_accounts` restriction maps a tenant identity to one professional and exposes `role: "professional"` in its session; it never grants company-wide access.
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

### Customer trust and first-booking limit

Customer trust belongs to each company's client record, not to a global Google account. Company administrators can change **Estado del cliente** in **Clientes → client detail → Editar**; the list shows the current badge. New clients default to `new` without an extra creation step. Professionals cannot change trust.

| Customer state | New public bookings |
|---|---|
| `new` / Nuevo | At most one active appointment across all professionals and services in that company. |
| `returning` / Recurrente | Normal booking rules, without the first-booking quota. |
| `blocked` / Bloqueado | Denied; existing appointments and data remain unchanged. |

Active means **`booked`, `confirmed`, or `in_progress` with scheduled UTC end strictly after now**. Ongoing appointments count; appointments ending exactly now or earlier do not, without changing their status or history. Cancelling the only active appointment immediately frees the quota without changing `new`; `no_show` also frees it and does not promote. This deliberately allows retrying after an expired unresolved appointment without attendance. Existing scheduling-conflict rules are unchanged. Rescheduling the same appointment adds no quota.

**Completed attendance in this company automatically makes a new customer returning**, including after a manual reset to new or unblocking to new. This is persisted, not just a public response label. Administrator and professional completion both promote atomically. Cancelled, no-show, expired unresolved and other-company history never establish attendance. **Blocked has highest priority** and is never overridden by history. Manual returning is preserved even without attendance; cancellation never demotes it.

**Manual administrator bookings are an explicit override**, including blocked customers and new customers with active appointments. The booking form states this exception; it does not change trust. Blocking does not cancel appointments or prevent management of existing ones. Customers use **Ver mis turnos** in the public wizard to manage their own pending appointments, including when the first-booking limit blocks another booking. No internal customer login, OTP or automated notification was added.

The authenticated `/api/public/{slug}/eligibility` route accepts no identity query and uses only the signed customer's normalized verified Google email. Anonymous overview/slots expose no customer trust, email or quota. The wizard checks eligibility before confirmation and handles authoritative `CUSTOMER_ACTIVE_LIMIT` (`409`) and `CUSTOMER_BLOCKED` (`403`) responses without calling them unavailable hours. Eligibility is advisory: the public D1 batch rechecks current trust and active appointments **before find/create and any counter/contact changes**, alongside existing staff/hours/qualification/conflict guards. Concurrent first bookings cannot each create a client and bypass the limit. Legacy duplicate normalized email files count together; any blocked matching file denies public admission. Different Google provider IDs with the same email reuse the same company identity. Multiple distinct Google email accounts can still evade this policy; it is not a per-person fraud, IP or rate-limiting guarantee.

#### Upgrade an existing database before starting the new API

From the actual project directory (`/home/hernan/dev/youturno/OpenSalon` locally; the operator's existing checkout on the VPS), stop only that API and preserve its `.wrangler` persistence:

```bash
pnpm migrate:local
# Inspect the preview, then explicitly apply with a new private backup path:
pnpm migrate:local --apply --backup /absolute/private/path/unused-customer-trust-backup.sql
```

The local-only script exports a new nonempty private backup before additive changes. It adds missing columns, replaces the old customer quota/action guards and installs shared database-clock policy views. Existing `new` clients with completed appointment history owned by that same company become `returning`, including manual resets; blocked and manual returning states remain unchanged. Only approved `new` → `returning` flags change during reconciliation: no appointment, contact or counter values are rewritten. Reruns are idempotent. Verify application-table counts and original values (allowing only these trust-flag changes), `PRAGMA foreign_key_check`, and reapply before restarting the API manually. On the VPS, the operator must run this same **local** backup/apply procedure against its persisted database after updating code; never use `--remote`, apply `schema.sql` alone, replace persistence or start the API automatically.

The VPS operator must run this against the same **Wrangler local D1** persistence as their API; source deployment alone is insufficient. Do not use `--remote`, apply only `schema.sql`, replace `.wrangler`, or auto-start the API before migration. Other database runtimes require operator-adapted backup and additive migration tooling. Keep backups private; they contain customer and authentication data.

### Customer self-service

At `/book/{slug}`, sign in with Google once and choose **Ver mis turnos** (also available in the limit message and booking confirmation), or open the discreet **Mis turnos** disclosure. The list shows own `booked`, `confirmed` and `in_progress` appointments whose scheduled UTC end is still in the future, ordered chronologically. Ongoing appointments are visible as **En curso** and read-only; expired and terminal appointments are omitted. Links use `?turnos=lista` or `?turnos={id}` and survive refresh/back navigation. A restored login intent never submits a booking or appointment change automatically. The interactive company preview does not fetch customer appointments or perform real actions.

| Action | Customer boundary |
|---|---|
| View | Separate signed `yt_book` Google customer session; current normalized verified email matched to client files in the active slug's company. Tenant/professional cookies grant no customer access. Minimal appointment fields only, no private notes, other clients' contacts or operational history. |
| Cancel | Own future-start `booked`/`confirmed` appointment, explicit named confirmation. History and service links remain; the new-customer quota is freed immediately when no active appointments remain. Trust is unchanged. |
| Reschedule | Own future-start `booked`/`confirmed` appointment; only day/start change after a separate review and confirmation. ID, staff, client, every service link, duration and price remain unchanged. No conflict override. |
| Restricted states | Blocked customers may manage existing future-start appointments without unblocking or creating another booking. `in_progress`, ongoing and expired appointments are read-only, including direct detail/action requests. Terminal appointments cannot be changed. |

Own availability excludes the appointment itself and checks current active staff, **every** service's activity/qualification, effective company/personal split hours, conflicts and the same three public scheduling modes. Multi-service moves preserve the actual whole reserved interval (including any manual duration adjustment); service-duration cadence uses that whole interval from each effective opening, not just the first service. Missing staff/services or withdrawn qualifications require company assistance rather than silently replacing them.

Customer endpoints are `GET /api/public/{slug}/appointments`, `GET .../appointments/{id}`, `GET .../appointments/{id}/slots?date=YYYY-MM-DD`, and `POST .../appointments/{id}/actions`. Actions accept only `{action:"cancel",version}` or `{action:"reschedule",version,date,start_time}`. Identity/company selectors are not accepted. Mutations require the customer cookie plus same-origin JSON (the public flow's CSRF boundary); bounded strict input rejects mass assignment. Cross-company/other-customer IDs return the same `404`. Responses are not cached.

The additive `customer_appointment_admission` table and `customer_appointment_snapshots_v1` view are required: **follow the local D1 stop/preview/private-backup/apply/restart migration procedure above before starting the new API**. They add no customer accounts; migration changes only the approved completed-history trust flags described above. A D1 batch inserts an ephemeral guard row, validates current ownership/status/full snapshot, original future start and current scheduling policy/conflicts, applies the action in a trigger, then deletes the guard. Cancellation versus rescheduling and competing bookings serialize without reopening or deleting the old appointment on failure. Stale state returns `409` and requires another explicit review. SQLite tests simulate serialized D1 batches; they do not establish live distributed D1 concurrency behavior.

After cancellation, the wizard refreshes eligibility and clears stale selected times without a page reload. Company/professional views see the change on their normal refresh/poll cadence; there is no automatic email, SMS, WhatsApp or calendar notification. Contact links are manual. VPS migration/deployment remains the operator's responsibility; never use `--remote` or replace persistence.

### Professional portal upgrade

**Migrate before starting the new API.** Use the backup/preview/apply procedure above against the same local D1 persistence used by the running API. On a VPS, the operator must stop that API, make a new private backup, apply the local migration explicitly, and restart it. Never use `--remote` or replace `.wrangler/`. Source deployment alone is not a migration.

The upgrade adds empty `professional_accounts` and `professional_appointment_changes` tables and guards. It does not rebuild `users`, change its role CHECK, alter existing appointments, create users, or restrict existing administrators. Reapplying is safe. Verify existing row counts and `PRAGMA foreign_key_check` before and after. Backups include private customer/authentication data: keep them private and do not attach them to reports.

1. The company administrator opens **Equipo → Editar** for an active professional and enters an individual email and a privately agreed password (12–1024 characters) under **Acceso al portal profesional**. Saving creates the restricted access atomically with the staff fields; platform **Crear cuenta** creates company administrators only.
2. Leave the password blank to keep it. Changing the password or linked email closes previous professional sessions; the linked email cannot be cleared or shared with another account. No shared/default passwords or public signup are provided.
3. Share `/profesionales/login`. The professional receives **Mi agenda**, regardless of the private URL opened; no company-wide loader/navigation is mounted. Existing administrators cannot be converted or rebound here. Disable the linked staff member to remove access. Deleted staff leave a denied restriction, never an administrator account.

### Professional portraits

In **Equipo → Agregar integrante / Editar**, choose, replace or remove the optional **Foto del profesional**, then save the staff form. The local preview does not publish anything; cancel discards the draft. Photo, staff fields, services, hours and any professional credential change commit together. Omitting `photo` in an API update preserves it; `photo: null` explicitly removes it.

Only PNG/JPEG files up to **512 KiB** and **4096 × 4096 pixels** are accepted. Streaming request limits, MIME/signature and dimension checks also run on the server. The additive `staff_photos` table stores bounded BLOBs; normal staff/overview responses return only a versioned URL, never image bytes. Run `pnpm migrate:local` to preview, then `pnpm migrate:local --apply --backup /absolute/private/path/new-portrait-backup.sql` against Wrangler **local** D1 before using the new API. Follow the stop/backup/restart and VPS operator procedure above, not `schema.sql` alone or `--remote`. Existing staff retain all data and initially have no image.

Portraits appear in Equipo, public professional selection and the professional's own agenda. Missing or failed images use a neutral human silhouette. Public image reads intentionally follow the overview policy: active company and active owned staff only. Company administrators can change only their own staff's photos; professionals can read only their own private photo and cannot edit it. Portrait responses contain no contact/account metadata. Company logos and booking covers are unchanged.

### Professional agenda behavior

| Behavior | Boundary |
|---|---|
| Agenda | Selected UTC day, own recurring effective hours, and up to 100 upcoming appointments over 90 days. Detail includes only that appointment's contact, services, notes and professional action history, not full client history. |
| Internal alerts | Poll every 15 seconds while focused, visible and online. First response establishes the baseline; IDs deduplicate later alerts. Failures back off to 120 seconds. No browser permission, push or sound; not instantaneous. |
| Actions | Own nonterminal appointments (`booked`, `confirmed`, `in_progress`) only. Completion means `completed`, never paid. Cancelled/completed appointments cannot be reopened by the professional. |
| Rescheduling | Preserves actual booked interval duration, requires current service qualification and a free interval inside both company and staff hours. Public cadence is intentionally not imposed. No overlap override. Legacy appointments without service links remain finalizable/cancellable but require administrator help to reschedule. |
| Atomicity | SQL admission rechecks current binding/session, assignment/status/snapshot, hours, qualifications and conflicts; audit entry and change commit together. A stale or duplicate action returns `409` without partial history/change. |
| Contact | Cancellation/rescheduling require explicit acknowledgment to coordinate and notify the customer outside the app. The app records the change but does **not** notify the customer. Private phone supports calling/copying; email remains data only. |

New public Google-authenticated bookings require `contact_phone` at confirmation. Accepted input has 7–15 digits, an optional leading `+`, and common spaces/parentheses/hyphens. Separators are removed; no country code is inferred and no OTP verification is claimed. Each successful booking updates the authenticated customer's existing contact **only within the booked company**, or atomically creates that company's client. Failed bookings cannot update the phone. Phone is not returned in anonymous overview/slots or saved with wizard OAuth intent; re-enter it after a full reload. Old clients without a phone remain manageable.

No email/SMS/WhatsApp delivery, provider integrations, Calendar sync, payment, product checkout, WebSockets or SSE are included. The account's current membership and active staff/company are checked on every private request, and all existing tenant-wide routes are denied to professionals.

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
