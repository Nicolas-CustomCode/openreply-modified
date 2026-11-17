import { NextRequest, NextResponse } from "next/server";
import { disconnectInstagramAccounts } from "@/lib/instagram-accounts";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

/**
 * Disconnect an Instagram account (or, without an id, every account of the
 * workspace). Nothing is deleted: the token is wiped and the account's
 * campaigns are paused, and reconnecting the same account brings its
 * campaigns and history back. Permanent removal is DELETE /api/instagram/accounts.
 */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can disconnect accounts" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const instagramAccountId =
    typeof body.instagramAccountId === "string" ? body.instagramAccountId : null;

  const disconnected = await disconnectInstagramAccounts(
    context.workspaceId,
    instagramAccountId
  );

  return NextResponse.json({ success: true, data: { disconnected } });
}
