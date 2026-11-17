import { prisma } from "@/lib/db/client";

/**
 * Whether an Instagram account may be connected to this workspace.
 *
 * instagramId is unique across the whole install, so an account already held
 * by another workspace — connected, or disconnected but still holding that
 * workspace's campaigns and history — cannot be connected here. Moving it
 * would hand the other workspace's campaigns to this one. A disconnected
 * account has to be removed permanently in its own workspace first.
 */
export async function canConnectInstagramAccount({
  workspaceId,
  instagramId,
}: {
  workspaceId: string;
  instagramId: string;
}) {
  const existingAccount = await prisma.instagramAccount.findUnique({
    where: { instagramId },
    select: { workspaceId: true, disconnectedAt: true },
  });

  if (existingAccount && existingAccount.workspaceId !== workspaceId) {
    return {
      allowed: false,
      reason: existingAccount.disconnectedAt
        ? ("held_by_other_workspace" as const)
        : ("already_connected" as const),
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

/**
 * A connected account of the workspace: the requested one, or the most
 * recently connected. Disconnected accounts are never returned, because every
 * caller goes on to use the token, which a disconnected account no longer has.
 */
export async function getWorkspaceInstagramAccount(
  workspaceId: string,
  instagramAccountId?: string | null
) {
  if (instagramAccountId && instagramAccountId !== "all") {
    return prisma.instagramAccount.findFirst({
      where: { id: instagramAccountId, workspaceId, disconnectedAt: null },
    });
  }

  return prisma.instagramAccount.findFirst({
    where: { workspaceId, disconnectedAt: null },
    orderBy: { connectedAt: "desc" },
  });
}

/**
 * Disconnect accounts without deleting anything: wipe the token so nothing can
 * act for the account any more, and pause its campaigns. Campaigns, DM logs,
 * tracked links, clicks and follower history all stay, and the account row is
 * what a later reconnect of the same Instagram account updates, so they come
 * back with it. Campaigns stay paused after a reconnect until turned back on.
 *
 * Without an id, every connected account of the workspace is disconnected.
 * Returns how many accounts were disconnected.
 */
export async function disconnectInstagramAccounts(
  workspaceId: string,
  instagramAccountId?: string | null
): Promise<number> {
  const accounts = await prisma.instagramAccount.findMany({
    where: {
      workspaceId,
      disconnectedAt: null,
      ...(instagramAccountId ? { id: instagramAccountId } : {}),
    },
    select: { id: true },
  });
  if (accounts.length === 0) return 0;

  const ids = accounts.map((a) => a.id);
  await prisma.$transaction([
    prisma.automation.updateMany({
      where: { workspaceId, instagramAccountId: { in: ids } },
      data: { isActive: false },
    }),
    prisma.instagramAccount.updateMany({
      where: { workspaceId, id: { in: ids } },
      data: {
        disconnectedAt: new Date(),
        // The crons and the worker already treat an empty token as "no
        // token", so nothing tries to refresh or send with it.
        accessToken: "",
        tokenExpiresAt: null,
        webhookSubscribed: false,
      },
    }),
  ]);

  return ids.length;
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

export type RemoveInstagramAccountResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "still_connected" | "confirmation_mismatch" };

/**
 * Permanently delete a disconnected account together with everything tied to
 * it (campaigns, logs, links, clicks, follower history), via the schema's
 * cascades. Refused for a connected account — it has to be disconnected first —
 * and unless `confirmUsername` matches the account's username, so the caller
 * cannot remove the wrong account by id alone.
 */
export async function removeInstagramAccountPermanently(
  workspaceId: string,
  instagramAccountId: string,
  confirmUsername: string
): Promise<RemoveInstagramAccountResult> {
  const account = await prisma.instagramAccount.findFirst({
    where: { id: instagramAccountId, workspaceId },
    select: { id: true, username: true, disconnectedAt: true },
  });

  if (!account) return { ok: false, reason: "not_found" };
  if (!account.disconnectedAt) return { ok: false, reason: "still_connected" };
  if (normalizeUsername(confirmUsername) !== normalizeUsername(account.username)) {
    return { ok: false, reason: "confirmation_mismatch" };
  }

  // Re-check "disconnected" in the delete itself: a reconnect landing between
  // the read above and this write must not be deleted.
  const { count } = await prisma.instagramAccount.deleteMany({
    where: { id: account.id, workspaceId, disconnectedAt: { not: null } },
  });
  return count > 0 ? { ok: true } : { ok: false, reason: "still_connected" };
}
