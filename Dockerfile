# syntax=docker/dockerfile:1

# OpenReply — one image, two processes.
#
# The web app and the DM worker ship together on purpose. The worker runs
# `tsx worker/dm-worker.ts` against the same TypeScript sources and the same
# generated Prisma client the app uses, and it has to decrypt Instagram tokens
# with the exact same ENCRYPTION_KEY. Two images built from one repo drift; one
# image with two start commands cannot.
#
#     docker run ... openreply           # web app (default)
#     docker run ... openreply worker    # DM worker + scheduled jobs
#     docker run ... openreply migrate   # prisma migrate deploy
#
# Node 22 on bookworm, not Alpine: Next 16 and Prisma 7 both want Node 20.19+ /
# 22.12+, and Prisma's schema engine expects glibc and OpenSSL.


FROM node:22-bookworm-slim AS base
WORKDIR /app

# openssl is not decoration, and it has to be here rather than in the runner.
# The slim image ships libssl3 but not the openssl package, and Prisma's
# detection (getSSLVersion in @prisma/get-platform) looks for libssl.so through
# distro paths and `ldconfig -p`. When it finds neither it defaults to
# "openssl-1.1.x" — a binary target that cannot load on bookworm, which is
# OpenSSL 3.x. That choice is made by the @prisma/engines postinstall while
# `npm ci` runs, one stage below, so the wrong schema engine would already be
# sitting in node_modules by the time the runner needs it. It breaks the
# `migrate` command; the app and the worker are unaffected, because the
# generated client queries through the WASM compiler and @prisma/adapter-pg
# rather than a native engine.
#
# tini reaps zombies and passes SIGTERM through, which is what lets the worker
# finish its in-flight job in worker.close() instead of being killed mid-send.
# It rides along here so all three stages share one cached apt layer; the
# 267 kB it adds to deps and builder are discarded with those stages.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl tini \
 && rm -rf /var/lib/apt/lists/*


FROM base AS deps

COPY package.json package-lock.json ./

# --include=dev is load-bearing, and NODE_ENV is deliberately left unset. The
# build needs typescript, tailwindcss, @tailwindcss/postcss,
# babel-plugin-react-compiler and prisma; the worker needs tsx at runtime.
# NODE_ENV=production here makes npm skip every one of them and the build dies
# at its first step.
RUN npm ci --include=dev


FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `npm run build` is `prisma generate && next build`. The generate step is not
# optional: the client lands in app/generated/prisma, which is gitignored, and
# both the app and the worker import it from there.
#
# `prisma migrate deploy` is deliberately absent. A build has no route to the
# database and would fail with P1001 — migrations are the `migrate` command.
#
# No build-time environment variables are needed: the repo has no NEXT_PUBLIC_*
# to inline, and nothing prerendered touches the database. That is what lets a
# single image move between environments unchanged.
RUN npm run build \
 && rm -rf .next/cache \
 && chmod +x docker/entrypoint.sh


FROM base AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# The whole tree, devDependencies included. `output: "standalone"` would make
# the web side much smaller, but its file tracing only covers the app — it
# leaves out tsx, the .ts sources and the Prisma CLI, and this image needs all
# three.
COPY --from=builder --chown=node:node /app ./

USER node
EXPOSE 3000

# No HEALTHCHECK here on purpose. /api/health answers 503 whenever the worker is
# down, which would restart-loop a perfectly healthy web container. Point the
# platform's check at it instead, where a degraded response is a signal rather
# than a death sentence.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["web"]
