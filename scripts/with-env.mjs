/**
 * Runs a command with the project's .env files already loaded.
 *
 *     node scripts/with-env.mjs next dev
 *
 * Next honours PORT, but only as a real environment variable. Its CLI parses
 * argv before any .env file is read — the port option is declared as
 * `.default(3000).env('PORT')` and `program.parse()` runs with nothing loaded —
 * so `PORT` sitting in .env is simply invisible to it. Loading the env here,
 * before the CLI starts, is what makes it count.
 *
 * (Node's own --env-file would do the same, but it is rejected inside
 * NODE_OPTIONS, so it cannot be applied without naming Next's internal bin
 * path in the npm script.)
 *
 * loadEnvConfig leaves variables that are already set alone, so an explicit
 * `PORT=3007 npm run dev`, or the port a hosting platform injects, still wins
 * over the file.
 */
// @next/env is CommonJS, so a named import fails under plain ESM in Node.
import nextEnv from "@next/env";
import { spawn } from "node:child_process";

const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: node scripts/with-env.mjs <command> [args...]");
  process.exit(1);
}

// shell: true so the npm-installed binaries in node_modules/.bin resolve on
// Windows as well as on Linux.
const child = spawn(command, args, { stdio: "inherit", shell: true });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`Failed to start "${command}":`, error.message);
  process.exit(1);
});
