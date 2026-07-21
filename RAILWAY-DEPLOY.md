# Deploying GRIDLINE to Railway

Railway doesn't run `docker-compose.yml` directly — each Compose service becomes its own Railway service. For GRIDLINE that would normally mean three services (Postgres, backend, Nginx), but Nginx's only job in the Docker Compose setup is serving `gridline.html` and reverse-proxying to the backend on one origin. On Railway it's simpler to fold that into the backend itself, so **the backend now also serves the client directly** (see "What changed" below) — meaning you only need two things on Railway:

1. A managed **Postgres** database (no Dockerfile needed — Railway provisions this for you)
2. One **backend service**, built from `gridline-server/Dockerfile`, serving the API, the WebSocket, and `gridline.html` together on a single public domain

## What changed to make this work

`gridline-server/src/index.js` now also serves static files from `gridline-server/public/` (currently just `gridline.html`, copied there — this is a build artifact, not something to hand-edit; re-copy it from the top-level `gridline.html` whenever you update the client). This has no effect on the Docker Compose deployment (Nginx still serves the file there and never reaches this route) — it's purely what makes a single Railway service sufficient.

## Steps

### 1. Install the Railway CLI and log in

```
npm i -g @railway/cli
railway login
```

(`railway login --browserless` if you're doing this over SSH with no browser handy.)

### 2. Create the project

From inside the `gridline-server` folder:

```
cd gridline-server
railway init
```

Give it a name (e.g. `gridline`) when prompted. This creates the Railway project and links this folder to it.

### 3. Add a Postgres database

```
railway add --database postgres
```

This provisions a managed Postgres instance in the project and exposes its connection details as variables on a service named `Postgres`.

### 4. Set the backend's environment variables

Open the project in the dashboard (`railway open`) → your backend service → **Variables** tab → **Raw Editor**, and paste:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=<a long random string, e.g. output of: openssl rand -hex 32>
JWT_EXPIRES_IN=12h
CORS_ORIGIN=*
```

`${{Postgres.DATABASE_URL}}` is a **reference variable** — it pulls the value live from the Postgres service rather than hardcoding it, so it stays correct if Railway ever rotates credentials. Don't set `PORT` yourself — Railway injects it automatically and the backend already listens on `process.env.PORT`.

### 5. Deploy

```
railway up
```

This uploads the `gridline-server` folder and builds it from the `Dockerfile` already in there (same one used for Docker Compose — the migration runs automatically on every deploy since every statement in it is `create table if not exists`, so it's safe to re-run).

### 6. Get a public URL

```
railway domain
```

This generates a `*.up.railway.app` address for the backend service. Open it in a browser — you should see the GRIDLINE login screen.

### 7. Create your first login

```
railway ssh
```

This drops you into a shell inside the running container. From there:

```
node src/create-user.js "Control Room" control@yourutility.example "a-real-password" admin
```

Roles: `field_staff`, `control_center`, or `admin`. Run it again with a different email for every person who needs a login.

### 8. (Optional) Custom domain

```
railway domain yourdomain.example
```

Then add the CNAME Railway shows you at your DNS provider.

## Notes

- **Cost**: Railway is usage-based (compute + Postgres storage), not free indefinitely — check current pricing on their dashboard before committing to it for production field use.
- **Updating the client**: after editing the top-level `gridline.html`, run `cp gridline.html gridline-server/public/gridline.html` and `railway up` again from `gridline-server/` to push the change live.
- **Auto-deploy on push**: if you'd rather deploy by pushing to GitHub than running `railway up` each time, push this repo to GitHub and use **+ New → GitHub Repo** in the Railway dashboard instead of `railway init`/`railway up` — same Dockerfile, same steps 3 onward, but Railway rebuilds automatically on every push to the branch you pick.
- This has been verified locally (the backend correctly serves both `/health` and the client at `/` after the static-file change), but not yet run against Railway itself — watch the deploy logs on first boot in case anything about their build environment differs.
