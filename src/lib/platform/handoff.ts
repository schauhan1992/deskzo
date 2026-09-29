import { createHash, randomBytes } from "node:crypto";
import { controlDb } from "@/lib/platform/control-db";
import { AUTOMATION_EMAIL } from "@/lib/people";

/**
 * A one-time pass that signs somebody into a workspace without their password — the owner straight
 * after signing up (so the first thing they see is their workspace, not a login form), and later
 * support staff with a grant.
 *
 * Sixty seconds, once, for one workspace and one address. Only its SHA-256 is stored; the pass itself
 * travels once, in the redirect to the workspace's /handoff page, where the "handoff" sign-in
 * (src/lib/auth.ts) spends it. A pass for one workspace is nothing at another: it is spent against
 * the workspace the request is on.
 */

export type HandoffPurpose = "owner-signup" | "support";

const TTL_MS = 60_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createHandoffTicket(tenantId: string, email: string, purpose: HandoffPurpose): Promise<string> {
  // Nobody is ever handed in as a workspace's Automation account (src/lib/automation-user.ts).
  if (email.trim().toLowerCase() === AUTOMATION_EMAIL) throw new Error("There is no pass for the Automation account.");
  const token = randomBytes(32).toString("base64url");
  await controlDb().platformHandoffTicket.create({
    data: { tokenHash: hash(token), tenantId, email: email.trim().toLowerCase(), purpose, expiresAt: new Date(Date.now() + TTL_MS) },
  });
  return token;
}

/** Spends a pass for this workspace: the address it signs in, or null for anything else. Once. */
export async function spendHandoffTicket(token: string, tenantId: string): Promise<{ email: string; purpose: HandoffPurpose } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = hash(token);
  const spent = await controlDb().platformHandoffTicket.updateMany({
    where: { tokenHash, tenantId, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (spent.count !== 1) return null;
  const row = await controlDb().platformHandoffTicket.findUnique({ where: { tokenHash }, select: { email: true, purpose: true } });
  return row ? { email: row.email, purpose: row.purpose as HandoffPurpose } : null;
}
