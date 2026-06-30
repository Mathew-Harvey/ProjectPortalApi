# Claude Code build brief — Project Portal

You are building a new two-repo application. Work methodically, commit in small
logical increments, and prefer boring, proven patterns over clever ones. Do
Phase 0 before writing any application code.

## Repos
- **AppHub** — existing repo. READ-ONLY reference. Do not modify it. Review it to
  learn and copy my conventions (stack, structure, auth, DB access, config,
  deploy, lint/format).
- **ProjectPortalApi** — new. Node/Express + PostgreSQL backend.
- **ProjectPortalWeb** — new. React/Vite frontend.

## What this app is (context)
A project-delivery portal for marine structural remediation. Franmarine is the
integrator/PM coordinating four parties: an asset owner (client), an independent
third-party engineer, in-house divers, and a subcontracted rope-access crew.

Each defect on the structure runs one fixed lifecycle:

```
find  ->  engineer  ->  fix  ->  verify  ->  closed
```

The engineer is an independent approval gate: execution (`fix`) is locked until
the engineering spec is signed. Every action is recorded in an append-only event
log — this audit trail is the product's core value (contractual transparency) and
must exist from the very first commit.

This job is customer #1. The foundation must extend into a future MarineStream
SaaS product, so the domain model is named generically and scoped for
multi-tenancy — but no tenant-management features are built yet.

The same app must serve two bid variants with no structural change:
- a conforming weld / fabrication repair, and
- a non-conforming composite (carbon-fibre wrap) repair.

`method` is a field on the work item that selects a template set. The lifecycle,
gate, event log, roles and client view are identical for both methods.

## Phase 0 — review AppHub, plan, confirm (do this first)
1. Explore the AppHub repo and produce `docs/CONVENTIONS.md` capturing exactly how
   I build: project/folder structure, DB access library and migration approach,
   auth approach, env/config handling, error/response patterns, API route
   structure, frontend component/routing/state/styling patterns, lint/format
   config, and the Render deploy setup (e.g. `render.yaml`).
2. Produce `docs/PLAN.md` for the two new repos that mirrors those conventions.
3. List the concrete stack and libraries you intend to use, derived from AppHub.
   Match AppHub — do not introduce dependencies it doesn't already use without
   flagging them first.
4. Ask me any blocking questions, then proceed through the phases below.

Expected baseline (confirm against AppHub, which is authoritative): React/Vite +
Node/Express + PostgreSQL on Render.

## Durable core — get these right (they cannot be retrofitted later)
1. **Append-only event log.** Every state change, approval, sign-off and upload
   writes one `event` row with actor and timestamp. Never UPDATE or DELETE event
   rows. This is the foundation, not a feature.
2. **Generic naming + scoping.** Use `work_item`, not `jetty_repair`. Put `org_id`
   / `project_id` on every table even though there is one value today.
3. **Media provenance at capture.** Store `sha256`, `exif`, `captured_at` and
   `uploaded_by` the moment a file lands. Media rows are immutable after insert.
4. **`method` selects templates.** `work_item.method` is `weld | composite`. It
   chooses which template set loads — nothing else branches on it.
5. **Templates are config/seed data, not hardcoded branches.** Use `jsonb` for
   inspection and QA payloads so form fields are template-driven, not
   migration-driven.

## Data model (ProjectPortalApi)
```
organisation(id PK, name)
project(id PK, org_id FK->organisation, name, asset_ref)
app_user(id PK, org_id FK->organisation, email, name, role)
    role in {admin_pm, engineer, field, client}
work_item(id PK, project_id FK->project, ref_code, location_ref, method, status)
    method in {weld, composite}
    status in {find, engineer, fix, verify, closed}
inspection(id PK, work_item_id FK->work_item, template_key, data jsonb, captured_by FK->app_user, captured_at)
spec(id PK, work_item_id FK->work_item, engineer_id FK->app_user, doc_media_id FK->media,
     status, approved_by FK->app_user, approved_at)
    status in {draft, approved, superseded}
hold_point(id PK, work_item_id FK->work_item, label, sequence, signed_by FK->app_user, signed_at)
qa_record(id PK, work_item_id FK->work_item, template_key, data jsonb,
          signed_off_by FK->app_user, client_sign_by FK->app_user, client_sign_at)
media(id PK, work_item_id FK->work_item, url, mime, sha256, exif jsonb, captured_at, uploaded_by FK->app_user)
event(id PK, project_id FK->project, work_item_id FK->work_item NULL, actor_id FK->app_user,
      type, payload jsonb, created_at)   -- APPEND ONLY
template(method, kind, definition jsonb)  -- seed/config
    kind in {rds, itp, qa, docpack}
```

Hard rules to enforce in code:
- A `work_item` may not transition to `fix` unless an `approved` `spec` exists for it.
- Every mutation writes a corresponding `event`.
- `event` and `media` are never updated or deleted.

## Build scope for job one (keep it small)
### ProjectPortalApi
- Migrations for the schema above; seed one organisation, one project (the jetty
  asset), and one user per role.
- Auth mirroring AppHub; role enum only (no permissions matrix).
- Lifecycle endpoints: create work_item from an RDS (`find`); submit + approve
  spec (the gate; moves to `fix`); sign ITP hold points; capture QA (`verify`) and
  client sign; close.
- Media upload endpoint computing `sha256` and extracting `exif` on receipt.
- Event written on every mutation; a read endpoint to list events for a
  work_item / project.
- Doc-pack export endpoint returning a PDF assembled from the work_item's RDS,
  spec, hold points and QA, using the `docpack` template for its method.
- Seed both `weld` and `composite` template sets (rds / itp / qa / docpack).

### ProjectPortalWeb
- Auth + role-based shell/nav.
- Repair register: list view + work_item card showing lifecycle state and evidence.
- RDS intake form rendered from the method's `rds` template.
- Engineer gate screen: upload spec, approve; `fix` actions disabled until approved.
- ITP checklist rendered from the `itp` template, with sign-off.
- QA capture from the `qa` template + "export doc pack" button.
- Client read-only view of the register, evidence and event timeline.

## Do NOT build (overengineering traps — actively avoid)
- A configurable workflow engine. Hardcode `find -> engineer -> fix -> verify -> closed`.
- Offline-first sync, real-time collaboration, or native mobile apps. Responsive
  web is enough.
- Microservices, plugin systems, or an RBAC permissions matrix. One Express
  monolith + a role enum.
- Custom auth or custom file storage. Use whatever AppHub uses / off-the-shelf.
- Any tenant-management UI. The scoping columns are the only multi-tenancy work
  for now.

## Acceptance criteria
Seed a demo work_item off one jetty pile and verify end to end, for both `weld`
and `composite`:
- A PM creates a work_item from an RDS.
- An engineer uploads and approves a spec; `fix` actions are blocked until that
  approval exists.
- A field user signs ITP hold points.
- QA is captured and a doc pack exports as PDF.
- A client login sees the register and evidence read-only.
- Every one of those actions appears in the event log with actor + timestamp.
- Switching `method` changes only the templates (forms, hold points, QA,
  doc-pack layout) — nothing in the lifecycle, gate, log, roles or client view.

## Working style
- AppHub is read-only reference; never modify it.
- Commit in small, logical increments with clear messages.
- Write a `README.md` in each new repo (setup, env, run, deploy).
- Keep `docs/BRIEF.md` (this document) in each repo for context continuity.
- Ask before adding any dependency AppHub doesn't already use, and before any
  scope addition beyond the above.
