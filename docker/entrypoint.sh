#!/bin/sh
# Turns the container's argument into a process. `web` is the default so the
# image behaves like a plain Next.js image when nobody overrides the command.
#
# The binaries are invoked directly instead of through `npm start` /
# `npm run worker`. Those go through scripts/with-env.mjs, which spawns a shell
# child and never forwards SIGTERM to it — the worker would lose the graceful
# shutdown it implements. And the wrapper exists to read PORT out of .env, which
# is moot in a container where the platform injects real environment variables.
set -e

case "${1:-web}" in
  web)
    exec node_modules/.bin/next start
    ;;
  worker)
    exec node_modules/.bin/tsx worker/dm-worker.ts
    ;;
  migrate)
    exec node_modules/.bin/prisma migrate deploy
    ;;
  *)
    # Anything else runs verbatim, so the image doubles as a shell for the
    # admin scripts: `... openreply node_modules/.bin/tsx scripts/set-password.ts you@example.com`
    exec "$@"
    ;;
esac
