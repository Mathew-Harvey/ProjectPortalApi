# Franmarine Project Portal — API

Node/Express + PostgreSQL backend for the Franmarine project-delivery portal
(marine structural remediation). Conventions mirror the AppHub reference repo —
see [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md), [`docs/PLAN.md`](docs/PLAN.md)
and the build brief in [`docs/BRIEF.md`](docs/BRIEF.md).

Each defect is a `work_item` that runs one **hardcoded** lifecycle:

```
find  →  engineer  →  fix  →  verify  →  closed
```

The engineer is an independent **approval gate**: a work item cannot enter `fix`
(and no `fix` action — hold-point signing, QA capture — is permitted) until an
`approved` spec exists. Every mutation writes one row to the **append-only event
log** with actor + timestamp.

`work_item.method` is `weld | composite`; it only selects which **template set**
(RDS / ITP / QA / doc-pack) loads. The lifecycle, gate, event log, roles and
client view are identical for both.

## Stack
Express 4, `pg` (raw SQL, no ORM), JWT in an httpOnly cookie (`jsonwebtoken` +
`bcryptjs`), `multer` (media), `helmet`, `cors`, `express-rate-limit`, `morgan`,
`dotenv`, `uuid`. **Added beyond AppHub** (approved): `exifr` (EXIF at capture)
and `pdfkit` (doc-pack PDF). Tests: `jest` + `supertest` + `pg-mem`.

## Project layout
```
config/   db.js · schema.js (single source of truth) · migrate.js · seed.js · templates.js
middleware/ auth.js (auth, requireRole, validateId)
services/ events.js (append-only log) · media.js (sha256/exif) · docpack.js (PDF)
routes/   auth.js · projects.js · workItems.js · templates.js
tests/    api.test.js (full lifecycle, both methods) · immutability.test.js
index.js  app assembly · render.yaml · .env.example
```

## Data model
`organisation · project · app_user · work_item · inspection · spec · hold_point ·
qa_record · media · event · template`. Every table carries `org_id` / `project_id`
scoping columns (multi-tenant foundation; one organisation today). `event` and
`media` are **append-only / immutable after insert** — a source-scanning test
fails CI if any code UPDATE/DELETEs them.

## Setup & run
```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET
npm run db:migrate          # create the schema (idempotent)
npm run db:seed             # seed org/project/users + templates (idempotent)
npm run dev                 # http://localhost:3001
npm test                    # jest + supertest + pg-mem (no DB needed)
```
On a real server `node index.js` also seeds idempotently on startup, so a fresh
deploy is usable immediately. Migration runs in the build step.

## Environment
See [`.env.example`](.env.example). Key vars: `DATABASE_URL`, `JWT_SECRET`,
`CLIENT_URL` (CORS), `MAX_FILE_SIZE`, `SEED_PASSWORD`.

## Seeded demo logins
One user per role, all under `@franmarine.com.au`, password from `SEED_PASSWORD`
(default `Password123`):

| Role | Email | Can do |
|------|-------|--------|
| `admin_pm` | pm@franmarine.com.au | create work items, capture QA, close |
| `engineer` | engineer@franmarine.com.au | submit + approve specs (the gate) |
| `field` | field@franmarine.com.au | RDS intake, sign hold points, QA, media |
| `client` | client@franmarine.com.au | read-only register/evidence/timeline + QA client sign-off |

Seed organisation **Franmarine**, project **Berth 3 Jetty Remediation**
(`asset_ref JETTY-B3`), and both `weld` + `composite` template sets.

## API
```
GET  /api/health
POST /api/auth/register | login | logout         GET /api/auth/me
GET  /api/projects
GET  /api/projects/:id/work-items                 # repair register
GET  /api/projects/:id/events                     # project timeline
POST /api/work-items                              # create from RDS (admin_pm) -> find
GET  /api/work-items/:id                          # full card (+ inspection/spec/holdpoints/qa/media/events)
GET  /api/work-items/:id/events
POST /api/work-items/:id/inspection               # RDS intake (admin_pm/field)
POST /api/work-items/:id/spec                     # submit draft (engineer) -> engineer
POST /api/work-items/:id/spec/:specId/approve     # the gate (engineer) -> fix
POST /api/work-items/:id/hold-points/:hpId/sign   # field; blocked until fix
POST /api/work-items/:id/qa                        # capture QA (field/admin_pm) -> verify
POST /api/work-items/:id/qa/:qaId/client-sign     # client
POST /api/work-items/:id/close                     # admin_pm -> closed
POST /api/work-items/:id/media                     # multipart 'file'; sha256+exif at capture
GET  /api/work-items/:id/media/:mediaId            # stream bytes
GET  /api/work-items/:id/docpack                   # PDF (method's docpack template)
GET  /api/templates?method=&kind=                  # template-driven definitions
```

## Deploy (Render)
[`render.yaml`](render.yaml) provisions one Node web service + one managed
Postgres 16 database. Build runs `npm install && npm test && npm run db:migrate
&& npm run db:seed`; health check `/api/health`. Set `CLIENT_URL` to the web
app's URL and `SEED_PASSWORD` to a non-default value.
