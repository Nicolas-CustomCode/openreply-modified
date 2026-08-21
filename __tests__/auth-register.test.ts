import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockIpBlocker, mockWorkspace } = vi.hoisted(() => ({
  mockPrisma: {
    workspaceInvitation: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn() },
  },
  mockIpBlocker: {
    checkIpBlocked: vi.fn(),
    recordFailedAttempt: vi.fn(),
  },
  mockWorkspace: {
    ensureWorkspaceForUser: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/ip-blocker", () => mockIpBlocker);
vi.mock("@/lib/workspace", () => mockWorkspace);

import { POST } from "../app/api/auth/register/route";

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://openreply.test/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const VALID = {
  email: "invited@example.com",
  password: "correct-horse-battery",
  name: "Invited User",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIpBlocker.checkIpBlocked.mockResolvedValue({ blocked: false });
  mockIpBlocker.recordFailedAttempt.mockResolvedValue({ blocked: false });
  mockWorkspace.ensureWorkspaceForUser.mockResolvedValue({ id: "ws_1" });
});

describe("POST /api/auth/register", () => {
  it("refuses an email with no pending invitation", async () => {
    mockPrisma.workspaceInvitation.findFirst.mockResolvedValue(null);

    const response = await POST(post(VALID));

    expect(response.status).toBe(403);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockIpBlocker.recordFailedAttempt).toHaveBeenCalled();
  });

  it("refuses to attach a password to an existing account", async () => {
    // The old route set a password on any account that had none, which handed
    // every magic-link-era user to whoever knew their address.
    mockPrisma.workspaceInvitation.findFirst.mockResolvedValue({ id: "inv_1" });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user_1" });

    const response = await POST(post(VALID));

    expect(response.status).toBe(409);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it("creates the account and joins the inviting workspace", async () => {
    mockPrisma.workspaceInvitation.findFirst.mockResolvedValue({ id: "inv_1" });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: "user_1",
      email: VALID.email,
    });

    const response = await POST(post(VALID));

    expect(response.status).toBe(200);
    const created = mockPrisma.user.create.mock.calls[0][0].data;
    expect(created.email).toBe(VALID.email);
    // Only the hash is ever stored.
    expect(created.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(created.passwordHash).not.toContain(VALID.password);
    expect(mockWorkspace.ensureWorkspaceForUser).toHaveBeenCalledWith(
      "user_1",
      VALID.email
    );
  });

  it("matches the invitation on a normalized email", async () => {
    mockPrisma.workspaceInvitation.findFirst.mockResolvedValue({ id: "inv_1" });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: "user_1",
      email: VALID.email,
    });

    await POST(post({ ...VALID, email: "  Invited@Example.COM  " }));

    expect(mockPrisma.workspaceInvitation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ email: "invited@example.com" }),
      })
    );
  });

  it("rejects a short password before looking anything up", async () => {
    const response = await POST(post({ ...VALID, password: "short" }));

    expect(response.status).toBe(400);
    expect(mockPrisma.workspaceInvitation.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a non-string password instead of throwing", async () => {
    // This used to reach password.length, throw, and return a 500 that echoed
    // the internal error message back to an unauthenticated caller.
    const response = await POST(post({ ...VALID, password: 12345678 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).not.toMatch(/length|undefined|prisma/i);
  });

  it("refuses while the IP is blocked, before touching the database", async () => {
    mockIpBlocker.checkIpBlocked.mockResolvedValue({
      blocked: true,
      reason: "IP bloqueado por segurança.",
    });

    const response = await POST(post(VALID));

    expect(response.status).toBe(429);
    expect(mockPrisma.workspaceInvitation.findFirst).not.toHaveBeenCalled();
  });

  it("does not leak internal detail when something breaks", async () => {
    mockPrisma.workspaceInvitation.findFirst.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:5432")
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const response = await POST(post(VALID));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).not.toContain("ECONNREFUSED");
    consoleError.mockRestore();
  });
});
