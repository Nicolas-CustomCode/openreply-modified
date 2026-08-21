import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { checkIpBlocked, recordFailedAttempt } from "@/lib/ip-blocker";
import { getClientIp } from "@/lib/request-ip";
import { normalizeInvitationEmail } from "@/lib/workspace-invitations";
import { ensureWorkspaceForUser } from "@/lib/workspace";

export const MIN_PASSWORD_LENGTH = 8;
/**
 * bcrypt only hashes the first 72 bytes and silently drops the rest, so a
 * longer password would be accepted while quietly not being what is checked.
 */
const MAX_PASSWORD_BYTES = 72;

const BCRYPT_COST = 12;

const registerSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(MIN_PASSWORD_LENGTH),
});

/**
 * Registration is invite-only. Sign-up used to be open, and it also attached a
 * password to any pre-existing account that had none — which let anyone who
 * knew a magic-link user's address claim that account along with its workspaces
 * and connected Instagram profiles. Both paths are gone: the only way in is a
 * pending workspace invitation addressed to this exact email, and existing
 * users get their password set by an operator through
 * `npm run auth:set-password`.
 */
export async function POST(request: Request) {
  const ip = getClientIp(request.headers);

  try {
    const ipCheck = await checkIpBlocked(ip);
    if (ipCheck.blocked) {
      return NextResponse.json(
        { error: ipCheck.reason || "IP bloqueado por segurança." },
        { status: 429 }
      );
    }

    const parsed = registerSchema.safeParse(await request.json());

    if (!parsed.success) {
      await recordFailedAttempt(ip);
      return NextResponse.json(
        {
          error: `Informe um e-mail válido e uma senha de pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
        },
        { status: 400 }
      );
    }

    const { name, password } = parsed.data;
    const email = normalizeInvitationEmail(parsed.data.email);

    if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
      return NextResponse.json(
        { error: "A senha é longa demais. Use no máximo 72 caracteres." },
        { status: 400 }
      );
    }

    const invitation = await prisma.workspaceInvitation.findFirst({
      where: {
        email,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!invitation) {
      await recordFailedAttempt(ip);
      return NextResponse.json(
        {
          error:
            "O cadastro é apenas por convite. Peça ao dono do workspace que envie um convite para este e-mail.",
        },
        { status: 403 }
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      return NextResponse.json(
        {
          error:
            "Já existe uma conta com este e-mail. Entre com sua senha para aceitar o convite.",
        },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    const user = await prisma.user.create({
      data: {
        name: name || null,
        email,
        passwordHash,
        // The invitation was delivered to this address and the token came back,
        // so the address is as verified as an emailed link would make it.
        emailVerified: new Date(),
      },
    });

    // Turns the pending invitation into membership, so the new account lands
    // straight in the workspace that invited it.
    await ensureWorkspaceForUser(user.id, user.email);

    return NextResponse.json({
      success: true,
      message: "Conta criada com sucesso! Você já pode se conectar.",
    });
  } catch (error) {
    // Never echo the caught message back: it can carry Prisma and other
    // internal detail straight to an unauthenticated caller.
    console.error("[auth/register] registration failed", error);
    return NextResponse.json(
      { error: "Não foi possível concluir o cadastro. Tente novamente." },
      { status: 500 }
    );
  }
}
