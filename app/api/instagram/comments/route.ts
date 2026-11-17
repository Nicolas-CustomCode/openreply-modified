import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  buildCommentList,
  mapWithConcurrency,
  MAX_COMMENTS_PER_POST,
  MAX_REPLY_LENGTH,
  parseCommentsQuery,
  toCommentPostItem,
  type CommentListItem,
  type CommentPostItem,
} from "@/lib/instagram-comments";
import {
  getRecentMediaComments,
  getUserMedia,
  MetaApiError,
  sendCommentReply,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

// How many posts' comments are fetched at once.
const COMMENT_FETCH_CONCURRENCY = 3;

export interface CommentsResponse {
  account: { id: string; username: string; instagramId: string };
  posts: CommentPostItem[];
  comments: CommentListItem[];
  /** Posts whose comments could not be read; the rest are still returned. */
  errors: { postId: string; message: string }[];
  /** Whether the current user may reply (owners and admins only). */
  canReply: boolean;
}

function metaMessage(error: unknown, fallback: string): string {
  return error instanceof MetaApiError ? error.message : fallback;
}

/**
 * Recent comments on the account's latest posts, with their replies and
 * whether the account has answered each one.
 *
 *   ?instagramAccountId=…  which connected account (defaults to the newest)
 *   ?posts=10              how many recent posts to read (max 25)
 *   ?hours=48              only comments from the last N hours (max 168)
 *   ?unanswered=true       leave out comments the account already replied to
 */
export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const params = request.nextUrl.searchParams;
  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    params.get("instagramAccountId")
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  const query = parseCommentsQuery(params);

  let accessToken: string;
  try {
    accessToken = decryptToken(account.accessToken);
  } catch {
    return NextResponse.json(
      { success: false, error: "Failed to decrypt the Instagram access token." },
      { status: 500 }
    );
  }

  try {
    const media = await getUserMedia(accessToken, query.posts);
    const sinceMs = Date.now() - query.hours * 60 * 60 * 1000;
    const errors: CommentsResponse["errors"] = [];

    // A post with no comments at all cannot have recent ones, so it costs no
    // call. comments_count can be absent, in which case the post is read.
    const withComments = media.filter((m) => m.comments_count !== 0);

    const perPost = await mapWithConcurrency(
      withComments,
      COMMENT_FETCH_CONCURRENCY,
      async (m) => {
        try {
          const comments = await getRecentMediaComments(
            accessToken,
            m.id,
            sinceMs,
            MAX_COMMENTS_PER_POST
          );
          return { postId: m.id, comments };
        } catch (error) {
          errors.push({
            postId: m.id,
            message: metaMessage(error, "Failed to load comments"),
          });
          return { postId: m.id, comments: [] };
        }
      }
    );

    const data: CommentsResponse = {
      account: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
      },
      posts: media.map(toCommentPostItem),
      comments: buildCommentList(account.instagramId, perPost, {
        unanswered: query.unanswered,
      }),
      errors,
      canReply: canManageWorkspace(context.role),
    };
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[Comments] Error:", error);
    return NextResponse.json(
      { success: false, error: metaMessage(error, "Failed to load comments") },
      { status: error instanceof MetaApiError ? 502 : 500 }
    );
  }
}

const replySchema = z.object({
  instagramAccountId: z.string().min(1).optional(),
  // The id goes straight into the Graph API path (/{commentId}/replies), so
  // only a plain numeric Instagram id is accepted — anything with a slash or a
  // dot could point the account's token at a different endpoint.
  commentId: z.string().regex(/^\d{1,32}$/),
  text: z.string().trim().min(1).max(MAX_REPLY_LENGTH),
});

/**
 * Post a public reply under a comment, as the connected account.
 *
 * Owners and admins only: the reply is public and speaks for the brand, and a
 * member cannot create a campaign with a public reply either.
 *
 * A reply from the account is also what the polling reconciler reads as
 * "already handled", so a keyword comment answered here before its DM went out
 * will not be picked up by the reconciler. The webhook path is unaffected.
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
      { success: false, error: "Only owners and admins can reply to comments." },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  const parsed = replySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: `A comment id and a reply of 1 to ${MAX_REPLY_LENGTH} characters are required.`,
      },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    parsed.data.instagramAccountId ?? null
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  try {
    const accessToken = decryptToken(account.accessToken);
    const result = await sendCommentReply(
      accessToken,
      parsed.data.commentId,
      parsed.data.text
    );
    return NextResponse.json({ success: true, data: { id: result.id } });
  } catch (error) {
    console.error("[Comments] Reply error:", error);
    // Meta's own message is the useful part — e.g. replying to a reply, which
    // Instagram does not allow, or a comment that has since been deleted.
    return NextResponse.json(
      { success: false, error: metaMessage(error, "Failed to post the reply") },
      { status: 502 }
    );
  }
}
