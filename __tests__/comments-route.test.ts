import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockContext, mockAccounts, mockMeta, mockOauth } = vi.hoisted(() => ({
  mockContext: { getCurrentWorkspaceContext: vi.fn() },
  mockAccounts: { getWorkspaceInstagramAccount: vi.fn() },
  mockMeta: {
    getUserMedia: vi.fn(),
    getRecentUserMedia: vi.fn(),
    getRecentMediaComments: vi.fn(),
    sendCommentReply: vi.fn(),
  },
  mockOauth: { decryptToken: vi.fn() },
}));

// workspace-access is loaded for real so the route is checked against the
// actual role rule; only the session lookup is replaced. Its own imports are
// stubbed so nothing reaches Auth.js or the database.
vi.mock("@/lib/auth", () => ({ getCurrentUserId: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/workspace", () => ({ ensureWorkspaceForUser: vi.fn() }));
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-access")>()),
  ...mockContext,
}));
vi.mock("@/lib/instagram-accounts", () => mockAccounts);
vi.mock("@/lib/meta/oauth", () => mockOauth);
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  ...mockMeta,
}));

import { GET, POST } from "../app/api/instagram/comments/route";
import { MetaApiError, RateLimitError } from "@/lib/meta/client";

const ACCOUNT = {
  id: "acct_1",
  username: "brand",
  instagramId: "17841400000000001",
  accessToken: "encrypted",
};

function context(role: "OWNER" | "ADMIN" | "MEMBER") {
  return { userId: "user_1", workspaceId: "ws_1", workspace: {}, role };
}

function get(query = "") {
  return new NextRequest(`https://openreply.test/api/instagram/comments${query}`);
}

function post(body: unknown) {
  return new NextRequest("https://openreply.test/api/instagram/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockContext.getCurrentWorkspaceContext.mockResolvedValue(context("OWNER"));
  mockAccounts.getWorkspaceInstagramAccount.mockResolvedValue(ACCOUNT);
  mockOauth.decryptToken.mockReturnValue("token");
});

describe("GET /api/instagram/comments", () => {
  it("requires a session", async () => {
    mockContext.getCurrentWorkspaceContext.mockResolvedValue(null);

    const response = await GET(get());

    expect(response.status).toBe(401);
  });

  it("lists comments, skips posts with none, and reports per-post failures", async () => {
    mockMeta.getUserMedia.mockResolvedValue([
      { id: "m1", media_type: "VIDEO", timestamp: "2026-11-17T08:00:00+0000", comments_count: 2 },
      { id: "m2", media_type: "IMAGE", timestamp: "2026-11-16T08:00:00+0000", comments_count: 0 },
      { id: "m3", media_type: "IMAGE", timestamp: "2026-11-15T08:00:00+0000", comments_count: 4 },
    ]);
    mockMeta.getRecentMediaComments.mockImplementation(async (_token, mediaId) => {
      if (mediaId === "m3") throw new RateLimitError("slow down");
      return [
        {
          id: "c1",
          text: "LINK",
          timestamp: "2026-11-17T09:00:00+0000",
          from: { id: "fan", username: "fan" },
        },
      ];
    });

    const response = await GET(get("?posts=5&hours=24&unanswered=true"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockMeta.getUserMedia).toHaveBeenCalledWith("token", 5);
    // m2 has no comments, so it is never read.
    expect(mockMeta.getRecentMediaComments.mock.calls.map((c) => c[1])).toEqual([
      "m1",
      "m3",
    ]);
    expect(body.data.posts).toHaveLength(3);
    expect(body.data.comments).toEqual([
      expect.objectContaining({ id: "c1", postId: "m1", answered: false }),
    ]);
    expect(body.data.errors).toEqual([
      { postId: "m3", message: "slow down" },
    ]);
    expect(body.data.canReply).toBe(true);
  });

  it("with ?since reads every post published since then", async () => {
    mockMeta.getRecentUserMedia.mockResolvedValue({
      media: [
        { id: "m1", media_type: "IMAGE", timestamp: "2026-11-17T08:00:00+0000", comments_count: 1 },
      ],
      truncated: true,
    });
    mockMeta.getRecentMediaComments.mockResolvedValue([
      {
        id: "c1",
        text: "hi",
        timestamp: "2026-11-17T09:00:00+0000",
        from: { id: "fan", username: "fan" },
        // No `from` on the reply, as Meta returns it: matched by username.
        replies: { data: [{ id: "r1", text: "thanks", username: "brand" }] },
      },
    ]);

    const since = "2026-11-16T12:00:00.000Z";
    const body = await (await GET(get(`?since=${since}&posts=3`))).json();

    expect(mockMeta.getUserMedia).not.toHaveBeenCalled();
    expect(mockMeta.getRecentUserMedia).toHaveBeenCalledWith("token", {
      sinceMs: Date.parse(since),
      min: 10,
      max: 100,
    });
    expect(body.data.postsTruncated).toBe(true);
    expect(body.data.comments[0]).toMatchObject({ id: "c1", answered: true });
  });

  it("lets a member read but tells the page they cannot reply", async () => {
    mockContext.getCurrentWorkspaceContext.mockResolvedValue(context("MEMBER"));
    mockMeta.getUserMedia.mockResolvedValue([]);

    const body = await (await GET(get())).json();

    expect(body.success).toBe(true);
    expect(body.data.canReply).toBe(false);
  });

  it("passes Meta's error back when the post list fails", async () => {
    mockMeta.getUserMedia.mockRejectedValue(
      new MetaApiError(1, undefined, undefined, "Meta is down")
    );

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("Meta is down");
  });
});

describe("POST /api/instagram/comments", () => {
  it("refuses members", async () => {
    mockContext.getCurrentWorkspaceContext.mockResolvedValue(context("MEMBER"));

    const response = await POST(post({ commentId: "17900000000000001", text: "hi" }));

    expect(response.status).toBe(403);
    expect(mockMeta.sendCommentReply).not.toHaveBeenCalled();
  });

  it("lets an admin reply and trims the text", async () => {
    mockContext.getCurrentWorkspaceContext.mockResolvedValue(context("ADMIN"));
    mockMeta.sendCommentReply.mockResolvedValue({ id: "17900000000000099" });

    const response = await POST(
      post({ commentId: "17900000000000001", text: "  thanks!  " })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.id).toBe("17900000000000099");
    expect(mockMeta.sendCommentReply).toHaveBeenCalledWith(
      "token",
      "17900000000000001",
      "thanks!"
    );
  });

  it.each([
    ["a path in the comment id", { commentId: "123/../me", text: "hi" }],
    ["a non-numeric comment id", { commentId: "abc", text: "hi" }],
    ["blank text", { commentId: "17900000000000001", text: "   " }],
    ["text over the limit", { commentId: "17900000000000001", text: "a".repeat(2201) }],
  ])("rejects %s", async (_label, body) => {
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    expect(mockMeta.sendCommentReply).not.toHaveBeenCalled();
  });

  it("passes Meta's error back when the reply is refused", async () => {
    mockMeta.sendCommentReply.mockRejectedValue(
      new MetaApiError(100, 33, undefined, "Cannot reply to a reply")
    );

    const response = await POST(post({ commentId: "17900000000000001", text: "hi" }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("Cannot reply to a reply");
  });
});
