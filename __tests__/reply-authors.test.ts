import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockMeta } = vi.hoisted(() => ({
  mockPrisma: {
    commentReplyAuthor: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
  mockMeta: { getCommentReplyAuthor: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  ...mockMeta,
}));

import {
  commentIsAnswered,
  recordOwnReply,
  resolveAnsweredComments,
} from "@/lib/reply-authors";
import { RateLimitError, type InstagramComment } from "@/lib/meta/client";

const ACCOUNT = {
  id: "acct_1",
  instagramId: "17841400000000001",
  username: "brand",
};

// Replies as Meta returns them in bulk: id and timestamp, no author.
function comment(id: string, replyIds: string[]): InstagramComment {
  return {
    id,
    text: "hi",
    timestamp: "2026-11-17T10:00:00+0000",
    from: { id: `fan_${id}`, username: `fan${id}` },
    replies: { data: replyIds.map((r) => ({ id: r })) },
  };
}

function author(username: string, id?: string) {
  return { id, username };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.commentReplyAuthor.findMany.mockResolvedValue([]);
  mockPrisma.commentReplyAuthor.createMany.mockResolvedValue({ count: 0 });
});

describe("resolveAnsweredComments", () => {
  it("spends nothing on comments without replies", async () => {
    const result = await resolveAnsweredComments(
      ACCOUNT,
      "token",
      [comment("1", [])],
      { budget: 30 }
    );

    expect(result.lookups).toBe(0);
    expect(result.unverifiedCommentIds.size).toBe(0);
    expect(mockPrisma.commentReplyAuthor.findMany).not.toHaveBeenCalled();
    expect(mockMeta.getCommentReplyAuthor).not.toHaveBeenCalled();
  });

  it("settles from the cache without calling Meta", async () => {
    mockPrisma.commentReplyAuthor.findMany.mockResolvedValue([
      { replyId: "100", fromAccount: true },
      { replyId: "200", fromAccount: false },
    ]);

    const comments = [comment("1", ["100"]), comment("2", ["200"])];
    const result = await resolveAnsweredComments(ACCOUNT, "token", comments, {
      budget: 30,
    });

    expect(mockMeta.getCommentReplyAuthor).not.toHaveBeenCalled();
    expect(commentIsAnswered(comments[0], ACCOUNT, result)).toBe(true);
    expect(commentIsAnswered(comments[1], ACCOUNT, result)).toBe(false);
    expect(result.unverifiedCommentIds.size).toBe(0);
    expect(mockPrisma.commentReplyAuthor.findMany).toHaveBeenCalledWith({
      where: { instagramAccountId: "acct_1", replyId: { in: ["100", "200"] } },
      select: { replyId: true, fromAccount: true },
    });
  });

  it("looks up unknown replies, stops at the first from the account, and caches", async () => {
    mockMeta.getCommentReplyAuthor
      .mockResolvedValueOnce(author("fan9")) // 101: someone else
      .mockResolvedValueOnce(author("brand", ACCOUNT.instagramId)); // 102: the account

    const comments = [comment("1", ["101", "102", "103"])];
    const result = await resolveAnsweredComments(ACCOUNT, "token", comments, {
      budget: 30,
    });

    // 103 is never looked up: one reply from the account is enough.
    expect(mockMeta.getCommentReplyAuthor.mock.calls.map((c) => c[1])).toEqual([
      "101",
      "102",
    ]);
    expect(result.lookups).toBe(2);
    expect(commentIsAnswered(comments[0], ACCOUNT, result)).toBe(true);
    expect(mockPrisma.commentReplyAuthor.createMany).toHaveBeenCalledWith({
      data: [
        { replyId: "101", fromAccount: false, instagramAccountId: "acct_1" },
        { replyId: "102", fromAccount: true, instagramAccountId: "acct_1" },
      ],
      skipDuplicates: true,
    });
  });

  it("settles a comment as unanswered once every reply is someone else's", async () => {
    mockMeta.getCommentReplyAuthor.mockResolvedValue(author("fan9"));

    const comments = [comment("1", ["101", "102"])];
    const result = await resolveAnsweredComments(ACCOUNT, "token", comments, {
      budget: 30,
    });

    expect(commentIsAnswered(comments[0], ACCOUNT, result)).toBe(false);
    expect(result.unverifiedCommentIds.has("1")).toBe(false);
  });

  it("leaves comments unverified once the budget runs out", async () => {
    mockMeta.getCommentReplyAuthor.mockResolvedValue(author("fan9"));

    const result = await resolveAnsweredComments(
      ACCOUNT,
      "token",
      [comment("1", ["101"]), comment("2", ["201"]), comment("3", ["301"])],
      { budget: 2 }
    );

    expect(result.lookups).toBe(2);
    expect(mockMeta.getCommentReplyAuthor).toHaveBeenCalledTimes(2);
    expect([...result.unverifiedCommentIds]).toEqual(["3"]);
  });

  it("stops on a rate limit and caches nothing for the failed reply", async () => {
    mockMeta.getCommentReplyAuthor.mockRejectedValue(new RateLimitError("slow"));

    const result = await resolveAnsweredComments(
      ACCOUNT,
      "token",
      [comment("1", ["101"]), comment("2", ["201"]), comment("3", ["301"]), comment("4", ["401"])],
      { budget: 30 }
    );

    // At most the calls already in flight (3 at a time) are made.
    expect(mockMeta.getCommentReplyAuthor.mock.calls.length).toBeLessThanOrEqual(3);
    expect(result.unverifiedCommentIds.size).toBe(4);
    expect(mockPrisma.commentReplyAuthor.createMany).not.toHaveBeenCalled();
  });

  it("never puts a non-numeric reply id into a request path", async () => {
    const result = await resolveAnsweredComments(
      ACCOUNT,
      "token",
      [comment("1", ["../me"])],
      { budget: 30 }
    );

    expect(mockMeta.getCommentReplyAuthor).not.toHaveBeenCalled();
    expect(result.unverifiedCommentIds.size).toBe(0);
  });
});

describe("recordOwnReply", () => {
  it("records a reply as the account's", async () => {
    mockPrisma.commentReplyAuthor.upsert.mockResolvedValue({});

    await recordOwnReply("acct_1", "999");

    expect(mockPrisma.commentReplyAuthor.upsert).toHaveBeenCalledWith({
      where: { replyId: "999" },
      create: { replyId: "999", instagramAccountId: "acct_1", fromAccount: true },
      update: { fromAccount: true },
    });
  });

  it("never throws, so a send never fails over the cache", async () => {
    mockPrisma.commentReplyAuthor.upsert.mockRejectedValue(new Error("db down"));

    await expect(recordOwnReply("acct_1", "999")).resolves.toBeUndefined();
    await expect(recordOwnReply("acct_1", undefined)).resolves.toBeUndefined();
  });
});
