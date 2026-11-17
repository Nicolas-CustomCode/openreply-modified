/**
 * Comment reconciliation (polling safety net).
 *
 * Instagram webhooks are best-effort and never fire for a large class of
 * comments (collapsed "load more" comments, non-follower / low-signal accounts,
 * anything Instagram filters). Those comments are otherwise invisible: never
 * replied to, never DM'd.
 *
 * This sweep is deliberately narrow. For each active campaign it looks only at
 * that campaign's post, only at recent comments, and acts on a comment ONLY when
 * both are true:
 *   1. the comment matches the campaign keyword, and
 *   2. the account owner has not already replied to it.
 * The reply check reads the comment's actual replies on Instagram, so a comment
 * you (or the tool) already answered is skipped — the poll never re-touches
 * handled comments. Each sweep is capped so it can never flood the comment API
 * (which Instagram rate-limits aggressively, error 368).
 *
 * It runs on an interval in the worker process because Vercel's free crons only
 * fire once a day. Matching and sending reuse the worker's processComment, so
 * rate limiting and logging behave exactly as for webhook-delivered comments.
 *
 * Known limitation, handled not fixed: comments removed by Instagram's Hidden
 * Words / spam filter may not be returned by the Graph API at all. Disable that
 * filter on the account to widen results.
 */

