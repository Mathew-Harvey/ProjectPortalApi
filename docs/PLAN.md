# PLAN.md — Project Portal (ProjectPortalApi + ProjectPortalWeb)

Mirrors `CONVENTIONS.md` (AppHub). Boring, proven patterns. Built for **job one**
(a marine structural remediation delivery) but named generically and scoped for
future multi-tenancy.

> Status: **Phase 0 plan, pending confirmation of the open questions in §6.**
> Defaults below are what I'll build unless told otherwise.

---

## 1. Domain in one paragraph
Franmarine (integrator/PM) coordinates an asset **owner/client**, an independent
**engineer**, in-house **field** divers, and a rope-access crew. Each **defect**
(`work_item`) runs one fixed lifecycle:

```
find → engineer → fix → verify → closed
```

The engineer is an independent approval gate: a `work_item` **cannot enter
`fix`** until an `approved` `spec` exists. Every state change writes one
append-only `event` row (actor + timestamp). `work_item.method` (`weld` |
`composite`) only selects which **template set** loads — the lifecycle, gate,
event log, roles and client view are identical for both.

## 2. Repos & stack (derived from AppHub — no new deps except §6)

### ProjectPortalApi (Node/Express + PostgreSQL)
Reused from AppHub (identical major versions): `express`, `pg`, `jsonwebtoken`,
`bcryptjs`, `cookie-parser`, `cors`, `helmet`, `express-rate-limit`, `morgan`,
`dotenv`, `multer`, `uuid`. Dev: `jest`, `supertest`, `pg-mem`, `nodemon`.

Structure mirrors AppHub exactly: `config/{db,migrate}.js`, `config/templates.js`
+ `config/seed.js` (seed/config data, the AppHub `demoApplets.js`/`defaultPrompts.js`
analog), `middleware/auth.js`, `routes/*`, `services/{events,media,docpack}.js`,
`tests/`, `index.js`, `render.yaml`, `.env.example`.

**New dependencies (not in AppHub — see §6 for approval):**
- `exifr` — extract EXIF from uploaded media (brief requires `exif` at capture).
- `pdfkit` — assemble the doc-pack PDF (brief requires PDF export).

### ProjectPortalWeb (React/Vite)
Reused from AppHub: `react`, `react-dom`, `react-router-dom`; dev `vite`,
`@vitejs/plugin-react`. **Dropped** (not in scope): `mixpanel-browser`.
Structure mirrors AppHub: `src/{main,App}.jsx`, `components/Layout.jsx`,
`contexts/AuthContext.jsx`, `pages/*`, `utils/api.js`, `styles/global.css`,
`vite.config.js` (proxy `/api` → `:3001`).

## 3. Data model (as specified in the brief)
All tables carry `org_id` and/or `project_id` (multi-tenant scoping columns,
single value today). UUID PKs via `uuid-ossp`. Enums as `VARCHAR + CHECK`.
`event` and `media` are **append-only / immutable after insert**.

```
organisation(id, name)
project(id, org_id→organisation, name, asset_ref)
app_user(id, org_id→organisation, email, name, role)         role: admin_pm|engineer|field|client
work_item(id, project_id→project, org_id, ref_code, location_ref, method, status)
                                                              method: weld|composite
                                                              status: find|engineer|fix|verify|closed
inspection(id, work_item_id→work_item, org_id, template_key, data jsonb, captured_by→app_user, captured_at)
spec(id, work_item_id→work_item, org_id, engineer_id→app_user, doc_media_id→media,
     status, approved_by→app_user, approved_at)               status: draft|approved|superseded
hold_point(id, work_item_id→work_item, org_id, label, sequence, signed_by→app_user, signed_at)
qa_record(id, work_item_id→work_item, org_id, template_key, data jsonb,
          signed_off_by→app_user, client_sign_by→app_user, client_sign_at)
media(id, work_item_id→work_item, org_id, url, mime, sha256, exif jsonb, captured_at, uploaded_by→app_user)
event(id, project_id→project, work_item_id→work_item NULL, org_id, actor_id→app_user,
      type, payload jsonb, created_at)                        -- APPEND ONLY
template(method, kind, definition jsonb)                      kind: rds|itp|qa|docpack
```

