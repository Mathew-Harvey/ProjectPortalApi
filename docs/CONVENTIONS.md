# CONVENTIONS.md — How AppHub is built (authoritative reference)

This document captures exactly how the **AppHub** repos (`AppHub-Api`,
`AppHub-Web`) are built, so the two new Project Portal repos can mirror them.
AppHub is **read-only reference** — nothing here was changed. Everything below
was observed directly in the AppHub source.

---

## 1. Backend (AppHub-Api)

### Stack
- **Runtime:** Node.js (`engines.node >= 18`), CommonJS (`require`, not ESM).
- **Framework:** Express 4 (`express@^4.21`).
- **Database:** PostgreSQL via `pg@^8` connection **Pool** — raw SQL, **no ORM**,
  no query builder.
- **Auth:** JWT (`jsonwebtoken`) signed with `JWT_SECRET`, stored in an
  **httpOnly cookie** named `token`; passwords hashed with `bcryptjs` (cost 12).
- **Uploads:** `multer` (memory/disk), `sharp` for image processing.
- **Security/infra:** `helmet`, `cors` (exact-origin allowlist), `morgan`
  (request logging), `express-rate-limit`, `cookie-parser`, `dotenv`, `uuid`.
- **Tests:** `jest` + `supertest` + `pg-mem` (in-memory Postgres) via
  `--runInBand --forceExit --detectOpenHandles`.
- **Dev:** `nodemon`.
- No ESLint/Prettier config is committed. Style is enforced by convention:
  2-space indent, semicolons, single quotes, `camelCase` JS / `snake_case` SQL.

### Project structure
```
config/      db.js (pool), migrate.js (idempotent schema), *.js (seed/config data)
middleware/  auth.js (auth, adminOnly, validateId), domain middleware
routes/      one express.Router per resource, mounted in index.js
services/    business logic, integrations, helpers (audit.js, email.js, …)
tests/       *.test.js + setup.js (builds schema in an isolated test schema)
index.js     app assembly: middleware chain, route mounts, error handler
render.yaml  Render deploy (web service + managed Postgres)
.env.example fully documented env template
```

### Database access (`config/db.js`)
- A single shared `Pool` is exported and `require`d everywhere.
- `ssl` enabled in production / when `DATABASE_SSLMODE` set
  (`rejectUnauthorized` off for `no-verify`).
- Pool sizing tunable via `DB_POOL_MAX` (default 30; 5 in test).
- In **test** mode the pool transparently `SET search_path TO test_<app>, public`
  so tests run against an isolated schema.
- Queries use parameterized SQL (`$1, $2, …`) — never string interpolation.
- Multi-step writes use an explicit transaction:
  `const client = await pool.connect(); await client.query('BEGIN'); … COMMIT/ROLLBACK; finally client.release()`.

### Migrations (`config/migrate.js`)
- **Single idempotent script**, run with `node config/migrate.js`
  (`npm run db:migrate`). No migration framework, no versioned files.
- Wrapped in one `BEGIN`/`COMMIT`. Pattern:
  - `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`
  - `CREATE TABLE IF NOT EXISTS …` with `id UUID PRIMARY KEY DEFAULT uuid_generate_v4()`
  - Additive changes via `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`
  - Enums modelled as `VARCHAR(n) … CHECK (col IN ('a','b'))`, not PG enum types.
  - Timestamps: `TIMESTAMP DEFAULT NOW()` (`created_at`, `updated_at`).
- The same schema is re-declared in `tests/setup.js` for `pg-mem` (which doesn't
  support every DDL form, hence the duplication + try/catch around extensions and
  partial indexes).

### Auth (`middleware/auth.js`)
- `auth(req,res,next)`: reads `token` cookie → `jwt.verify` → attaches `req.user`
  (`{ id, email, workspaceId, role }`) → **re-reads role/active flag from the DB
  every request** so role changes/deactivation take effect without re-login.
- Sliding refresh: re-signs the cookie when older than 1h (7-day lifetime).
- Cookie options: `httpOnly`, `secure` in prod, `sameSite: 'none'` in prod /
  `'lax'` in dev, `path: '/api'`.
- `adminOnly` gate + `validateId` (UUID-format guard returning 400).
- Token payload signed by a small `signToken(user)` helper.

### Error / response patterns
- JSON everywhere. Success: `res.json({...})` / `res.status(201).json({...})`.
- Errors: `res.status(n).json({ error: 'machine_code', message?: 'human text' })`.
- Status codes: 400 validation, 401 unauthenticated, 403 forbidden (role/plan),
  404 not found, 409 conflict, 413 too large, 429 rate-limited, 500 internal.
- Global Express error handler at the bottom of `index.js` catches multer/parse
  errors and returns a clean 500 otherwise.
- Handlers wrap logic in `try/catch`, `console.error(...)` then a 500.

### API route structure
- Each resource is an `express.Router` in `routes/`, mounted under
  `/api/<resource>` in `index.js`, often behind a shared `apiLimiter`.
- Auth applied per-route (`router.post('/x', auth, handler)`), not globally.
- Health check: `GET /api/health` runs `SELECT 1` (used as Render health path).

