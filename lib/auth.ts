import NextAuth, { type NextAuthConfig, CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { checkIpBlocked, recordFailedAttempt, recordSuccessfulAttempt } from "@/lib/ip-blocker";
import { getClientIp } from "@/lib/request-ip";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

/**
 * A valid bcrypt hash of a value nobody can supply, compared against whenever no
 * real hash is available. Returning early for an unknown email would make the
 * response measurably faster than for a known one, which turns the login form
 * into an oracle for which addresses have accounts.
 */
const DUMMY_PASSWORD_HASH =
  "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

class AuthFailedError extends CredentialsSignin {
  constructor(message: string) {
    super();
    this.code = message;
  }
}

export const authConfig = {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Senha", type: "password" },
      },
      async authorize(credentials, req) {
        const email = (credentials?.email as string)?.trim().toLowerCase();
        const password = credentials?.password as string;

        // Auth.js always hands authorize() a real Request, so the headers are
        // the only source for the address. It is deliberately not accepted as a
        // credential: a client-supplied IP is a client-controlled rate limit.
        const ip = getClientIp(req.headers);

        // 1. Check IP block status
        const ipCheck = await checkIpBlocked(ip);
        if (ipCheck.blocked) {
          throw new AuthFailedError(ipCheck.reason || "IP bloqueado por segurança.");
        }

        if (!email || !password) {
          await recordFailedAttempt(ip);
          throw new AuthFailedError("Email e senha são obrigatórios.");
        }

        const user = await prisma.user.findUnique({
          where: { email },
        });

        const isPasswordValid = await bcrypt.compare(
          password,
          user?.passwordHash ?? DUMMY_PASSWORD_HASH
        );

        if (!user || !user.passwordHash || !isPasswordValid) {
          const failStatus = await recordFailedAttempt(ip);
          throw new AuthFailedError(failStatus.reason || "Usuário ou senha incorretos.");
        }

        // Successful login: clear IP failed attempts
        await recordSuccessfulAttempt(ip);
        // Runs on every sign-in, not just the first one, because it also accepts
        // any workspace invitation waiting on this address (see
        // acceptPendingInvitationsForUser). An invite sent to an existing user
        // takes effect the next time they log in.
        await ensureWorkspaceForUser(user.id, user.email);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace.id;
}