### Hard rules enforced in code
1. **Gate:** `work_item` → `fix` requires an `approved` `spec` for it (checked in
   a transaction; otherwise 409).
2. **Every mutation writes an `event`** in the same transaction as the change.
3. **`event` and `media` are never UPDATEd or DELETEd.** No route ever issues
   such SQL; a regression test asserts there are no such statements and that the
   log is append-only.
4. Lifecycle is **hardcoded** `find → engineer → fix → verify → closed` — no
   workflow engine.

## 4. API surface (ProjectPortalApi)
```
GET    /api/health                              SELECT 1
POST   /api/auth/login | logout                 JWT cookie (mirrors AppHub)
GET    /api/auth/me

GET    /api/projects                            list projects (scoped)
GET    /api/projects/:id/events                 project-wide event timeline
GET    /api/projects/:id/work-items             repair register

POST   /api/work-items                          create from RDS  → status find  (admin_pm)
GET    /api/work-items/:id                       full card (inspection/spec/hold points/qa/media/events)
GET    /api/work-items/:id/events                work-item event timeline
POST   /api/work-items/:id/inspection           RDS intake (find)              (admin_pm/field)
POST   /api/work-items/:id/spec                  engineer uploads spec (draft) (engineer)
POST   /api/work-items/:id/spec/:specId/approve  approve spec → status fix     (engineer)  [the gate]
POST   /api/work-items/:id/hold-points/:hpId/sign  sign ITP hold point         (field)
POST   /api/work-items/:id/qa                    capture QA → status verify     (field/admin_pm)
POST   /api/work-items/:id/qa/:qaId/client-sign  client sign-off               (client)
POST   /api/work-items/:id/close                 → status closed                (admin_pm)
POST   /api/work-items/:id/media                 upload (multipart) → sha256+exif computed on receipt
GET    /api/work-items/:id/docpack               PDF assembled from RDS+spec+hold points+QA (method's docpack template)
GET    /api/templates?method=&kind=              template-driven form definitions
```
Role checks via a small `requireRole(...roles)` middleware (role **enum only**,
no permissions matrix). Status transitions validated against the hardcoded
lifecycle. Every successful mutation calls `events.log(client, {...})`.

## 5. Web surface (ProjectPortalWeb)
- Auth + **role-based shell/nav** (`Layout.jsx`, `useAuth`, `ProtectedRoute`).
- **Repair register**: list + `work_item` card showing lifecycle state + evidence.
- **RDS intake** form rendered from the method's `rds` template (`template.definition` jsonb).
- **Engineer gate screen**: upload spec + approve; `fix` actions disabled until approved.
- **ITP checklist** rendered from the `itp` template with per-hold-point sign-off.
- **QA capture** from the `qa` template + **"Export doc pack"** (PDF) button.
- **Client read-only** view: register, evidence, and the event timeline.
- Forms are **template-driven** (a small renderer maps `definition` field specs to
  inputs) so switching `method` changes only the forms/checklist/QA/doc-pack.

## 6. Resolved decisions (confirmed in chat)
1. **New dependencies approved:** `exifr` (EXIF at capture) + `pdfkit` (doc-pack
   PDF). Both added to ProjectPortalApi only.
2. **Media storage = Postgres `bytea`.** Bytes live in the DB (mirrors AppHub's
   "content in DB" pattern; survives Render's ephemeral disk). Served via
   `GET /api/work-items/:id/media/:mediaId`; `media.url` holds that API path.
3. **Auth = JWT cookie (AppHub-style) + self-registration.** Seed one user per
   role with a documented demo password **and** ship a registration flow. New
   users attach to the single seeded organisation and choose a role from the enum
   (no permissions matrix, no tenant management). `login`/`logout`/`me` as well.

## 7. Build order (small, logical commits)
0. Phase 0 docs (this) — both repos.
1. API scaffold: package.json, db, **full migrate.js** (incl. append-only event +
   immutable media), auth, seed org/project/users, health, render.yaml, first tests.
2. Lifecycle + gate + events; media (sha256/exif); doc-pack PDF; seed weld+composite
   template sets (rds/itp/qa/docpack); event read endpoints; tests.
3. Web: scaffold, auth shell, register, RDS intake, engineer gate, ITP, QA+export,
   client view + timeline.
4. End-to-end verification of every acceptance criterion for **both** methods.
