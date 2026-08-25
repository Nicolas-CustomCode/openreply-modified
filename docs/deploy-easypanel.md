# Self-Hosting on Easypanel

This guide deploys OpenReply on your own VPS with [Easypanel](https://easypanel.io), building from the repo's `Dockerfile`. For a plain server without a panel see [deploy-vps.md](deploy-vps.md); for Dokploy see [deploy-dokploy.md](deploy-dokploy.md).

## What you end up with

Four services in one Easypanel project:

| Service | Type | Notes |
| --- | --- | --- |
| `postgres` | Easypanel database | backups and restarts handled for you |
| `redis` | Easypanel database | BullMQ needs real TCP Redis, not an HTTP one |
| `openreply-web` | App, built from `Dockerfile` | the only service with a domain |
| `openreply-worker` | App, **same** `Dockerfile`, command `worker` | no domain, no port |

**The worker is not optional.** It sends the DMs, and it is also what keeps the Instagram tokens alive — the daily refresh job runs inside it. If it stays down for more than about ten days, every connected account has to be reconnected by hand. And it fails quietly: the dashboard looks perfectly healthy with a dead worker.

Both apps build the same image from the same commit. That is deliberate — `ENCRYPTION_KEY`, `DATABASE_URL` and `REDIS_URL` have to match exactly between them, and two images built from one repo eventually drift.

## Before you start

- **A domain pointing at the server.** Meta requires HTTPS for both the OAuth redirect and the webhook, so an IP will not do. Easypanel issues the certificate.
- **Node 20.19+, 22.12+, or 24+ on your own machine**, if you plan to run migrations from there (see [Migrations](#migrations)).

## 1. Postgres and Redis

Easypanel → your project → **+ Service → Postgres**, and again **+ Service → Redis**. Note the credentials it generates.

Both get an internal hostname on the project network, which is what the two apps should use:

```
DATABASE_URL=postgresql://postgres:<password>@<project>_postgres:5432/<database>
REDIS_URL=redis://default:<password>@<project>_redis:6379
```

Easypanel shows the exact internal URL on each database service's page — copy it from there rather than assembling it by hand.

The repo's `docker-compose.yml` is **not** used here. It exists for local development only.

## 2. The web app

**+ Service → App**, then:

- **Source** — GitHub (or Git), your fork, the branch you deploy.
- **Build** — builder **Dockerfile**, path `./Dockerfile`. Leave the build command empty; the Dockerfile does everything.
- **Domains** — add your domain, container port **3000**, HTTPS on.
- **Environment** — see below.

Nothing has to be passed as a build argument. The repo has no `NEXT_PUBLIC_*` variables to inline and nothing prerendered touches the database, so the image builds with no environment at all, and the same image works in any environment.

### Environment

Nine variables are mandatory — `lib/env.ts` is the source of truth:

```
NEXTAUTH_URL=https://openreply.yourdomain.com
NEXTAUTH_SECRET=<openssl rand -hex 32>
DATABASE_URL=<internal URL from step 1>
REDIS_URL=<internal URL from step 1>
ENCRYPTION_KEY=<openssl rand -hex 32>
INSTAGRAM_APP_ID=...
INSTAGRAM_APP_SECRET=...
FACEBOOK_APP_SECRET=...
WEBHOOK_VERIFY_TOKEN=<any string you also paste into Meta>
```

Three deserve attention:

- `NEXTAUTH_URL` is the public `https://` domain from the Domains tab. Not localhost, not an IP. Get it wrong and sign-in redirects land on a URL with nothing behind it.
- `ENCRYPTION_KEY` must be exactly 64 hex characters. It encrypts the Instagram tokens — lose it and every account reconnects, so back it up somewhere other than the server.
- `TRUSTED_PROXY_HOPS=1`, because Easypanel's Traefik sits in front. The login rate limiter reads the client IP from `x-forwarded-for` counting that many entries from the right. Set it too high and a caller can forge the address the limiter counts against; set it to `0` and every visitor shares one bucket, where five wrong passwords lock out everybody. Use `2` if Cloudflare is in front of Easypanel as well.

The rest are optional: `CRON_SECRET` (guards the manual `/api/cron/*` triggers) and `META_GRAPH_API_VERSION` (defaults to `v25.0`). Leave `PORT` alone — the image sets it.

Full descriptions of the Meta variables are in [setup.md](setup.md).

## 3. The worker app

**+ Service → App** again, pointing at the **same repo, same branch, same Dockerfile**. Then:

- **Deploy → Command**: `worker`
- **No domain.** It listens on no port at all; it is outbound-only.
- **No health check.** There is nothing to probe.
- **Replicas: 1.** The BullMQ schedulers deduplicate across instances, but the comment reconciliation poll does not — a second replica just does the same sweep twice.
- **Environment**: the same full set as the web app. `DATABASE_URL`, `REDIS_URL` and `ENCRYPTION_KEY` must be **identical**, or the worker cannot decrypt the tokens and every send fails.

That one word in the Command field is the whole difference between the two services. The image's entrypoint dispatches it:

| Command | Runs |
| --- | --- |
| *(empty)* or `web` | `next start` |
| `worker` | `tsx worker/dm-worker.ts` |
| `migrate` | `prisma migrate deploy` |
| anything else | verbatim — useful for the admin scripts |

## Migrations

**`prisma migrate deploy` never runs during the build.** A Docker build has no route to the project network, so it fails with `P1001: Can't reach database server`. It also does not run at container start, so a deploy can never half-apply a migration while the old code is still serving.

Run it yourself, before the first deploy and before any later deploy that carries a new migration.

Expose the Postgres service's port in Easypanel, point your local `DATABASE_URL` at it, and:

```bash
npm run db:migrate
```

Or, from the web service's terminal in Easypanel:

```bash
docker/entrypoint.sh migrate
```

Both do the same thing. Migrations so far have all been additive, which is why running them against the live database while the old version serves is safe. A migration that drops or renames a column would not be — stop the services first for those.

## 4. Create your account

Sign-up is invite-only and the database starts empty, so until you do this nobody can log in. In the web service's terminal:

```bash
node_modules/.bin/tsx scripts/set-password.ts you@example.com
```

It asks for the password twice; it also accepts a piped one if you are scripting it. Everyone after you joins by invitation, from Settings in the dashboard.

## 5. Check it

```bash
curl https://openreply.yourdomain.com/api/health
```

One response covers database, Redis, the queue, and the worker heartbeat. `"status": "ok"` means all four are up. `degraded` with `worker.healthy: false` means the web app is fine and the worker is not — check the worker service's logs.

Then sign in at `/login` with the account from step 4.

From here, the Meta app, OAuth redirect, and webhook are the same as [setup.md](setup.md#the-meta-app) — use your own domain wherever it asks for a URL.

## Health checks

If you configure one in Easypanel, `/api/health` is the honest endpoint — but note that it returns **503 while the worker is down**. On the web service that means a healthy app gets restarted because a different service is unwell. Either probe `/login` instead, or accept the coupling knowingly. This is also why the `Dockerfile` ships no `HEALTHCHECK` of its own.

## Scheduled jobs

There is nothing to configure. Token refresh, next-reel binding, and follower snapshots run inside the worker on daily schedules, and comment reconciliation runs there on a short interval. No cron service, no secret travelling over HTTP.

The `/api/cron/*` routes still exist for triggering a job by hand, guarded by `CRON_SECRET`:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://openreply.yourdomain.com/api/cron/refresh-tokens
```

If you would rather drive them from an external scheduler, set `WORKER_SCHEDULES_ENABLED=false` on the worker — otherwise every job runs twice a day.

## When things go wrong

**The build fails inside `next build`, complaining about a missing variable.** The image is built with no environment on purpose, which works because nothing prerendered reads the database and there are no `NEXT_PUBLIC_*` variables to inline. If a future page breaks that — a static page that queries Postgres at build time — the fix is either to mark that page `dynamic = "force-dynamic"`, or to add build args to the Dockerfile and pass placeholder values from Easypanel's Build tab. Prefer the first; a variable that has to exist at build time is a variable that pins the image to one environment.

**The worker container exits immediately.** Almost always a missing `DATABASE_URL` or `REDIS_URL` — it connects on boot and has no port for the platform to wait on, so a config mistake shows up as a restart loop with a one-line log.

**DMs are queued but never sent.** Check `/api/health` for `worker.healthy`. If the worker is up, compare `ENCRYPTION_KEY` between the two services character for character.

**Locked out by the rate limiter.** Five wrong passwords from one IP triggers a 15-minute block, ten a permanent one. From the web service's terminal:

```bash
node_modules/.bin/tsx scripts/unblock-ip.ts --list
node_modules/.bin/tsx scripts/unblock-ip.ts 203.0.113.7
node_modules/.bin/tsx scripts/unblock-ip.ts --all
```

If everyone is blocked at once, `TRUSTED_PROXY_HOPS` is probably wrong.

**Forgotten password.** There is no self-service reset. Run `set-password.ts` again for that address.

## Notes on the image

It carries the full dependency tree, devDependencies included, and lands around a gigabyte. That is not an oversight: the worker runs the TypeScript sources through `tsx`, and the `migrate` command needs the Prisma CLI — both are devDependencies, and neither survives `output: "standalone"` file tracing. Splitting the web app into a standalone build while keeping a second tree for the worker would trade a smaller image for two things that can disagree. If disk on the VPS is tight, prune old images in Easypanel rather than the dependency tree.
