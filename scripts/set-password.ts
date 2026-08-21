/**
 * Sets (or resets) a user's password from the command line.
 *
 *     npm run auth:set-password -- you@example.com
 *     npm run auth:set-password -- you@example.com --name "Your Name"
 *
 * This is how the first account on a deployment is created: sign-up through the
 * web app is invite-only, and an invitation can only be sent from inside an
 * existing workspace. It is also how an account left over from the magic-link
 * era gets a password — the web app deliberately refuses to do that, because
 * doing it unauthenticated would hand the account to anyone who knew the
 * address.
 */
import "@/lib/load-env";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;
const BCRYPT_COST = 12;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let name: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--name") {
      name = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }

  return { email: positional[0], name };
}

/**
 * Non-TTY stdin is drained once and handed out a line at a time. Asking readline
 * a second question does not work on a pipe: it streams lines as they arrive, so
 * the answer to the second prompt is emitted and dropped while the first is
 * still resolving, and the second prompt then waits forever on a closed stream.
 */
let pipedLines: string[] | null = null;

async function readPipedLine(): Promise<string> {
  if (pipedLines === null) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    // Split on LF and drop a trailing CR, rather than trimming: leading and
    // trailing spaces are legitimate characters in a password.
    pipedLines = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  }
  return pipedLines.shift() ?? "";
}

/**
 * Reads a line with the terminal echo turned off, so the password does not end
 * up on screen or in the shell history. Falls back to a normal visible prompt
 * when stdin is not a TTY (a pipe, or CI).
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (!input.isTTY) {
      output.write(question);
      readPipedLine().then(resolve, reject);
      return;
    }

    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    let value = "";

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          input.setRawMode(false);
          input.pause();
          input.removeListener("data", onData);
          output.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          input.setRawMode(false);
          input.pause();
          input.removeListener("data", onData);
          output.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };

    input.on("data", onData);
  });
}

async function main() {
  const { email: rawEmail, name } = parseArgs(process.argv.slice(2));

  if (!rawEmail) {
    console.error(
      'Usage: npm run auth:set-password -- <email> [--name "Full Name"]'
    );
    process.exitCode = 1;
    return;
  }

  const email = rawEmail.trim().toLowerCase();

  const password = await promptHidden(`Password for ${email}: `);
  const confirmation = await promptHidden("Confirm password: ");

  if (password !== confirmation) {
    console.error("Passwords do not match.");
    process.exitCode = 1;
    return;
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    );
    process.exitCode = 1;
    return;
  }

  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    // bcrypt hashes only the first 72 bytes, so anything longer would be
    // accepted here but not actually checked at login.
    console.error("Password is too long. Use at most 72 characters.");
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const existing = await prisma.user.findUnique({ where: { email } });

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          name: name ?? existing.name,
        },
      })
    : await prisma.user.create({
        data: {
          email,
          passwordHash,
          name: name ?? null,
          emailVerified: new Date(),
        },
      });

  const workspace = await ensureWorkspaceForUser(user.id, user.email);

  console.log(
    existing
      ? `Password updated for ${email} (workspace: ${workspace.name}).`
      : `User ${email} created (workspace: ${workspace.name}).`
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
