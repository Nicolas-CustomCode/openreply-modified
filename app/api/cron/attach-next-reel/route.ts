import { NextResponse } from "next/server";
import { assertCronAuthorized } from "@/lib/jobs/http";
import { attachPendingNextReels } from "@/lib/jobs/attach-next-reel";

/**
 * Manual trigger. The scheduled run lives in the worker
 * (see lib/queue/scheduled-jobs.ts).
 */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const data = await attachPendingNextReels();
  return NextResponse.json({ success: true, data });
}
