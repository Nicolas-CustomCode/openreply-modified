import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockMeta, mockOauth, mockHistory } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { updateMany: vi.fn() },
    instagramAccount: { findMany: vi.fn(), update: vi.fn() },
    automation: { findMany: vi.fn(), update: vi.fn() },
    followerSnapshot: { count: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockMeta: {
    refreshLongLivedToken: vi.fn(),
    getUserMedia: vi.fn(),
    getUserInfo: vi.fn(),
  },
  mockOauth: {
    decryptToken: vi.fn((t: string) => `plain:${t}`),
    encryptToken: vi.fn((t: string) => `enc:${t}`),
  },
  mockHistory: {
    recordFollowerSnapshot: vi.fn(),
    backfillFollowerHistory: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => mockMeta);
vi.mock("@/lib/meta/oauth", () => mockOauth);
vi.mock("@/lib/reports/follower-history", () => mockHistory);

import { refreshExpiringTokens } from "@/lib/jobs/refresh-tokens";
import { attachPendingNextReels } from "@/lib/jobs/attach-next-reel";
import { snapshotFollowers } from "@/lib/jobs/snapshot-followers";
import {
  SCHEDULES,
  registerScheduledJobs,
  REFRESH_TOKENS_JOB,
  ATTACH_NEXT_REEL_JOB,
  SNAPSHOT_FOLLOWERS_JOB,
} from "@/lib/queue/scheduled-jobs";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspace.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockPrisma.instagramAccount.update.mockResolvedValue({});
  mockPrisma.automation.update.mockResolvedValue({});
  mockPrisma.followerSnapshot.count.mockResolvedValue(5);
  mockHistory.recordFollowerSnapshot.mockResolvedValue(undefined);
  mockHistory.backfillFollowerHistory.mockResolvedValue(0);
});

describe("registerScheduledJobs", () => {
  it("registers exactly the three daily jobs, in UTC", async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue({}) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerScheduledJobs(queue as any);

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(3);

    const registered = queue.upsertJobScheduler.mock.calls.map(
      ([id, repeat]) => ({ id, pattern: repeat.pattern, tz: repeat.tz })
    );

    // The exact hours matter: they are the schedule the product ran on before
    // this moved off the platform scheduler.
    expect(registered).toEqual([
      { id: REFRESH_TOKENS_JOB, pattern: "0 5 * * *", tz: "UTC" },
      { id: ATTACH_NEXT_REEL_JOB, pattern: "0 6 * * *", tz: "UTC" },
      { id: SNAPSHOT_FOLLOWERS_JOB, pattern: "0 7 * * *", tz: "UTC" },
    ]);
  });

  it("keys each scheduler on a stable id so restarts do not stack duplicates", async () => {
    const ids = SCHEDULES.map((s) => s.name);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("refreshExpiringTokens", () => {
  it("renews a token and stores it encrypted", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "acc_1", workspaceId: "ws_1", username: "one", accessToken: "old" },
    ]);
    mockMeta.refreshLongLivedToken.mockResolvedValue({
      accessToken: "fresh",
      expiresIn: 5_184_000,
    });

    const result = await refreshExpiringTokens();

    expect(mockMeta.refreshLongLivedToken).toHaveBeenCalledWith("plain:old");
    const update = mockPrisma.instagramAccount.update.mock.calls[0][0];
    // The plaintext token must never reach the database.
    expect(update.data.accessToken).toBe("enc:fresh");
    expect(update.data.tokenExpiresAt).toBeInstanceOf(Date);
    expect(result.results).toEqual([
      { instagramAccountId: "acc_1", username: "one", status: "refreshed" },
    ]);
  });

  it("keeps going when one account fails, and logs that account", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "acc_1", workspaceId: "ws_1", username: "bad", accessToken: "a" },
      { id: "acc_2", workspaceId: "ws_2", username: "good", accessToken: "b" },
    ]);
    mockMeta.refreshLongLivedToken
      .mockRejectedValueOnce(new Error("token revoked"))
      .mockResolvedValueOnce({ accessToken: "fresh", expiresIn: 100 });

    const result = await refreshExpiringTokens();

    expect(result.results.map((r) => r.status)).toEqual([
      "failed",
      "refreshed",
    ]);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: "TOKEN_REFRESH", level: "ERROR" }),
      })
    );
  });

  it("rolls the monthly usage window", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([]);
    mockPrisma.workspace.updateMany.mockResolvedValue({ count: 2 });

    const result = await refreshExpiringTokens();

    expect(mockPrisma.workspace.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dmsSentThisPeriod: 0 }),
      })
    );
    expect(result.workspacesReset).toBe(2);
  });
});

