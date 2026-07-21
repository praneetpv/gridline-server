# GRIDLINE deployment (Docker Compose)

Three containers, one command:

- **postgres** — the database (data persisted in a Docker volume, survives restarts)
- **backend** — the GRIDLINE API + WebSocket server (`gridline-server/`), runs its own migration on startup
- **web** — Nginx, serves the client (`web/gridline.html`) and reverse-proxies `/api` and `/socket.io` to the backend

Client and API are served on the same origin, so there's no CORS configuration to fight with, and the client's `BACKEND_URL` auto-detects same-origin when it isn't opened as a local file.

## First-time setup

1. Copy the env template and fill in real values:
   ```
   cp .env.example .env
   ```
   At minimum, set `JWT_SECRET` (e.g. `openssl rand -hex 32`) and `POSTGRES_PASSWORD`.

2. Start everything:
   ```
   docker compose up -d --build
   ```
   First boot pulls the Postgres/Nginx images, builds the backend image, then the backend runs its migration against Postgres automatically.

3. Create your first login (there's no signup page by design — accounts are provisioned directly):
   ```
   docker compose exec backend node src/create-user.js "Control Room" control@yourutility.example "a-real-password" admin
   ```
   Roles: `field_staff`, `control_center`, or `admin`. Run it again with a different email for each person who needs a login. Re-running with the same email updates that user's name/role/password instead of erroring.

4. Open `http://<server-address>/` (or `http://<server-address>:<HTTP_PORT>/` if you changed the port in `.env`). Log in with the account from step 3 — this is the **Realtime** view; every field or control-room user who logs in and toggles something is instantly reflected on everyone else's screen.

## Updating the deployed client

`web/gridline.html` is a **copy** used only by the running deployment — it's separate from the working copy at the top level (`gridline.html`) that you edit through chat. After making changes to the working copy, push them live with:

```
cp gridline.html web/gridline.html
```

No restart needed — Nginx serves it straight from disk, so a browser refresh picks up the change.

## Common operations

- View logs: `docker compose logs -f backend`
- Restart just the backend (e.g. after an env change): `docker compose restart backend`
- Stop everything: `docker compose down` (data survives — the Postgres volume isn't removed)
- Wipe the database and start clean: `docker compose down -v`

## Notes / limitations

- The **Simulator** view still runs entirely client-side (localStorage) — nothing to deploy for it, it works the moment the file loads.
- Migrations are a simple "run every .sql file in order" runner, not a versioned migration framework — fine for now, revisit if the schema needs to evolve further (see `gridline-server/src/migrate.js`).
- This compose file assumes a single Postgres instance with no automated backups — for anything beyond a pilot, set up periodic `pg_dump`s of the `pgdata` volume (or point `DATABASE_URL` at a managed Postgres instance instead of the bundled container).
- The backend and schema have been exercised end-to-end against `pg-mem` (in-memory Postgres-compatible engine) via the automated smoke test, but not yet against a real running Postgres server or real Docker — review `docker compose up` output carefully on first run and report anything unexpected.
