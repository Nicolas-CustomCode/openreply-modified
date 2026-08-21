/**
 * Clears login rate-limit blocks.
 *
 *     npm run auth:unblock-ip -- 203.0.113.7
 *     npm run auth:unblock-ip -- --all
 *     npm run auth:unblock-ip -- --list
 *
 * The permanent tier has no expiry and no admin UI, so without this an operator
 * who locks themselves out has no way back in.
 */
import "@/lib/load-env";

import { prisma } from "@/lib/db/client";

async function main() {
  const args = process.argv.slice(2);
  const target = args[0];

  if (!target) {
    console.error(
      "Usage: npm run auth:unblock-ip -- <ip> | --all | --list"
    );
    process.exitCode = 1;
    return;
  }

  if (target === "--list") {
    const blocks = await prisma.ipBlock.findMany({
      orderBy: { lastAttemptAt: "desc" },
    });

    if (blocks.length === 0) {
      console.log("No IP blocks recorded.");
      return;
    }

    for (const block of blocks) {
      const state = block.isPermanent
        ? "permanent"
        : block.blockedUntil && block.blockedUntil > new Date()
          ? `blocked until ${block.blockedUntil.toISOString()}`
          : "not blocked";
      console.log(
        `${block.ip}\t${block.failedAttempts} failed\t${state}\tlast ${block.lastAttemptAt.toISOString()}`
      );
    }
    return;
  }

  if (target === "--all") {
    const { count } = await prisma.ipBlock.deleteMany({});
    console.log(`Cleared ${count} IP block record(s).`);
    return;
  }

  const { count } = await prisma.ipBlock.deleteMany({
    where: { ip: target.trim() },
  });

  console.log(
    count > 0
      ? `Cleared the block on ${target}.`
      : `No block recorded for ${target}.`
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
