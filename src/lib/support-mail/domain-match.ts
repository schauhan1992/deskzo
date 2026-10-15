import { db } from "@/lib/db";
import { isFreeMailbox } from "@/lib/email-verification";
import { PEOPLE_ONLY } from "@/lib/people";
import { inboundDomain } from "@/lib/support-mail/config";

/**
 * Which company an email belongs to by its sender's domain (owner, 15 Oct 2026): aman@wroffy.com writes
 * to support, isn't a contact yet, but sachin@wroffy.com is one at Wroffy — so the ticket is Wroffy's.
 *
 * Only the domains a company's contacts actually use count (not its website), and exactly that domain
 * (in.wroffy.com is not wroffy.com). A domain never says whose an email is when anybody can have an
 * address there — Gmail, Outlook and the rest (`isFreeMailbox`) — nor when it is the workspace's own
 * people's, nor the helpdesk's. Contacts who have left still show whose a domain is: a person leaves, the
 * domain stays the company's.
 *
 * Inside the workspace, like everything here: a workspace has a database of its own, so one workspace's
 * contacts are never asked about another's mail.
 */

/** An address's domain, lower-cased; null for anything that isn't an address. */
export function emailDomain(address: string | null | undefined): string | null {
  const value = (address ?? "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 1) return null;
  const domain = value.slice(at + 1).replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain) ? domain : null;
}

/** The domains the workspace's own people write from — mail from them is never a customer's. */
async function ownDomains(): Promise<Set<string>> {
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { email: true } });
  const out = new Set(people.map((p) => emailDomain(p.email)).filter((d): d is string => !!d));
  const helpdesk = inboundDomain();
  if (helpdesk) out.add(helpdesk.toLowerCase());
  return out;
}

export type DomainCompany = { id: string; name: string };

/**
 * For each address, the companies whose contacts use its domain — or null where its domain can't say
 * (free mail, the workspace's own, not an address). One query for all of them, for the Support inbox.
 */
export async function companiesByDomain(addresses: string[]): Promise<Map<string, { domain: string; companies: DomainCompany[] } | null>> {
  const out = new Map<string, { domain: string; companies: DomainCompany[] } | null>();
  const own = await ownDomains();
  const byAddress = new Map<string, string | null>();
  for (const address of addresses) {
    const domain = emailDomain(address);
    byAddress.set(address, domain && !isFreeMailbox(domain) && !own.has(domain) ? domain : null);
  }
  const domains = [...new Set([...byAddress.values()].filter((d): d is string => !!d))];
  const rows = domains.length
    ? await db.contact.findMany({
        where: { OR: domains.map((d) => ({ email: { endsWith: `@${d}`, mode: "insensitive" as const } })) },
        select: { email: true, company: { select: { id: true, name: true } } },
      })
    : [];
  const companiesOf = new Map<string, Map<string, DomainCompany>>();
  for (const row of rows) {
    const domain = emailDomain(row.email);
    if (!domain || !domains.includes(domain)) continue;
    const found = companiesOf.get(domain) ?? new Map<string, DomainCompany>();
    found.set(row.company.id, row.company);
    companiesOf.set(domain, found);
  }
  for (const [address, domain] of byAddress) {
    out.set(address, domain ? { domain, companies: [...(companiesOf.get(domain)?.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name)) } : null);
  }
  return out;
}

/** The same for one address. */
export async function companiesForSenderDomain(address: string): Promise<{ domain: string; companies: DomainCompany[] } | null> {
  return (await companiesByDomain([address])).get(address) ?? null;
}