describe("attachPendingNextReels", () => {
  const account = { id: "acc_1", accessToken: "tok" };

  it("binds the earliest reel posted after the campaign was created", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "auto_1",
        instagramAccountId: "acc_1",
        createdAt: new Date("2026-01-10T00:00:00Z"),
        instagramAccount: account,
      },
    ]);
    mockMeta.getUserMedia.mockResolvedValue([
      // Posted before the campaign existed: must be ignored.
      {
        id: "m_old",
        media_product_type: "REELS",
        timestamp: "2026-01-05T00:00:00Z",
        permalink: "u_old",
      },
      {
        id: "m_next",
        media_product_type: "REELS",
        timestamp: "2026-01-12T00:00:00Z",
        permalink: "u_next",
      },
      {
        id: "m_later",
        media_product_type: "REELS",
        timestamp: "2026-01-20T00:00:00Z",
        permalink: "u_later",
      },
    ]);

    const result = await attachPendingNextReels();

    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "auto_1" },
        data: { postId: "m_next", postUrl: "u_next", pendingNextReel: false },
      })
    );
    expect(result).toEqual({ checked: 1, bound: 1, failedAccounts: 0 });
  });

  it("ignores non-reel media", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "auto_1",
        instagramAccountId: "acc_1",
        createdAt: new Date("2026-01-10T00:00:00Z"),
        instagramAccount: account,
      },
    ]);
    mockMeta.getUserMedia.mockResolvedValue([
      {
        id: "m_img",
        media_product_type: "FEED",
        timestamp: "2026-01-12T00:00:00Z",
      },
    ]);

    const result = await attachPendingNextReels();

    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
    expect(result.bound).toBe(0);
  });

  it("counts a media fetch failure without aborting the sweep", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        id: "auto_1",
        instagramAccountId: "acc_1",
        createdAt: new Date("2026-01-10T00:00:00Z"),
        instagramAccount: account,
      },
    ]);
    mockMeta.getUserMedia.mockRejectedValue(new Error("rate limited"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const result = await attachPendingNextReels();

    expect(result).toEqual({ checked: 1, bound: 0, failedAccounts: 1 });
    consoleError.mockRestore();
  });
});

describe("snapshotFollowers", () => {
  const account = {
    id: "acc_1",
    workspaceId: "ws_1",
    username: "one",
    instagramId: "ig_1",
    accessToken: "tok",
  };

  it("records today's follower count", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([account]);
    mockMeta.getUserInfo.mockResolvedValue({ followers_count: 1234 });

    const result = await snapshotFollowers();

    expect(mockHistory.recordFollowerSnapshot).toHaveBeenCalledWith(
      "acc_1",
      1234
    );
    expect(result.recorded).toBe(1);
  });

  it("backfills history only the first time an account is seen", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([account]);
    mockMeta.getUserInfo.mockResolvedValue({ followers_count: 10 });
    mockPrisma.followerSnapshot.count.mockResolvedValue(1);
    mockHistory.backfillFollowerHistory.mockResolvedValue(30);

    const result = await snapshotFollowers();

    expect(mockHistory.backfillFollowerHistory).toHaveBeenCalled();
    expect(result.backfilled).toBe(30);
  });

  it("does not backfill an account that already has history", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([account]);
    mockMeta.getUserInfo.mockResolvedValue({ followers_count: 10 });
    mockPrisma.followerSnapshot.count.mockResolvedValue(12);

    await snapshotFollowers();

    expect(mockHistory.backfillFollowerHistory).not.toHaveBeenCalled();
  });

  it("records the others when one account fails", async () => {
    // A missed day cannot be recovered later, so one bad account must not cost
    // the rest their snapshot.
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { ...account, id: "acc_bad", username: "bad" },
      { ...account, id: "acc_ok", username: "ok" },
    ]);
    mockMeta.getUserInfo
      .mockRejectedValueOnce(new Error("token expired"))
      .mockResolvedValueOnce({ followers_count: 7 });

    const result = await snapshotFollowers();

    expect(result.recorded).toBe(1);
    expect(result.failures).toEqual([
      { username: "bad", reason: "token expired" },
    ]);
    expect(mockHistory.recordFollowerSnapshot).toHaveBeenCalledWith("acc_ok", 7);
  });

  it("flags an account whose follower count is missing", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([account]);
    mockMeta.getUserInfo.mockResolvedValue({});

    const result = await snapshotFollowers();

    expect(result.recorded).toBe(0);
    expect(result.failures[0].reason).toContain("followers_count");
  });
});
