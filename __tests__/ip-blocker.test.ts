import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrismaIpBlock } = vi.hoisted(() => ({
  mockPrismaIpBlock: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    ipBlock: mockPrismaIpBlock,
  },
}));

import {
  checkIpBlocked,
  recordFailedAttempt,
  recordSuccessfulAttempt,
  MAX_TEMPORARY_ATTEMPTS,
  MAX_PERMANENT_ATTEMPTS,
  ATTEMPT_WINDOW_MINUTES,
} from "@/lib/ip-blocker";
import { UNKNOWN_IP } from "@/lib/request-ip";

function record(overrides: Record<string, unknown> = {}) {
  return {
    ip: "10.0.0.1",
    failedAttempts: 0,
    isPermanent: false,
    blockedUntil: null,
    lastAttemptAt: new Date(),
    ...overrides,
  };
}

describe("IP Blocker & Rate Limiter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaIpBlock.update.mockResolvedValue({});
  });

  describe("checkIpBlocked", () => {
    it("allows an unrecorded IP", async () => {
      mockPrismaIpBlock.findUnique.mockResolvedValue(null);
      expect((await checkIpBlocked("192.168.1.50")).blocked).toBe(false);
    });

    it("blocks when isPermanent is set", async () => {
      mockPrismaIpBlock.findUnique.mockResolvedValue(
        record({ failedAttempts: 10, isPermanent: true })
      );

      const result = await checkIpBlocked("192.168.1.50");
      expect(result.blocked).toBe(true);
      expect(result.isPermanent).toBe(true);
      expect(result.reason).toContain("permanentemente");
    });

    it("blocks while blockedUntil is in the future", async () => {
      mockPrismaIpBlock.findUnique.mockResolvedValue(
        record({
          failedAttempts: 5,
          blockedUntil: new Date(Date.now() + 10 * 60 * 1000),
        })
      );

      const result = await checkIpBlocked("192.168.1.50");
      expect(result.blocked).toBe(true);
      expect(result.isPermanent).toBe(false);
      expect(result.reason).toContain("temporariamente");
    });

    it("allows again once blockedUntil has passed", async () => {
      mockPrismaIpBlock.findUnique.mockResolvedValue(
        record({
          failedAttempts: 5,
          blockedUntil: new Date(Date.now() - 60 * 1000),
        })
      );

      expect((await checkIpBlocked("192.168.1.50")).blocked).toBe(false);
    });
  });

  describe("recordFailedAttempt", () => {
    it("counts up atomically while under the threshold", async () => {
      mockPrismaIpBlock.findUnique.mockResolvedValue(
        record({ failedAttempts: 1 })
      );
      mockPrismaIpBlock.upsert.mockResolvedValue(record({ failedAttempts: 2 }));

      const result = await recordFailedAttempt("10.0.0.1");

      // The counter is incremented by the database, never written back from a
      // value read a moment earlier.
      expect(mockPrismaIpBlock.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            failedAttempts: { increment: 1 },
          }),
        })
      );
      expect(result.blocked).toBe(false);
      expect(result.reason).toContain(
        `${MAX_TEMPORARY_ATTEMPTS - 2} tentativa(s)`
      );
    });

    it("triggers a temporary block at the temporary threshold", async () => {
      mockPrismaIpBlock.findUnique.mockResolvedValue(
        record({ failedAttempts: 4 })
      );
      mockPrismaIpBlock.upsert.mockResolvedValue(
        record({ failedAttempts: MAX_TEMPORARY_ATTEMPTS })
      );

      const result = await recordFailedAttempt("10.0.0.1");

      expect(mockPrismaIpBlock.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ip: "10.0.0.1" },
          data: { blockedUntil: expect.any(Date) },
        })
      );
      expect(result.blocked).toBe(true);
      expect(result.isPermanent).toBe(false);
      expect(result.reason).toContain("temporariamente");
    });

    it("triggers a permanent block at the permanent threshold", async () => {
      mockPrismaIpBlock.findUnique.mockResolvedValue(
        record({ failedAttempts: 9 })
      );
      mockPrismaIpBlock.upsert.mockResolvedValue(
        record({ failedAttempts: MAX_PERMANENT_ATTEMPTS })
      );

      const result = await recordFailedAttempt("10.0.0.1");

      expect(mockPrismaIpBlock.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ip: "10.0.0.1" },
          data: { isPermanent: true, blockedUntil: null },
        })
      );
      expect(result.blocked).toBe(true);
      expect(result.isPermanent).toBe(true);
      expect(result.reason).toContain("permanentemente");
    });

    it("retires failures older than the attempt window", async () => {
      // Nine old failures plus one fresh mistake must not equal a ban: without a
      // decay window, a user who forgot their password could never recover.
      const stale = new Date(
        Date.now() - (ATTEMPT_WINDOW_MINUTES + 5) * 60 * 1000
      );
      mockPrismaIpBlock.findUnique.mockResolvedValue(
        record({ failedAttempts: 9, lastAttemptAt: stale })
      );
      mockPrismaIpBlock.upsert.mockResolvedValue(record({ failedAttempts: 1 }));

      const result = await recordFailedAttempt("10.0.0.1");

      expect(mockPrismaIpBlock.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            failedAttempts: 1,
            blockedUntil: null,
          }),
        })
      );
      expect(result.blocked).toBe(false);
    });

    it("keeps counting failures inside the attempt window", async () => {
      const recent = new Date(
        Date.now() - (ATTEMPT_WINDOW_MINUTES - 5) * 60 * 1000
      );
      mockPrismaIpBlock.findUnique.mockResolvedValue(
        record({ failedAttempts: 2, lastAttemptAt: recent })
      );
      mockPrismaIpBlock.upsert.mockResolvedValue(record({ failedAttempts: 3 }));

      await recordFailedAttempt("10.0.0.1");

      expect(mockPrismaIpBlock.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            failedAttempts: { increment: 1 },
          }),
        })
      );
    });

    it("never permanently blocks the unknown-IP bucket", async () => {
      // UNKNOWN_IP is every proxy-header-less request at once. A permanent ban
      // there would lock a self-hosted install out of itself.
      mockPrismaIpBlock.findUnique.mockResolvedValue(
        record({ ip: UNKNOWN_IP, failedAttempts: 20 })
      );
      mockPrismaIpBlock.upsert.mockResolvedValue(
        record({ ip: UNKNOWN_IP, failedAttempts: 21 })
      );

      const result = await recordFailedAttempt(UNKNOWN_IP);

      expect(result.isPermanent).toBeFalsy();
      expect(result.blocked).toBe(true);
      expect(mockPrismaIpBlock.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { blockedUntil: expect.any(Date) },
        })
      );
    });

    it("leaves an already permanent block alone", async () => {
      mockPrismaIpBlock.findUnique.mockResolvedValue(
        record({ failedAttempts: 12, isPermanent: true })
      );
      mockPrismaIpBlock.upsert.mockResolvedValue(
        record({ failedAttempts: 13, isPermanent: true })
      );

      const result = await recordFailedAttempt("10.0.0.1");

      expect(result.isPermanent).toBe(true);
      expect(mockPrismaIpBlock.update).not.toHaveBeenCalled();
    });
  });

  it("clears the IP record on a successful attempt", async () => {
    mockPrismaIpBlock.delete.mockResolvedValue({});

    await recordSuccessfulAttempt("10.0.0.1");

    expect(mockPrismaIpBlock.delete).toHaveBeenCalledWith({
      where: { ip: "10.0.0.1" },
    });
  });
});
