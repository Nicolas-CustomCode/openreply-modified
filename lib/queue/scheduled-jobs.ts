/**
 * Scheduled maintenance jobs.
 *
 * These used to be Vercel cron entries hitting HTTP routes. They live in the
 * worker now because the worker is the one process every deployment has to run —
 * serverless cannot hold a connection long enough to send DMs — so putting the
 * schedule here makes it work identically on Vercel, Railway, Dokploy, EasyPanel
 * or a bare VPS, with no platform scheduler and no shared secret over HTTP.
 *
 * BullMQ job schedulers rather than setInterval: setInterval means "24h after
 * boot", not "at 05:00". A restart shifts every run forward for good, a daily
 * restart means a job never fires at all, and two worker replicas would run
 * everything twice. Schedulers give real cron semantics, survive restarts, and
 * are deduplicated by scheduler id across replicas.
 */

import { Queue, Worker, type Job } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { prisma } from "@/lib/db/client";
import { refreshExpiringTokens } from "@/lib/jobs/refresh-tokens";
import { attachPendingNextReels } from "@/lib/jobs/attach-next-reel";
import { snapshotFollowers } from "@/lib/jobs/snapshot-followers";

export const MAINTENANCE_QUEUE_NAME = "maintenance";

export const REFRESH_TOKENS_JOB = "refresh-tokens";
export const ATTACH_NEXT_REEL_JOB = "attach-next-reel";
export const SNAPSHOT_FOLLOWERS_JOB = "snapshot-followers";

/**
 * Times are UTC on purpose, not merely by default. FollowerSnapshot.date is a
 * `@db.Date` keyed to midnight UTC (see toUtcDay in lib/reports/follower-history),
 * so running the snapshot in a local timezone would file counts under the wrong
 * day near the boundary, and could write two rows for one calendar day around a
 * DST change.
 */
export const SCHEDULES = [
  { name: REFRESH_TOKENS_JOB, pattern: "0 5 * * *" },
  { name: ATTACH_NEXT_REEL_JOB, pattern: "0 6 * * *" },
  { name: SNAPSHOT_FOLLOWERS_JOB, pattern: "0 7 * * *" },
] as const;

const RUNNERS: Record<string, () => Promise<unknown>> = {
  [REFRESH_TOKENS_JOB]: refreshExpiringTokens,
  [ATTACH_NEXT_REEL_JOB]: attachPendingNextReels,
  [SNAPSHOT_FOLLOWERS_JOB]: snapshotFollowers,
};

let maintenanceQueue: Queue | null = null;

export function getMaintenanceQueue(): Queue {
  if (!maintenanceQueue) {
    maintenanceQueue = new Queue(MAINTENANCE_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
        // A daily job that fails is retried a couple of times over the next few
        // minutes rather than waiting a full day for the next window.
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
      },
    });
  }
  return maintenanceQueue;
}

/**
 * Idempotent: upsert keys on the scheduler id, so restarting the worker updates
 * the existing schedule instead of stacking a second copy of every job.
 */
export async function registerScheduledJobs(queue: Queue = getMaintenanceQueue()) {
  for (const { name, pattern } of SCHEDULES) {
    await queue.upsertJobScheduler(
      name,
      { pattern, tz: "UTC" },
      { name, data: {} }
    );
  }
}

export function createMaintenanceWorker(): Worker {
  const worker = new Worker(
    MAINTENANCE_QUEUE_NAME,
    async (job: Job) => {
      const run = RUNNERS[job.name];
      if (!run) {
        throw new Error(`Unknown maintenance job: ${job.name}`);
      }

      const startedAt = Date.now();
      const result = await run();
      console.log(
        `[Maintenance] ${job.name} finished in ${Date.now() - startedAt}ms`,
        JSON.stringify(result)
      );
      return result;
    },
    {
      connection: getRedisConnection(),
      // These jobs each sweep every connected account against the Graph API.
      // Running them one at a time keeps them from competing for the same
      // per-account rate limit the DM worker is already consuming.
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[Maintenance] ${job?.name} failed (attempt ${job?.attemptsMade}):`,
      err.message
    );
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `Scheduled job ${job?.name ?? "unknown"} failed: ${err.message}`,
          payload: { job: job?.name ?? null, attempts: job?.attemptsMade ?? 0 },
        },
      })
      .catch(() => {});
  });

  worker.on("error", (err) => {
    console.error("[Maintenance] Worker error:", err.message);
  });

  return worker;
}