import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import {
  getRecentMediaComments,
  getUserMedia,
  MetaApiError,
  type InstagramComment,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { commentIsAnswered, resolveAnsweredComments } from "@/lib/reply-authors";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

// Only consider comments from the last few days — older ones are outside
// Instagram's private-reply window anyway, so a DM to them would just fail.
const LOOKBACK_HOURS = Number(process.env.COMMENT_POLL_LOOKBACK_HOURS ?? 72);
// Hard cap on how many new comments a single campaign can enqueue per sweep, so
// a viral post drains gradually instead of bursting into the comment API.
const MAX_NEW_PER_SWEEP = Number(process.env.COMMENT_POLL_MAX_PER_SWEEP ?? 30);
// GET /{reply-id} calls one whole pass (all campaigns) may spend finding out
// who wrote replies. Answers are cached for good, so this only bites while the
// cache fills; comments it could not settle wait for the next pass.
const REPLY_LOOKUPS_PER_PASS = Number(
  process.env.COMMENT_POLL_REPLY_LOOKUPS ?? 30
);
// For "any post" campaigns, how many recent posts to scan.
const RECENT_MEDIA_LIMIT = 10;

interface SweepStat {
  campaign: string;
  keywords: string;
  matched: number;
  alreadyReplied: number;
  /** Matched comments left for a later pass because their replies' authors are not known yet. */
  unverified: number;
  enqueued: number;
  errors: string[];
}

function errMessage(error: unknown): string {
  if (error instanceof MetaApiError) return `Meta ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/** One reconciliation pass across every active campaign. */
export async function reconcileComments(): Promise<void> {
  const automations = await prisma.automation.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      postId: true,
      matchAnyPost: true,
      matchAnyWord: true,
      keywords: true,
      wholeWordMatch: true,
      publicReplyEnabled: true,
      workspaceId: true,
      instagramAccount: {
        select: {
          id: true,
          instagramId: true,
          username: true,
          accessToken: true,
        },
      },
    },
  });

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const tokenCache = new Map<string, string | null>();
  const lookupBudget = { remaining: REPLY_LOOKUPS_PER_PASS };

  for (const automation of automations) {
    const stat = await sweepCampaign(
      automation,
      sinceMs,
      tokenCache,
      lookupBudget
    ).catch(
      (error): SweepStat => ({
        campaign: automation.name,
        keywords: automation.keywords.join(","),
        matched: 0,
        alreadyReplied: 0,
        unverified: 0,
        enqueued: 0,
        errors: [errMessage(error)],
      })
    );
    await recordSweep(automation.workspaceId, stat);
  }
}

async function sweepCampaign(
  automation: {
    id: string;
    name: string;
    postId: string | null;
    matchAnyPost: boolean;
    matchAnyWord: boolean;
    keywords: string[];
    wholeWordMatch: boolean;
    publicReplyEnabled: boolean;
    instagramAccount: {
      id: string;
      instagramId: string;
      username: string;
      accessToken: string;
    };
  },
  sinceMs: number,
  tokenCache: Map<string, string | null>,
  lookupBudget: { remaining: number }
): Promise<SweepStat> {
  const account = automation.instagramAccount;
  const stat: SweepStat = {
    campaign: automation.name,
    keywords: automation.matchAnyWord
      ? "(any word)"
      : automation.keywords.join(","),
    matched: 0,
    alreadyReplied: 0,
    unverified: 0,
    enqueued: 0,
    errors: [],
  };

  // Decrypt the account token once per sweep.
  let accessToken = tokenCache.get(account.id);
  if (accessToken === undefined) {
    try {
      accessToken = decryptToken(account.accessToken);
    } catch {
      accessToken = null;
    }
    tokenCache.set(account.id, accessToken);
  }
  if (!accessToken) {
    stat.errors.push("Failed to decrypt access token");
    return stat;
  }

  // Which media this campaign covers: its own post, or the recent feed if it
  // matches any post.
  const mediaIds: string[] = [];
  if (automation.postId) {
    mediaIds.push(automation.postId);
  } else if (automation.matchAnyPost) {
    try {
      const media = await getUserMedia(accessToken, RECENT_MEDIA_LIMIT);
      mediaIds.push(...media.map((m) => m.id));
    } catch (error) {
      stat.errors.push(`Media list: ${errMessage(error)}`);
    }
  }
  if (mediaIds.length === 0) return stat;

  const queue = getDMQueue();

  for (const mediaId of mediaIds) {
    let comments: InstagramComment[];
    try {
      comments = await getRecentMediaComments(accessToken, mediaId, sinceMs);
    } catch (error) {
      stat.errors.push(`Comments ${mediaId}: ${errMessage(error)}`);
      continue;
    }

    // Keep only comments that aren't the account's own and match the keyword.
    const matched = comments.filter((c) => {
      const authorId = c.from?.id;
      if (!authorId || authorId === account.instagramId) return false;

      const hit = automation.matchAnyWord
        ? true
        : matchKeywords(c.text ?? "", automation.keywords, automation.wholeWordMatch)
            .matched;
      if (hit) stat.matched += 1;
      return hit;
    });
    if (matched.length === 0) continue;

    // Skip comments this campaign has already fully handled. "Fully handled"
    // depends on the campaign: if it posts a public reply, the completion signal
    // is publicReplySentAt (a DM alone is not enough — the reply still has to
    // land); otherwise a SENT DM is enough. This is what lets a comment whose DM
    // sent but whose public reply failed come back and retry the reply. Checked
    // before the reply-author lookups below, so those are never spent on a
    // comment that is done anyway.
    const handled = await prisma.dmLog.findMany({
      where: {
        automationId: automation.id,
        commentId: { in: matched.map((c) => c.id) },
        ...(automation.publicReplyEnabled
          ? { publicReplySentAt: { not: null } }
          : { status: "SENT" }),
      },
      select: { commentId: true },
    });
    const handledSet = new Set(handled.map((h) => h.commentId));

    // Oldest first, so whoever commented earliest gets answered first.
    const candidates = matched
      .filter((c) => !handledSet.has(c.id))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (candidates.length === 0) continue;

    // Leave out comments the account owner already answered — by hand or
    // through OpenReply. Meta sends replies without authors, so this goes
    // through the shared reply-author cache and spends lookups from the sweep's
    // budget. A comment it cannot settle yet is left for a later sweep rather
    // than DM'd blind.
    const resolution = await resolveAnsweredComments(
      account,
      accessToken,
      candidates,
      { budget: lookupBudget.remaining }
    );
    lookupBudget.remaining = Math.max(
      0,
      lookupBudget.remaining - resolution.lookups
    );

    const fresh = candidates
      .filter((c) => {
        if (commentIsAnswered(c, account, resolution)) {
          stat.alreadyReplied += 1;
          return false;
        }
        if (resolution.unverifiedCommentIds.has(c.id)) {
          stat.unverified += 1;
          return false;
        }
        return true;
      })
      .slice(0, MAX_NEW_PER_SWEEP);

    for (const c of fresh) {
      // No deterministic jobId here: a retained completed/failed job from an
      // earlier sweep would otherwise be treated as a duplicate and silently
      // drop this add, so the comment would never be retried. Dedup is handled
      // above (DmLog + owner-reply guards) and the worker is idempotent
      // (publicReplySentAt / SENT), so re-processing a comment is safe.
      await queue.add("process-comment", {
        instagramAccountId: account.instagramId,
        commentId: c.id,
        commentText: c.text ?? "",
        commenterId: c.from!.id,
        commenterName: c.from?.username,
        mediaId,
        source: "POLLING",
      });
      stat.enqueued += 1;
    }
  }

  return stat;
}

async function recordSweep(
  workspaceId: string,
  stat: SweepStat
): Promise<void> {
  // Only log when something happened or something went wrong.
  if (stat.enqueued === 0 && stat.errors.length === 0) return;

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId,
        source: "SYSTEM",
        level: stat.errors.length > 0 ? "WARNING" : "INFO",
        message: `Comment sweep "${stat.campaign}" [${stat.keywords}]: ${stat.enqueued} enqueued, ${stat.matched} matched, ${stat.alreadyReplied} already replied${stat.unverified > 0 ? `, ${stat.unverified} awaiting reply-author check` : ""}`,
        payload: { ...stat },
      },
    })
    .catch(() => {});
}
