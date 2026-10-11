import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { workspaceClock } from "@/lib/time/workspace";
import { liveCardWhere } from "@/lib/cards/holder";

/**
 * Telling cardholders their card changed. A template change reaches every card drawn from it the moment
 * it is saved — the address and the person's own details stay, but the look, what it shows or its links
 * may not — so each live cardholder is told what changed, in words, and where to see it (My card).
 */

/** The parts of a template a cardholder can see the effect of. Its name isn't one: nobody sees it. */
export type CardLook = {
  color: string;
  layout: string;
  showLogo: boolean;
  recordFields: unknown;
  sharedFields: unknown;
  allowOwnFields: boolean;
  shareBack: boolean;
  questions: unknown;
};

/** What changed between two versions of a template, as a cardholder would say it — nothing for a new name alone. */
export function cardChanges(before: CardLook, after: CardLook): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: string[] = [];
  if (before.color !== after.color || before.layout !== after.layout || before.showLogo !== after.showLogo) out.push("its look");
  if (!same(before.recordFields, after.recordFields)) out.push("what it shows from your record");
  if (!same(before.sharedFields, after.sharedFields)) out.push("the company's links on it");
  if (before.allowOwnFields !== after.allowOwnFields) out.push(after.allowOwnFields ? "you can now add your own links" : "your own links are no longer shown");
  if (before.shareBack !== after.shareBack || !same(before.questions, after.questions)) out.push("what people are asked when they share their details back");
  return out;
}

/** A manager saving a template several times in a row is one change to the people holding it. */
const QUIET_MS = 30 * 60_000;

/**
 * Each live cardholder on the template told, once in half an hour at most — not whoever made the change.
 * How many were told.
 */
export async function tellCardholders(templateId: string, changes: string[], actorId: string, now = Date.now()): Promise<number> {
  if (!changes.length) return 0;
  const today = (await workspaceClock()).today(new Date(now));
  const holders = await db.digitalCard.findMany({ where: { AND: [{ templateId }, liveCardWhere(today)] }, select: { userId: true } });
  const ids = holders.map((h) => h.userId).filter((id) => id !== actorId);
  if (!ids.length) return 0;
  const recent = new Set(
    (await db.notification.findMany({ where: { type: "CARD_CHANGED", userId: { in: ids }, createdAt: { gte: new Date(now - QUIET_MS) } }, select: { userId: true } })).map((n) => n.userId),
  );
  const said = changes.join("; ");
  const message = `What changed: ${said.charAt(0).toUpperCase()}${said.slice(1)}. Your card's address and your own details stay as they were.`;
  let told = 0;
  for (const userId of ids) {
    if (recent.has(userId)) continue;
    if (await notifyUser({ userId, type: "CARD_CHANGED", title: "Your digital card changed", message, link: "/cards" })) told += 1;
  }
  return told;
}
