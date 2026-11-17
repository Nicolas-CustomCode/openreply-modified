import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { removeInstagramAccountPermanently } from "@/lib/instagram-accounts";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

/**
 * The workspace's connected Instagram accounts — just enough for an account
 * selector. This is a single indexed query, unlike /api/dashboard/stats which
 * runs the full analytics aggregation. Pages that only need the account list
 * (e.g. the inbox) should use this so they aren't gated on heavy stats.
 * Disconnected accounts are left out: every page using this acts through the
 * account's token.
 */
export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const instagramAccounts = await prisma.instagramAccount.findMany({
    where: { workspaceId, disconnectedAt: null },
    orderBy: { connectedAt: "desc" },
    select: { id: true, username: true, instagramId: true, name: true },
  });

  return NextResponse.json({
    success: true,
    data: {
      instagramAccounts,
      selectedInstagramAccountId: instagramAccounts[0]?.id ?? null,
    },
  });
}

const removeSchema = z.object({
  instagramAccountId: z.string().min(1),
  // The account's @username, typed by the user, so a stray request with only
  // an id cannot wipe an account's history.
  confirmUsername: z.string().min(1),
});

const REMOVE_ERRORS = {
  not_found: { status: 404, error: "Instagram account not found." },
  still_connected: {
    status: 409,
    error: "Disconnect the account before removing it permanently.",
  },
  confirmation_mismatch: {
    status: 400,
    error: "The username you typed does not match this account.",
  },
} as const;

/**
 * Permanently remove a disconnected account and everything tied to it:
 * campaigns, DM logs, tracked links, clicks and follower history. This cannot
 * be undone. Also what frees the account to be connected in another workspace.
 */
export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can remove accounts." },
      { status: 403 }
    );
  }

  const parsed = removeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "An account id and its username are required." },
      { status: 400 }
    );
  }

  const result = await removeInstagramAccountPermanently(
    context.workspaceId,
    parsed.data.instagramAccountId,
    parsed.data.confirmUsername
  );

  if (!result.ok) {
    const { status, error } = REMOVE_ERRORS[result.reason];
    return NextResponse.json({ success: false, error }, { status });
  }

  return NextResponse.json({ success: true });
}