### Middleware chain (`index.js`, in order)
helmet (skipped for special routes) → CORS (exact allowlist, `credentials:true`)
→ cookie-parser → morgan (skipped in test) → `express.json({limit})` (raw body
left intact for webhook routes) → rate limiters → route-level `auth`/role guards.

### Config / env
- `dotenv` loaded at the top of `index.js` and inside `config/db.js`
  (`path` resolved to repo root so `node config/<x>.js` works from anywhere).
- `.env.example` is exhaustive and commented; `.env` is git-ignored.
- `.gitignore`: `node_modules/`, `.env`, `*.log`, `uploads/`, `.DS_Store`.

### Append-only audit (`services/audit.js`) — the closest analog to our event log
- A tiny `logEvent(client, row)` helper inserts one row into an append-only
  `audit_log` table (`BIGSERIAL` PK, `actor_id`, `kind`, `before_value`/
  `after_value`/`meta` as `JSONB`, `created_at`). Accepts a transaction `client`
  or falls back to the pool. **Audit write failures never break the request.**
- The table is intentionally **not FK-constrained on `app_id`** so rows survive
  deletion of the thing they describe. We adopt the same "log survives" intent.

### Deploy (`render.yaml`)
- One `web` service: `runtime: node`, `plan: starter`,
  `buildCommand: npm install && npm test && npm run db:migrate`,
  `startCommand: node index.js`, `healthCheckPath: /api/health`.
- Env vars: `NODE_ENV=production`, `JWT_SECRET` (`generateValue: true`),
  `DATABASE_URL` from the managed DB, `DATABASE_SSLMODE: no-verify`,
  secrets `sync: false`.
- One managed `databases` entry (`plan: starter`, `postgresMajorVersion: "16"`).

---

## 2. Frontend (AppHub-Web)

### Stack
- **React 18** + **React Router 6**, built with **Vite 5**
  (`@vitejs/plugin-react`). Plain **JavaScript/JSX**, ES modules
  (`"type": "module"`).
- **Styling:** a single hand-written `src/styles/global.css` using CSS custom
  properties (`:root`, `data-theme`). **No component library, no CSS modules,
  no styled-components, no Tailwind.**
- Scripts: `vite` (dev, port 5173), `vite build` (→ `dist`), `vite preview`.

### Project structure
```
src/
  main.jsx            React DOM entry, provider wrapping
  App.jsx             <Routes>, ErrorBoundary, ProtectedRoute/GuestRoute
  components/         Layout.jsx (shell: topbar/nav/footer), modals, widgets
  contexts/           AuthContext.jsx (session), ThemeContext, …
  hooks/              small reusable hooks (e.g. usePlan)
  pages/              one component per route
  utils/              api.js (central client), storage.js, formatting helpers
  styles/global.css   all styles
index.html            Vite entry
vite.config.js        react plugin + dev proxy
```

### API client (`src/utils/api.js`)
- One central `api` object; every call goes through a `request(url, options)`
  wrapper that sets `credentials: 'include'`, `cache: 'no-store'`, JSON headers
  (skipped for `FormData`), parses JSON and throws structured errors
  (`err.status`, spread `...data`).
- Base URL = `${VITE_API_URL || ''}/api` (blank in dev → Vite proxy).
- A global `apphub:session-expired` CustomEvent is dispatched on unexpected 401s;
  `AuthContext` listens and bounces to `/login`.

### Routing / auth (`App.jsx`, `contexts/AuthContext.jsx`)
- `<ProtectedRoute>` redirects to `/login` when unauthenticated;
  `<GuestRoute>` redirects authed users away from auth pages.
- Authenticated pages render inside a shared `<Layout>` route (topbar + nav).
- `AuthContext` calls `api.me()` on mount to restore the session, exposes
  `user, loading, login, logout, …`, and is consumed via a `useAuth()` hook.
- A class `ErrorBoundary` wraps the whole tree.

### State / styling patterns
- Local state via `useState`/`useEffect`; cross-cutting state via Context.
- Class names are plain strings matching `global.css` (`btn btn-primary`,
  `card`, `auth-page`, `spinner`, …). Inline `style={{…}}` for one-offs.

### Config / env
- `VITE_API_URL` (blank for dev). `.env` git-ignored; `.env.example` documents it.
- `vite.config.js` proxies `/api` (and `/sandbox`) to `http://localhost:3001`
  in dev, so the cookie is same-origin locally.

### Deploy (Render Static Site)
- Build `npm install && npm run build`, publish `dist`, env `VITE_API_URL`,
  SPA rewrite `/* -> /index.html` (status 200). No `render.yaml` in the web repo;
  configured in the Render dashboard (documented in the README).

---

## 3. Things AppHub does NOT have (so we must add, and flag)
- **No EXIF parser** — `sharp` is present but EXIF extraction needs a library.
- **No PDF generator** — nothing assembles PDFs today.
- **No object storage** — AppHub stores file content (HTML, base64 logos)
  **directly in Postgres**; Render's disk is ephemeral. Media for Project Portal
  follows the same "bytes live in the DB" pattern unless told otherwise.
- **No PG enum types** — enums are `VARCHAR + CHECK`.
- **No migration framework** — one idempotent `migrate.js`.

These gaps drive the dependency questions in `PLAN.md`.
