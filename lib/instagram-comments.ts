/**
 * Manual comment replies: shaping Instagram comments for the comments page.
 *
 * Kept free of network and database access so the rules that decide what the
 * page shows — which comments count as answered, what the query limits are —
 * can be tested on their own. The route in app/api/instagram/comments does the
 * fetching and hands the raw Graph API data to these functions.
 */

import type { InstagramComment, InstagramMedia } from "@/lib/meta/client";

// Every listed post costs at least one comments call on the account's token,
// the same token the worker and the polling reconciler send with. These caps
// keep one page load from eating the budget the automation depends on.
export const DEFAULT_POSTS = 10;
export const MAX_POSTS = 25;
export const DEFAULT_HOURS = 48;
export const MAX_HOURS = 168;
// Per post. A viral post can carry thousands of comments; only the newest are
// worth answering by hand.
export const MAX_COMMENTS_PER_POST = 200;
// Instagram's own ceiling for a comment's text. Meta may still reject a shorter
// reply for other reasons (too many hashtags or mentions, a link), and that
// error is passed back to the caller as-is.
export const MAX_REPLY_LENGTH = 2200;

export interface CommentsQuery {
  posts: number;
  hours: number;
  unanswered: boolean;
}

export interface CommentPostItem {
  id: string;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  mediaType: string;
  timestamp: string;
}

export interface CommentReplyItem {
  id: string;
  text: string;
  username: string | null;
  fromMe: boolean;
  timestamp: string | null;
}

export interface CommentListItem {
  id: string;
  postId: string;
  text: string;
  username: string | null;
  userId: string;
  timestamp: string | null;
  /** True when the connected account has replied to this comment. */
  answered: boolean;
  replies: CommentReplyItem[];
}

function readInt(
  raw: string | null,
  fallback: number,
  max: number
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/**
 * Read ?posts, ?hours and ?unanswered. Bad values fall back to the default and
 * out-of-range values are clamped, rather than rejected, because the only
 * caller is our own page and a clamp is never harmful.
 */
export function parseCommentsQuery(params: URLSearchParams): CommentsQuery {
  const unanswered = params.get("unanswered");
  return {
    posts: readInt(params.get("posts"), DEFAULT_POSTS, MAX_POSTS),
    hours: readInt(params.get("hours"), DEFAULT_HOURS, MAX_HOURS),
    unanswered: unanswered === "true" || unanswered === "1",
  };
}

export function toCommentPostItem(media: InstagramMedia): CommentPostItem {
  return {
    id: media.id,
    caption: media.caption ?? null,
    permalink: media.permalink ?? null,
    thumbnailUrl: media.thumbnail_url ?? media.media_url ?? null,
    mediaType: media.media_type,
    timestamp: media.timestamp,
  };
}

function timeOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Turn each post's raw comments into one list, newest first.
 *
 * The account's own top-level comments are left out: they are not something to
 * reply to. A comment is `answered` when any of its replies comes from the
 * account — the same test the polling reconciler uses to decide a comment is
 * already handled, so the page and the automation agree on what "answered"
 * means.
 */
export function buildCommentList(
  accountInstagramId: string,
  perPost: { postId: string; comments: InstagramComment[] }[],
  options: { unanswered: boolean }
): CommentListItem[] {
  const items: CommentListItem[] = [];

  for (const { postId, comments } of perPost) {
    for (const comment of comments) {
      const userId = comment.from?.id;
      if (!userId || userId === accountInstagramId) continue;

      const replies: CommentReplyItem[] = (comment.replies?.data ?? [])
        .map((reply) => ({
          id: reply.id,
          text: reply.text ?? "",
          username: reply.from?.username ?? null,
          fromMe: reply.from?.id === accountInstagramId,
          timestamp: reply.timestamp ?? null,
        }))
        .sort((a, b) => timeOf(a.timestamp) - timeOf(b.timestamp));

      const answered = replies.some((reply) => reply.fromMe);
      if (options.unanswered && answered) continue;

      items.push({
        id: comment.id,
        postId,
        text: comment.text ?? "",
        username: comment.from?.username ?? null,
        userId,
        timestamp: comment.timestamp ?? null,
        answered,
        replies,
      });
    }
  }

  return items.sort((a, b) => timeOf(b.timestamp) - timeOf(a.timestamp));
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight, keeping results in
 * input order. Fetching every post at once would burst the comments API, which
 * Instagram rate-limits aggressively.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run())
  );
  return results;
}
