import { db } from "@/lib/db";
import { leftAmong } from "@/lib/contacts/left";
import { canSend } from "@/lib/marketing/suppression";

/**
 * Who an invitation to one of Deskzo's own meetings may go to — the same hard stops as any mail sent for
 * the company (src/lib/documents/send-email.ts `recipientsFor`), asked of addresses rather than contacts,
 * since a meeting invites colleagues and typed addresses too:
 *
 *   · somebody at a reseller's customer — the reseller is who they hear from;
 *   · a contact who has left their company, when nobody still there has the address;
 *   · an address that bounced, or that marked the company's mail as spam (its own, its domain's, its
 *     contact's or its company's suppression) — never just an unsubscribe from offers.
 *
 * Colleagues are people here, not contacts: only a bounce or a complaint on their address stops them.
 */

export type InviteeVerdict = { email: string; ok: true } | { email: string; ok: false; left: boolean; detail: string };

const TRANSACTIONAL = { messageClass: "TRANSACTIONAL", channel: "EMAIL", topic: "SERVICE", limits: { maxPerContactPerWeek: 0, overdueDaysBlock: 0, requireVerifiedAddress: false } } as const;
const NO_SIGNALS = { unansweredFeedback: 0, daysOverdue: null, breachedTickets: 0, sentInLastWeek: 0 };

export async function screenInvitees(emails: string[], now = new Date()): Promise<InviteeVerdict[]> {
  const addresses = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!addresses.length) return [];
  const domains = [...new Set(addresses.map((a) => a.split("@")[1]).filter((d): d is string => !!d))];
  const [colleagues, contacts] = await Promise.all([
    db.user.findMany({ where: { email: { in: addresses, mode: "insensitive" } }, select: { email: true } }),
    db.contact.findMany({
      where: { email: { in: addresses, mode: "insensitive" } },
      take: 500,
      select: { id: true, name: true, email: true, phone: true, emailStatus: true, emailCheckedValue: true, companyId: true, company: { select: { name: true, managedByResellerId: true } } },
    }),
  ]);
  const [left, suppressions] = await Promise.all([
    leftAmong(contacts.map((c) => c.id)),
    db.suppression.findMany({
      where: {
        reason: { in: ["HARD_BOUNCE", "COMPLAINT"] },
        OR: [
          { scope: "EMAIL", value: { in: addresses } },
          { scope: "DOMAIN", value: { in: domains } },
          { scope: "CONTACT", value: { in: contacts.map((c) => c.id) } },
          { scope: "COMPANY", value: { in: [...new Set(contacts.map((c) => c.companyId))] } },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      select: { scope: true, value: true, reason: true },
    }),
  ]);
  const ours = new Set(colleagues.map((u) => u.email?.trim().toLowerCase()).filter(Boolean));

  return addresses.map((email): InviteeVerdict => {
    const domain = email.split("@")[1] ?? "";
    const colleague = ours.has(email);
    const theirs = colleague ? [] : contacts.filter((c) => c.email?.trim().toLowerCase() === email);
    const still = theirs.filter((c) => !left.has(c.id));
    if (theirs.length > 0 && still.length === 0) {
      const who = theirs[0]!;
      return { email, ok: false, left: true, detail: `${who.name} has left ${who.company.name}, so isn't invited.` };
    }
    const onAddress = suppressions.filter((s) => (s.scope === "EMAIL" && s.value === email) || (s.scope === "DOMAIN" && s.value === domain));
    // Each contact still there with this address must be one mail may go to — the address is theirs.
    const cases = still.length
      ? still.map((c) => ({
          company: { managedByResellerId: c.company.managedByResellerId },
          contact: { email, phone: c.phone, emailStatus: c.emailStatus, emailCheckedValue: c.emailCheckedValue },
          suppressions: [...onAddress, ...suppressions.filter((s) => (s.scope === "CONTACT" && s.value === c.id) || (s.scope === "COMPANY" && s.value === c.companyId))].map((s) => ({ reason: s.reason })),
        }))
      : [{ company: { managedByResellerId: null }, contact: { email, phone: null, emailStatus: "UNKNOWN", emailCheckedValue: null }, suppressions: onAddress.map((s) => ({ reason: s.reason })) }];
    for (const state of cases) {
      const verdict = canSend({ ...state, consent: null, signals: NO_SIGNALS }, TRANSACTIONAL);
      if (!verdict.ok) return { email, ok: false, left: false, detail: `${email} can't be invited: ${verdict.detail}` };
    }
    return { email, ok: true };
  });
}

/** The first refusal among these, in words — or null when everybody may be invited. */
export function refusalAmong(verdicts: InviteeVerdict[]): string | null {
  const refused = verdicts.find((v) => !v.ok);
  return refused && !refused.ok ? refused.detail : null;
}
