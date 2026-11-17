# Self-Hosting on a VPS with Git

This guide deploys OpenReply on your own server by cloning the repository and building it there — no Docker image, no PaaS. For a managed platform see [deploy-dokploy.md](deploy-dokploy.md); for the Vercel + Railway path see [setup.md](setup.md).

## What you end up with

Four things running on one box:

| Piece | How it runs |
| --- | --- |
| Postgres | container, from the repo's `docker-compose.yml` |
| Redis | container, same file |
| Web app | `npm start`, under systemd |
| Worker | `npm run worker`, under systemd |
| Caddy | reverse proxy, terminates TLS |

**The worker is not optional.** It sends the DMs, and it is also what keeps the Instagram tokens alive: the daily refresh job runs inside it. If the worker stays down for more than about ten days, every connected account has to be reconnected by hand.

## Before you start

- **Node 20.19+, 22.12+, or 24+.** The repo does not pin a version, and older Node fails partway through the build with errors that do not name the real cause. Check with `node --version`.
- **A domain pointing at the server.** Meta requires HTTPS for both the OAuth redirect and the webhook, so an IP address will not do.
- **Docker**, for Postgres and Redis. You can use an existing Postgres and Redis instead — only `DATABASE_URL` and `REDIS_URL` matter.

## First deploy

### 1. Clone and configure

```bash
git clone <your-fork> /srv/openreply
cd /srv/openreply
cp .env.example .env
```

`.env` is gitignored, so it does **not** arrive with the clone — you create it on the server, and it survives every later `git pull`.

Fill it in. Nine variables are mandatory and the app refuses to start without them (`lib/env.ts` validates them): `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`.

Three deserve attention:

- `NEXTAUTH_URL` is your public `https://` domain. Not localhost, not an IP.
- `ENCRYPTION_KEY` must be exactly 64 hex characters (`openssl rand -hex 32`). It encrypts the Instagram tokens; lose it and every account reconnects.
- `TRUSTED_PROXY_HOPS=1`, because Caddy sits in front. The login rate limiter reads the client IP from `x-forwarded-for` counting this many entries from the right. Set it too high and a caller can forge the address the limiter counts against; set it to `0` and every visitor shares one bucket, where five wrong passwords lock out everybody.

Set `PORT` too if 3000 is taken — the app reads it from `.env`.

### 2. Postgres and Redis

```bash
docker compose up -d
```

The repo's compose file is safe to use on a public server: both services bind to `127.0.0.1` only, so nothing is exposed to the internet, and both carry `restart: unless-stopped` so a reboot brings them back. `POSTGRES_PORT` and `REDIS_PORT` in `.env` move the host ports if something already holds the defaults — just keep `DATABASE_URL` and `REDIS_URL` pointing at the same ports.

### 3. Install, migrate, build

```bash
npm ci --include=dev
npm run db:migrate
npm run build
```

**`--include=dev` is not optional.** Setting `NODE_ENV=production` — which you want at runtime — makes npm skip devDependencies, and the build needs several of them: `typescript`, `tailwindcss`, `@tailwindcss/postcss` and `babel-plugin-react-compiler` for `next build`, `prisma` for the `prisma generate` the build script runs first, and `tsx` for the worker. Without the flag the build dies at the first step. Keep `NODE_ENV=production` for the services in step 5, not for the install.

Migrations run as their own step, before the build. Do not fold them into the build: `next build` does not need a database, and mixing them means a build failure and a migration failure look the same.

### 4. Create your account

```bash
npm run auth:set-password -- you@example.com
```

Do this or you cannot log in. Sign-up is invite-only and the database starts empty, so there is no other way in. It asks for the password twice; it also accepts a piped one if you are scripting it.

Everyone after you joins by invitation, from Settings in the dashboard.

### 5. Run the two processes

Two systemd units. Both need the same `.env`, which they get from `WorkingDirectory`.

`/etc/systemd/system/openreply-web.service`:

