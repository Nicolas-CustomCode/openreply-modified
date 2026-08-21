import { prisma } from "@/lib/db/client";
import { UNKNOWN_IP } from "@/lib/request-ip";

export const MAX_TEMPORARY_ATTEMPTS = 5;
export const MAX_PERMANENT_ATTEMPTS = 10;
export const TEMP_BLOCK_DURATION_MINUTES = 15;
/**
 * How long a failure keeps counting against an address. Without a window the
 * counter only ever falls on a successful login, so someone who has forgotten
 * their password can never get back under the threshold: once a temporary block
 * lapses their very next mistake is attempt six and re-blocks them on the spot.
 */
export const ATTEMPT_WINDOW_MINUTES = 15;

export interface IpBlockStatus {
  blocked: boolean;
  reason?: string;
  isPermanent?: boolean;
}

export async function checkIpBlocked(ip: string): Promise<IpBlockStatus> {
  if (!ip) return { blocked: false };

  const record = await prisma.ipBlock.findUnique({
    where: { ip },
  });

  if (!record) {
    return { blocked: false };
  }

  if (record.isPermanent) {
    return {
      blocked: true,
      isPermanent: true,
      reason:
        "IP bloqueado permanentemente por excesso de tentativas incorretas. Entre em contato com o administrador.",
    };
  }

  if (record.blockedUntil && record.blockedUntil > new Date()) {
    const minutesLeft = Math.ceil(
      (record.blockedUntil.getTime() - Date.now()) / (1000 * 60)
    );
    return {
      blocked: true,
      isPermanent: false,
      reason: `IP bloqueado temporariamente por excesso de tentativas incorretas. Tente novamente em ${minutesLeft} minuto(s).`,
    };
  }

  return { blocked: false };
}

export async function recordFailedAttempt(ip: string): Promise<IpBlockStatus> {
  if (!ip) return { blocked: false };

  const now = new Date();
  const windowStart = new Date(
    now.getTime() - ATTEMPT_WINDOW_MINUTES * 60 * 1000
  );

  const existing = await prisma.ipBlock.findUnique({ where: { ip } });
  const stale =
    existing !== null &&
    !existing.isPermanent &&
    existing.lastAttemptAt < windowStart;

  // The non-stale path increments in the database rather than writing back a
  // count read a moment ago, so simultaneous attempts cannot both read N and
  // both store N+1 — which would let an attacker buy extra tries by firing
  // requests in parallel.
  const record = await prisma.ipBlock.upsert({
    where: { ip },
    create: {
      ip,
      failedAttempts: 1,
      lastAttemptAt: now,
    },
    update: stale
      ? { failedAttempts: 1, blockedUntil: null, lastAttemptAt: now }
      : { failedAttempts: { increment: 1 }, lastAttemptAt: now },
  });

  const attempts = record.failedAttempts;

  if (record.isPermanent) {
    return {
      blocked: true,
      isPermanent: true,
      reason:
        "IP bloqueado permanentemente por atingir o limite de tentativas incorretas.",
    };
  }

  // UNKNOWN_IP is not one visitor — it is every request that arrived without
  // usable proxy headers, which on a self-hosted install behind no proxy is the
  // entire user base sharing one bucket. Banning it for good would brick the
  // deployment with nobody able to get in, so it only ever earns the temporary
  // tier no matter how high the count climbs.
  if (attempts >= MAX_PERMANENT_ATTEMPTS && ip !== UNKNOWN_IP) {
    await prisma.ipBlock.update({
      where: { ip },
      data: { isPermanent: true, blockedUntil: null },
    });
    return {
      blocked: true,
      isPermanent: true,
      reason:
        "IP bloqueado permanentemente por atingir o limite de tentativas incorretas.",
    };
  }

  if (attempts >= MAX_TEMPORARY_ATTEMPTS) {
    await prisma.ipBlock.update({
      where: { ip },
      data: {
        blockedUntil: new Date(
          now.getTime() + TEMP_BLOCK_DURATION_MINUTES * 60 * 1000
        ),
      },
    });
    return {
      blocked: true,
      isPermanent: false,
      reason: `Muitas tentativas incorretas. IP bloqueado temporariamente por ${TEMP_BLOCK_DURATION_MINUTES} minutos.`,
    };
  }

  const remaining = MAX_TEMPORARY_ATTEMPTS - attempts;
  return {
    blocked: false,
    reason: `Credenciais inválidas. Você tem mais ${remaining} tentativa(s) antes do bloqueio temporário.`,
  };
}

export async function recordSuccessfulAttempt(ip: string): Promise<void> {
  if (!ip) return;
  try {
    await prisma.ipBlock.delete({
      where: { ip },
    });
  } catch {
    // If no record existed, delete can fail silently
  }
}
