import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockContext } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      delete: vi.fn(),
    },
    automation: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  mockContext: { getCurrentWorkspaceContext: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
// workspace-access is loaded for real so the routes are checked against the
// actual role rule; only the session lookup is replaced.
vi.mock("@/lib/auth", () => ({ getCurrentUserId: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ ensureWorkspaceForUser: vi.fn() }));
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-access")>()),
  ...mockContext,
}));

import {
  disconnectInstagramAccounts,
  removeInstagramAccountPermanently,
} from "@/lib/instagram-accounts";
import { POST as disconnect } from "../app/api/instagram/disconnect/route";
import { DELETE as removeAccount } from "../app/api/instagram/accounts/route";

function context(role: "OWNER" | "ADMIN" | "MEMBER") {
  return { userId: "user_1", workspaceId: "ws_1", workspace: {}, role };
}

function request(method: string, url: string, body: unknown) {
  return new NextRequest(`https://openreply.test${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Prisma's batch $transaction takes the already-built operations.
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => ops);
  mockPrisma.automation.updateMany.mockReturnValue("pause-campaigns");
  mockPrisma.instagramAccount.updateMany.mockReturnValue("mark-disconnected");
  mockContext.getCurrentWorkspaceContext.mockResolvedValue(context("ADMIN"));
});

describe("disconnectInstagramAccounts", () => {
  it("keeps the account, wipes its token and pauses its campaigns", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([{ id: "acct_1" }]);

    const count = await disconnectInstagramAccounts("ws_1", "acct_1");

    expect(count).toBe(1);
    expect(mockPrisma.instagramAccount.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_1", disconnectedAt: null, id: "acct_1" },
      select: { id: true },
    });
    expect(mockPrisma.automation.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_1", instagramAccountId: { in: ["acct_1"] } },
      data: { isActive: false },
    });
    const update = mockPrisma.instagramAccount.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ workspaceId: "ws_1", id: { in: ["acct_1"] } });
    expect(update.data).toMatchObject({
      accessToken: "",
      tokenExpiresAt: null,
      webhookSubscribed: false,
    });
    expect(update.data.disconnectedAt).toBeInstanceOf(Date);
    // Both writes go through together.
    expect(mockPrisma.$transaction).toHaveBeenCalledWith([
      "pause-campaigns",
      "mark-disconnected",
    ]);
    // Nothing is ever deleted on disconnect.
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.instagramAccount.delete).not.toHaveBeenCalled();
  });

  it("disconnects every connected account when no id is given", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "acct_1" },
      { id: "acct_2" },
    ]);

    await expect(disconnectInstagramAccounts("ws_1")).resolves.toBe(2);
    expect(mockPrisma.instagramAccount.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "ws_1",
      disconnectedAt: null,
    });
  });

  it("does nothing when the account is already disconnected", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([]);

    await expect(disconnectInstagramAccounts("ws_1", "acct_1")).resolves.toBe(0);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("removeInstagramAccountPermanently", () => {
  it("refuses a connected account", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({
      id: "acct_1",
      username: "brand",
      disconnectedAt: null,
    });

    await expect(
      removeInstagramAccountPermanently("ws_1", "acct_1", "brand")
    ).resolves.toEqual({ ok: false, reason: "still_connected" });
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses when the typed username does not match", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({
      id: "acct_1",
      username: "brand",
      disconnectedAt: new Date(),
    });

    await expect(
      removeInstagramAccountPermanently("ws_1", "acct_1", "other")
    ).resolves.toEqual({ ok: false, reason: "confirmation_mismatch" });
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes a disconnected account, accepting @ and any case", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({
      id: "acct_1",
      username: "Brand",
      disconnectedAt: new Date(),
    });
    mockPrisma.instagramAccount.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      removeInstagramAccountPermanently("ws_1", "acct_1", " @brand ")
    ).resolves.toEqual({ ok: true });
    // The delete itself re-checks "disconnected", so a reconnect that lands in
    // between is never deleted.
    expect(mockPrisma.instagramAccount.deleteMany).toHaveBeenCalledWith({
      where: { id: "acct_1", workspaceId: "ws_1", disconnectedAt: { not: null } },
    });
  });

  it("reports a reconnect that won the race as still connected", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({
      id: "acct_1",
      username: "brand",
      disconnectedAt: new Date(),
    });
    mockPrisma.instagramAccount.deleteMany.mockResolvedValue({ count: 0 });

    await expect(
      removeInstagramAccountPermanently("ws_1", "acct_1", "brand")
    ).resolves.toEqual({ ok: false, reason: "still_connected" });
  });

  it("does not reach into another workspace", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);

    await expect(
      removeInstagramAccountPermanently("ws_1", "acct_elsewhere", "brand")
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(mockPrisma.instagramAccount.findFirst.mock.calls[0][0].where).toEqual({
      id: "acct_elsewhere",
      workspaceId: "ws_1",
    });
  });
});

describe("POST /api/instagram/disconnect", () => {
  it("refuses members", async () => {
    mockContext.getCurrentWorkspaceContext.mockResolvedValue(context("MEMBER"));

    const response = await disconnect(
      request("POST", "/api/instagram/disconnect", { instagramAccountId: "acct_1" })
    );

    expect(response.status).toBe(403);
    expect(mockPrisma.instagramAccount.findMany).not.toHaveBeenCalled();
  });

  it("disconnects without deleting", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([{ id: "acct_1" }]);

    const response = await disconnect(
      request("POST", "/api/instagram/disconnect", { instagramAccountId: "acct_1" })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.disconnected).toBe(1);
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/instagram/accounts", () => {
  it("refuses members", async () => {
    mockContext.getCurrentWorkspaceContext.mockResolvedValue(context("MEMBER"));

    const response = await removeAccount(
      request("DELETE", "/api/instagram/accounts", {
        instagramAccountId: "acct_1",
        confirmUsername: "brand",
      })
    );

    expect(response.status).toBe(403);
  });

  it("requires the typed username", async () => {
    const response = await removeAccount(
      request("DELETE", "/api/instagram/accounts", { instagramAccountId: "acct_1" })
    );

    expect(response.status).toBe(400);
    expect(mockPrisma.instagramAccount.findFirst).not.toHaveBeenCalled();
  });

  it("maps a connected account to 409", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({
      id: "acct_1",
      username: "brand",
      disconnectedAt: null,
    });

    const response = await removeAccount(
      request("DELETE", "/api/instagram/accounts", {
        instagramAccountId: "acct_1",
        confirmUsername: "brand",
      })
    );

    expect(response.status).toBe(409);
  });

  it("removes a disconnected account", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({
      id: "acct_1",
      username: "brand",
      disconnectedAt: new Date(),
    });
    mockPrisma.instagramAccount.deleteMany.mockResolvedValue({ count: 1 });

    const response = await removeAccount(
      request("DELETE", "/api/instagram/accounts", {
        instagramAccountId: "acct_1",
        confirmUsername: "brand",
      })
    );

    expect(response.status).toBe(200);
  });
});
