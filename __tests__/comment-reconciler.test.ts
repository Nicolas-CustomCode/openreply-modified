import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockQueue, mockMeta } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockQueue: { add: vi.fn() },
  mockMeta: {
    getRecentMediaComments: vi.fn(),
    getUserMedia: vi.fn(),
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
});

describe("reconcileComments", () => {
  it("skips a keyword comment the owner answered, even when the reply has no `from`", async () => {
    mockMeta.getRecentMediaComments.mockResolvedValue([
      {
        id: "answered",
        text: "link please",
        timestamp: recent,
        from: { id: "fan_1", username: "fan1" },
        replies: { data: [{ id: "r1", text: "sent!", username: "brand" }] },
      },
      {
        id: "open",
        text: "link",
        timestamp: recent,
        from: { id: "fan_2", username: "fan2" },
        replies: { data: [{ id: "r2", text: "me too", username: "fan3" }] },
      },
    ]);

    await reconcileComments();

    const enqueued = mockQueue.add.mock.calls.map((call) => call[1].commentId);
    expect(enqueued).toEqual(["open"]);
  });
});
