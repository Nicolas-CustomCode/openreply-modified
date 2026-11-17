/**
 * Whether the connected account has answered a comment.
 *
 * Meta returns a comment's replies without their author whenever they are read
 * in bulk, so the replies alone cannot say which one is the account's. Only
 * GET /{reply-id} names the author. That is a call per reply on the token the
 * automation sends with, so:
 *
 * - every answer is kept in CommentReplyAuthor, and a reply is looked up at
 *   most once, ever (its author never changes);
 * - replies OpenReply posts itself are recorded as the account's when sent,
 *   with no lookup (recordOwnReply);
 * - a comment with no replies is unanswered without any call;
 * - a comment stops being looked into at its first reply from the account;
 * - each pass has a lookup budget. Comments it could not settle come back as
 *   unverified and are settled by a later pass.
 */

import { prisma } from "@/lib/db/client";
import { isOwnReply, mapWithConcurrency, type CommentAccount } from "@/lib/instagram-comments";
import {
  getCommentReplyAuthor,
  RateLimitError,
  type InstagramComment,
} from "@/lib/meta/client";

const LOOKUP_CONCURRENCY = 3;
// Reply ids come from Meta, but they still go into a URL path, so only a plain
// numeric id is ever looked up.
const REPLY_ID = /^\d{1,32}$/;

export interface ReplyAuthorAccount extends CommentAccount {
  /** InstagramAccount.id — the cache is kept per connected account. */
  id: string;
}

export interface AnsweredResolution {
  /** Reply ids known to be the account's. */
  ownReplyIds: Set<string>;
  /** Comments that have replies whose authors are still unknown. */
  unverifiedCommentIds: Set<string>;
  /** How many GET /{reply-id} calls this pass made. */
  lookups: number;
}

/**
 * Record a reply the account itself just posted, so it is never looked up.
 * Never throws: failing to cache must not fail the send that preceded it.
 */
export async function recordOwnReply(
  instagramAccountId: string,
  replyId: string | undefined | null
): Promise<void> {
  if (!replyId) return;
  try {
    await prisma.commentReplyAuthor.upsert({
      where: { replyId },
      create: { replyId, instagramAccountId, fromAccount: true },
      update: { fromAccount: true },
    });
  } catch (error) {
    console.warn(
      "[Reply authors] Could not record own reply:",
      error instanceof Error ? error.message : error
    );
  }
}

/** Whether `comment` has a reply from the account, per a resolution. */
export function commentIsAnswered(
  comment: InstagramComment,
  account: CommentAccount,
  resolution: Pick<AnsweredResolution, "ownReplyIds">
): boolean {
  return (comment.replies?.data ?? []).some(
    (reply) => isOwnReply(reply, account) || resolution.ownReplyIds.has(reply.id)
  );
}

/**
 * Settle which of `comments` the account has answered, spending at most
 * `budget` reply lookups. Comments are taken in the order given, so pass the
 * ones that matter most first.
 */
export async function resolveAnsweredComments(
  account: ReplyAuthorAccount,
  accessToken: string,
  comments: InstagramComment[],
  options: { budget: number }
): Promise<AnsweredResolution> {
  const ownReplyIds = new Set<string>();
  const unverifiedCommentIds = new Set<string>();

  const allReplyIds = comments.flatMap((c) =>
    (c.replies?.data ?? []).map((r) => r.id)
  );
  if (allReplyIds.length === 0) {
    return { ownReplyIds, unverifiedCommentIds, lookups: 0 };
  }

  const cached = await prisma.commentReplyAuthor.findMany({
    where: { instagramAccountId: account.id, replyId: { in: allReplyIds } },
    select: { replyId: true, fromAccount: true },
  });
  const known = new Map(cached.map((row) => [row.replyId, row.fromAccount]));

  // Settle what needs no call: an author Meta did send, or a cached answer.
  const pending: { commentId: string; replyIds: string[] }[] = [];
  for (const comment of comments) {
    const replies = comment.replies?.data ?? [];
    const unknown: string[] = [];
    let answered = false;

    for (const reply of replies) {
      if (isOwnReply(reply, account) || known.get(reply.id) === true) {
        ownReplyIds.add(reply.id);
        answered = true;
      } else if (!known.has(reply.id) && REPLY_ID.test(reply.id)) {
        unknown.push(reply.id);
      }
    }

    if (!answered && unknown.length > 0) {
      pending.push({ commentId: comment.id, replyIds: unknown });
    }
  }

  let budget = options.budget;
  let lookups = 0;
  let rateLimited = false;
  const learned: { replyId: string; fromAccount: boolean }[] = [];

  await mapWithConcurrency(pending, LOOKUP_CONCURRENCY, async (item) => {
    for (const replyId of item.replyIds) {
      if (budget <= 0 || rateLimited) {
        unverifiedCommentIds.add(item.commentId);
        return;
      }
      budget -= 1;
      lookups += 1;

      try {
        const author = await getCommentReplyAuthor(accessToken, replyId);
        const fromAccount = isOwnReply(
          { from: author.id ? { id: author.id } : undefined, username: author.username },
          account
        );
        // A reply whose author Meta will not name even here is recorded as
        // not the account's: the account's own replies come back with one.
        learned.push({ replyId, fromAccount });
        if (fromAccount) {
          ownReplyIds.add(replyId);
          return; // One reply from the account is enough.
        }
      } catch (error) {
        // Not cached, so a later pass tries again.
        if (error instanceof RateLimitError) rateLimited = true;
        unverifiedCommentIds.add(item.commentId);
        return;
      }
    }
  });

  if (learned.length > 0) {
    await prisma.commentReplyAuthor
      .createMany({
        data: learned.map((row) => ({
          ...row,
          instagramAccountId: account.id,
        })),
        skipDuplicates: true,
      })
      .catch((error) => {
        console.warn(
          "[Reply authors] Could not cache reply authors:",
          error instanceof Error ? error.message : error
        );
      });
  }

  return { ownReplyIds, unverifiedCommentIds, lookups };
}
