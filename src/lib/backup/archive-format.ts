/**
 * The parts of the archive format a browser is allowed to know.
 *
 * `archive.ts` does the sealing, and to do it, it imports `node:crypto`, `node:fs` and
 * `node:stream`. The download dialog and the restore panel are client components: they need the
 * file extension to put in an `accept=`, and the minimum passphrase length to validate a field
 * before anybody presses anything. Importing those two constants from `archive.ts` drags the whole
 * Node surface into the browser bundle, and Turbopack refuses to build the page at all —
 *
 *     the chunking context (unknown) does not support external modules (request: node:fs)
 *
 * which is a clear error in an unclear place: it names the *page*, not the import that caused it.
 *
 * Same split, and same reason, as `fingerprint.ts` being kept out of `policy.ts`. Nothing in this
 * file may import from `node:` anything, ever, or a settings page somebody else is working on stops
 * building for a reason that has nothing to do with them.
 */

export const ARCHIVE_EXTENSION = ".wbak";

/** The shortest passphrase an archive will be sealed under. Short enough to type, long enough to be worth it. */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Typed, not clicked, to start a restore. A checkbox is muscle memory; this is not. */
export const CONFIRM_PHRASE = "REPLACE EVERYTHING";

/**
 * Whether a passphrase is one the archive writer will accept.
 *
 * Length only. A composition rule ("one number, one symbol") pushes people towards `Passw0rd!` and
 * away from four words, which is the wrong direction for a secret that is typed twice a year and
 * written down in between.
 *
 * Shared rather than duplicated: the form uses it to grey out a button, and the route uses it to
 * refuse. Two copies of a rule like this drift, and the drift shows up as a form that lets somebody
 * submit something the server then rejects.
 */
export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.normalize("NFKC").length < MIN_PASSPHRASE_LENGTH) {
    return `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters. Use a few words rather than one hard-to-type word.`;
  }
  return null;
}
