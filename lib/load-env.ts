/**
 * Loads .env files for processes that run outside Next.js — the DM worker and
 * the CLI scripts. Next loads them itself, so nothing under app/ needs this.
 *
 * Import it as a bare side-effect statement, and put it *first*:
 *
 *     import "@/lib/load-env";
 *     import { prisma } from "@/lib/db/client";
 *
 * ESM hoists every import before any statement body runs, so calling
 * loadEnvConfig() inline at the top of an entrypoint does not actually run it
 * first — the modules imported below would already have been evaluated. Keeping
 * the call inside its own module is what makes the ordering real.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
