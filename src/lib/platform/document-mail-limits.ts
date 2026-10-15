import { controlConfigured } from "@/lib/platform/control-db";
import { getSetting, setSetting } from "@/lib/platform/settings";

/**
 * How much a workspace may send through Deskzo's own mail (owner, 15 Oct 2026): documents emailed on a
 * workspace's behalf when it has no mail of its own (src/lib/documents/mail-route.ts) go out from
 * Deskzo's address, so Deskzo's sending reputation carries them. Two daily limits, counted in
 * recipients — a document to three people is three — over the workspace's own day:
 *
 * - per sender: what one person may send through Deskzo in a day;
 * - per workspace: what all of its people may, together.
 *
 * Set by an owner in the console (Settings › Mail); 0 closes Deskzo's mail to documents altogether.
 * The workspace's own mail — each person's mailbox, or its mail server — has no limit from Deskzo.
 */

export type DocumentMailLimits = { personDaily: number; workspaceDaily: number };

export const DOCUMENT_MAIL_LIMIT_DEFAULTS: DocumentMailLimits = { personDaily: 25, workspaceDaily: 100 };
export const DOCUMENT_MAIL_LIMIT_MAX = 10_000;

function whole(raw: string | null, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return raw !== null && raw.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= DOCUMENT_MAIL_LIMIT_MAX ? n : fallback;
}

/** A minute's copy: every workspace reads the same two numbers, and a send shouldn't wait on the control plane. */
let cached: { at: number; limits: DocumentMailLimits } | null = null;
let testLimits: DocumentMailLimits | null = null;

/** Set only by check scripts. */
export function setTestDocumentMailLimits(limits: DocumentMailLimits | null) {
  testLimits = limits;
}

export async function documentMailLimits(): Promise<DocumentMailLimits> {
  if (testLimits) return testLimits;
  if (cached && Date.now() - cached.at < 60_000) return cached.limits;
  let limits = DOCUMENT_MAIL_LIMIT_DEFAULTS;
  if (controlConfigured()) {
    try {
      const [person, workspace] = await Promise.all([getSetting("mail.documents.personDaily"), getSetting("mail.documents.workspaceDaily")]);
      limits = { personDaily: whole(person, DOCUMENT_MAIL_LIMIT_DEFAULTS.personDaily), workspaceDaily: whole(workspace, DOCUMENT_MAIL_LIMIT_DEFAULTS.workspaceDaily) };
    } catch {
      // A control plane out of reach: the defaults, rather than no limit or no mail.
      limits = DOCUMENT_MAIL_LIMIT_DEFAULTS;
    }
  }
  cached = { at: Date.now(), limits };
  return limits;
}

/** The console's save. Out-of-range values are refused, not clamped: a typo shouldn't open the gates. */
export async function saveDocumentMailLimits(input: { personDaily: unknown; workspaceDaily: unknown }, by: string): Promise<DocumentMailLimits | string> {
  const read = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").trim()));
  const personDaily = read(input.personDaily);
  const workspaceDaily = read(input.workspaceDaily);
  for (const n of [personDaily, workspaceDaily]) {
    if (!Number.isInteger(n) || n < 0 || n > DOCUMENT_MAIL_LIMIT_MAX) return `Each limit is a whole number from 0 to ${DOCUMENT_MAIL_LIMIT_MAX.toLocaleString("en-IN")}.`;
  }
  if (personDaily > workspaceDaily) return "One person's limit can't be more than the whole workspace's.";
  await setSetting("mail.documents.personDaily", String(personDaily), by);
  await setSetting("mail.documents.workspaceDaily", String(workspaceDaily), by);
  cached = null;
  return { personDaily, workspaceDaily };
}
