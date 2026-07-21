# GRIDLINE backend

REST API + WebSocket broadcast layer implementing `GRIDLINE-Data-Model-and-API-Spec.md`. This is
what turns the Realtime view from a per-browser `localStorage` app into a shared, multi-user,
always-online system: field staff on mobile and control-center operators on the web both read and
write through this service, and every change is pushed to everyone instantly over a socket.

The Simulator view is out of scope on purpose — it stays a local, per-user sandbox with no server
involvement.

## Setup

1. **Postgres.** Create a database and run the schema:

   ```bash
   createdb gridline
   cp .env.example .env   # then edit DATABASE_URL / JWT_SECRET / CORS_ORIGIN for your environment
   npm install
   npm run migrate        # runs src/migrations/001_init.sql
   ```

2. **Create a first user.** There's no signup endpoint by design (accounts are provisioned by an
   admin, not self-served) — insert one directly for now:

   ```sql
   insert into users (name, email, password_hash, role)
   values ('Admin', 'admin@example.com', '<bcrypt hash>', 'admin');
   ```

   Generate the bcrypt hash with `node -e "console.log(require('bcryptjs').hashSync('yourpassword', 10))"`.

3. **Run it.**

   ```bash
   npm start        # or: npm run dev  (auto-restarts on file changes)
   ```

   The API listens on `PORT` (default 4000); the WebSocket server shares the same HTTP port.

## Smoke-testing without a real Postgres

`npm run smoke` runs the same route code against [`pg-mem`](https://github.com/oguimbal/pg-mem),
an in-memory Postgres-compatible engine — useful for quickly checking the schema and route logic
are sound before you have a real database to point at. It is **not** a substitute for testing
against real Postgres before going to production (pg-mem doesn't implement every Postgres feature),
but it catches most wiring mistakes.

## How the pieces fit together

- **REST is the only way to mutate state.** Every switch toggle, create, and delete goes through
  an authenticated HTTP endpoint (`src/routes/*.routes.js`). The WebSocket never accepts commands —
  see `src/realtime/socket.js`.
- **Every mutation writes one `audit_log` row** (`src/utils/audit.js`) and that same row is reshaped
  into the WebSocket broadcast payload — the live feed clients see is really just the audit log
  tailed in real time.
- **Optimistic locking** (`src/utils/versioning.js`): PATCH requests must include the `version`
  they read (`expectedVersion`); a mismatch returns `409` with the current row so the client can
  refresh and retry rather than silently clobbering someone else's change.
- **"Delete this branch"** (`src/utils/cascade.js`): `DELETE /api/lines/:id` walks the same subtree
  the client's `collectSubtree()`/`deleteLine()` already do, removes every downstream node/line/
  transformer/interlink in one transaction, and broadcasts a single `line.deleted` event carrying
  every affected id so clients can remove the whole branch from their canvas in one pass.

## What's deliberately not here yet

- **Offline support.** Not needed — see the design conversation this scaffold came out of: field
  connectivity is reliable (4G/5G), so there's no local action queue, no "pending sync" state, and
  no merge-on-reconnect logic. A dropped socket just re-fetches `GET /api/network` on reconnect.
  If that assumption ever changes for a specific deployment, that's the piece to add.
- **Section-based socket sharding.** Every connected client currently joins one shared `network`
  room and sees every event. `src/realtime/socket.js` has a comment marking exactly where to add
  per-section rooms if/when the deployment grows large enough that field staff shouldn't receive
  updates for districts they don't work in.
- **A real migration framework.** `src/migrate.js` is a five-line script that just runs whatever
  `.sql` files are in `src/migrations` in order — fine for getting started, but swap in
  Knex/node-pg-migrate/Prisma Migrate once the schema needs versioned up/down migrations.
- **Front-end integration.** This backend is independent of `gridline.html`; wiring the existing
  client to call this API instead of `localStorage` (swap `saveState()`/`renderAll()` calls for
  API calls + a socket listener) is the next piece of work once this is deployed.
"# gridline-server" 
"# gridline-server" 
"# gridline-server" 