```ini
[Unit]
Description=OpenReply web app
After=network.target docker.service

[Service]
Type=simple
User=openreply
WorkingDirectory=/srv/openreply
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/openreply-worker.service`:

```ini
[Unit]
Description=OpenReply DM worker
After=network.target docker.service

[Service]
Type=simple
User=openreply
WorkingDirectory=/srv/openreply
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openreply-web openreply-worker
```

`Restart=always` matters more for the worker than for the web app: nobody complains when a background sender stops, so it has to come back on its own.

### 6. TLS

A two-line Caddyfile:

```
openreply.yourdomain.com {
  reverse_proxy localhost:3000
}
```

Use your `PORT` if you changed it. Caddy obtains and renews the certificate itself. `TRUSTED_PROXY_HOPS=1` from step 1 is what makes the login rate limiter read the right address through it.

### 7. Check it

```bash
curl https://openreply.yourdomain.com/api/health
```

One response covers database, Redis, the queue, and the worker heartbeat. `"status": "ok"` means all four are up. If it says `degraded` with `worker.healthy: false`, the web app is fine and the worker is not — check `journalctl -u openreply-worker`.

Then sign in at `/login` with the account from step 4.

From here, the Meta app, OAuth redirect, and webhook are the same as [setup.md](setup.md#the-meta-app) — use your own domain wherever it asks for a URL.

## Later deploys

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /srv/openreply

git pull
npm ci --include=dev
npm run db:migrate

sudo systemctl stop openreply-web openreply-worker
npm run build
sudo systemctl start openreply-web openreply-worker
```

The stop-build-start order is deliberate. `next build` rewrites `.next` in place, and a running server reading it mid-rewrite starts throwing 500s on dynamic routes while static pages keep working — a confusing failure that looks like a code bug. Stopping first costs a few seconds of downtime and avoids it.

Migrations run before the build, while the old version is still serving. That only works for additive migrations, which is what this project has had so far. A migration that drops or renames a column would break the running old code, so for those: stop first, then migrate.

## Scheduled jobs

There is nothing to configure. Token refresh, next-reel binding, and follower snapshots run inside the worker on daily schedules, and comment reconciliation runs there on a short interval. No crontab, no platform scheduler, no secret travelling over HTTP.

The `/api/cron/*` routes still exist for triggering a job by hand, guarded by `CRON_SECRET`:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://openreply.yourdomain.com/api/cron/refresh-tokens
```

If you would rather drive them from an external scheduler, set `WORKER_SCHEDULES_ENABLED=false` on the worker — otherwise every job runs twice a day.

## When things go wrong

**Locked out by the rate limiter.** Five wrong passwords from one IP triggers a 15-minute block, ten a permanent one. Failures stop counting after 15 minutes of quiet, so an honest mistake clears itself. To lift one by hand:

```bash
npm run auth:unblock-ip -- --list
npm run auth:unblock-ip -- 203.0.113.7
npm run auth:unblock-ip -- --all
```

If everyone is blocked at once, `TRUSTED_PROXY_HOPS` is probably wrong: at `0` every visitor shares a single bucket.

**Forgotten password.** There is no self-service reset. Run `npm run auth:set-password` again for that address.

**Build fails right at the start.** Almost always `npm ci` without `--include=dev`, or Node below the minimum.

**No DMs are being sent.** Check the worker first — `systemctl status openreply-worker` and `/api/health`. The dashboard works perfectly with a dead worker, which is what makes this easy to miss.

## Security notes

- `.env` never leaves the server and is not in git. Keep it that way.
- Postgres and Redis are bound to `127.0.0.1`. If you ever expose them, change the default `postgres`/`postgres` credentials first and put a password on Redis.
- Passwords are stored as bcrypt hashes. Sessions are JWTs, so they cannot be revoked server-side before they expire — if an account is compromised, change the password and rotate `NEXTAUTH_SECRET`, which invalidates every session at once.
- Instagram tokens are encrypted at rest with `ENCRYPTION_KEY`. Back it up somewhere other than the server.
