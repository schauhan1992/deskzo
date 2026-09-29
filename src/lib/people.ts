import type { Prisma } from "@prisma/client";

/**
 * The workspace's people, as opposed to the two kinds of account that are nobody's:
 *
 *   · the platform's support accounts (User.kind SUPPORT, src/lib/platform/support.ts), there while
 *     the workspace's super admin allows it;
 *   · the workspace's own Automation account (User.kind AUTOMATION, src/lib/automation-user.ts), which
 *     automatic journal postings are made by.
 *
 * Neither is a seat, and neither is listed, counted or picked anywhere. `db` already leaves them out of
 * every user listing that doesn't name `id` or `kind` itself (src/lib/db.ts). `PEOPLE_ONLY` is for the
 * queries it can't reach: one that names `id` (`id: { not: me }`, `id: { in: ids }`) or `kind`, one
 * inside a transaction (`tx.user…`), and one on a script's own client.
 *
 * Dependency-free on purpose: client components and the importer use it without the database.
 */
export const PEOPLE_ONLY = { kind: "MEMBER" } as const satisfies Prisma.UserWhereInput;

/** The Automation account's address: `.invalid` can never be delivered to, or be anybody's (RFC 2606). */
export const AUTOMATION_EMAIL = "automation@system.invalid";
export const AUTOMATION_NAME = "Automation";
/** What an entry made by the Automation account shows where a person's name would be. */
export const POSTED_AUTOMATICALLY = "Posted automatically";

/** The Automation account, by its kind. Every way in refuses it by this, not only by its placeholder password. */
export function isAutomationKind(kind: string | null | undefined): boolean {
  return kind === "AUTOMATION";
}

/**
 * An address that belongs to no person: platform support's (`support.<staff>@platform.invalid`) or the
 * Automation account's. Nothing is ever mailed to one, linked to one or made with one.
 */
export function isSystemAddress(email: string): boolean {
  const address = email.trim().toLowerCase();
  return address.endsWith("@platform.invalid") || address.endsWith("@system.invalid");
}

/** Who made an entry, as a line under it: "Posted automatically" for the Automation account, "by <name>" for a person. */
export function authorLabel(user: { name: string; kind?: string | null } | null | undefined): string | null {
  if (!user) return null;
  return isAutomationKind(user.kind) ? POSTED_AUTOMATICALLY : `by ${user.name}`;
}
