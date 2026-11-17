import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockQueue, mockMeta } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
    commentReplyAuthor: { findMany: vi.fn(), createMany: vi.fn() },
  },
  mockQueue: { add: vi.fn() },
  mockMeta: {
    getRecentMediaComments: vi.fn(),
    getUserMedia: vi.fn(),
    getCommentReplyAuthor: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => mockQueue }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "token" }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  ...mockMeta,
}));

import { reconcileComments } from "@/lib/polling/comment-reconciler";

const ACCOUNT = {
  id: "acct_1",
  instagramId: "17841400000000001",
  username: "brand",
  accessToken: "encrypted",
};

const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.automation.findMany.mockResolvedValue([
    {
      id: "auto_1",
      name: "Link",
      postId: "m1",
      matchAnyPost: false,
      matchAnyWord: false,
      keywords: ["link"],
      wholeWordMatch: true,
      publicReplyEnabled: false,
      workspaceId: "ws_1",
      instagramAccount: ACCOUNT,
    },
  ]);
  mockPrisma.dmLog.findMany.mockResolvedValue([]);
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockPrisma.commentReplyAuthor.findMany.mockResolvedValue([]);
  mockPrisma.commentReplyAuthor.createMany.mockResolvedValue({ count: 0 });
});

describe("reconcileComments", () => {
  it("skips a keyword comment the owner answered, found through the reply lookup", async () => {
    // Replies come back with no author at all, as Meta sends them in bulk.
    mockMeta.getRecentMediaComments.mockResolvedValue([
      {
        id: "answered",
        text: "link please",
        timestamp: recent,
        from: { id: "fan_1", username: "fan1" },
        replies: { data: [{ id: "101" }] },
      },
      {
        id: "open",
        text: "link",
        timestamp: recent,
        from: { id: "fan_2", username: "fan2" },
        replies: { data: [{ id: "201" }] },
      },
    ]);
    mockMeta.getCommentReplyAuthor.mockImplementation(async (_token, replyId) =>
      replyId === "101" ? { username: "brand" } : { username: "fan3" }
    );

    await reconcileComments();

    const enqueued = mockQueue.add.mock.calls.map((call) => call[1].commentId);
    expect(enqueued).toEqual(["open"]);
  });

  it("does not spend lookups on comments the campaign already handled", async () => {
    mockMeta.getRecentMediaComments.mockResolvedValue([
      {
        id: "done",
        text: "link",
        timestamp: recent,
        from: { id: "fan_1" },
        replies: { data: [{ id: "101" }] },
      },
    ]);
    mockPrisma.dmLog.findMany.mockResolvedValue([{ commentId: "done" }]);

    await reconcileComments();

    expect(mockMeta.getCommentReplyAuthor).not.toHaveBeenCalled();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it("holds back a comment whose replies could not be checked yet", async () => {
    mockMeta.getRecentMediaComments.mockResolvedValue([
      {
        id: "unknown",
        text: "link",
        timestamp: recent,
        from: { id: "fan_1" },
        replies: { data: [{ id: "101" }] },
      },
      {
        id: "no-replies",
        text: "link",
        timestamp: recent,
        from: { id: "fan_2" },
      },
    ]);
    mockMeta.getCommentReplyAuthor.mockRejectedValue(new Error("temporary"));

    await reconcileComments();

    // Not DM'd blind; a comment with no replies at all needs no check.
    const enqueued = mockQueue.add.mock.calls.map((call) => call[1].commentId);
    expect(enqueued).toEqual(["no-replies"]);
  });
});
