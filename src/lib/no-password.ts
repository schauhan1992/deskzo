import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";

/**
 * The stored password of a workspace account whose person hasn't chosen one yet — every account an admin
 * adds, HR converts or an import creates, until its setup link is used (src/lib/account-setup.ts).
 *
 * `User.passwordHash` is required, so the account holds a placeholder: a fixed prefix and 32 random bytes.
 * It is not a bcrypt hash and — the part that matters — it is not 60 characters, the only length
 * `bcrypt.compare` will compare against; for anything else it returns false without hashing. So nothing
 * typed anywhere matches it: not at sign-in (the credentials provider in src/lib/auth.ts, the login form's
 * `checkCredentials`), not as linked sign-in's re-authentication (src/lib/platform/linked/intents.ts), not as
 * the vault's or a project credential's password check — not even the placeholder itself. Linked sign-in's
 * credential stamp is an HMAC over the stored value like any other, and changes when the password is set.
 *
 * The prefix is how "Invitation pending" is asked of the database (`AWAITING_SETUP`), without reading any
 * stored value. Imports before this stored `no-password-set-by-import`, which counts too.
 *
 * Dependency-free on purpose: the importer and the access roster use it without the mailer.
 */

const NO_PASSWORD_PREFIX = "no-password-yet:";
/** What the user importer stored before every new account got a placeholder of its own. */
const IMPORTED_PLACEHOLDER = "no-password-set-by-import";

/** A fresh placeholder: 59 characters, so it can never match. */
export function noPasswordYet(): string {
  return `${NO_PASSWORD_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Accounts waiting for their person to choose a password. */
export const AWAITING_SETUP = {
  OR: [{ passwordHash: { startsWith: NO_PASSWORD_PREFIX } }, { passwordHash: IMPORTED_PLACEHOLDER }],
} satisfies Prisma.UserWhereInput;
