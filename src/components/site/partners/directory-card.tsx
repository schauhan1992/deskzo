import Link from "next/link";
import { ExternalLink, MapPin } from "lucide-react";
import { safeHref } from "@/components/site/links";
import { buttonClasses } from "@/components/site/ui";
import { COUNTRIES } from "@/lib/geo/countries";
import type { PublicPartner } from "@/lib/partners/registry";

/**
 * One listed partner on "Find a partner" (spec §10): its name, kind, countries, own description and
 * website — the five public facts (publicPartnerDirectory), nothing else. The way to reach it is
 * through us ("Ask us to introduce you"), so the page carries no email address: one typed into a
 * partner's own description is shown as removed.
 */

const KIND_LABELS: Record<PublicPartner["kind"], string> = { RESELLER: "Reseller", DISTRIBUTOR: "Distributor" };
const COUNTRY_NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));
const SHOWN_COUNTRIES = 6;
const EMAIL_LIKE = /[^\s@<>()[\]{}"',;:]+@[^\s@<>()[\]{}"',;:]+\.[^\s@<>()[\]{}"',;:]+/g;

/** Text a partner wrote, without anything that looks like an email address. */
export const withoutAddresses = (text: string) => text.replace(EMAIL_LIKE, "(address removed)");

/** "India, Nepal and 3 more" — names, by name. */
function countriesLine(codes: string[]): string {
  const names = codes
    .map((code) => COUNTRY_NAMES.get(code))
    .filter((name): name is string => !!name)
    .sort((a, b) => a.localeCompare(b));
  if (names.length <= SHOWN_COUNTRIES) return names.join(", ");
  return `${names.slice(0, SHOWN_COUNTRIES).join(", ")} and ${names.length - SHOWN_COUNTRIES} more`;
}

/** The partner's website as a link and the host shown for it — only an http(s) address. */
function websiteOf(raw: string | null): { href: string; host: string } | null {
  const href = safeHref(raw);
  if (!href || !/^https?:/i.test(href)) return null;
  try {
    return { href, host: new URL(href).hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

export function PartnerDirectoryCard({ partner }: { partner: PublicPartner }) {
  const name = withoutAddresses(partner.displayName);
  const blurb = partner.publicBlurb ? withoutAddresses(partner.publicBlurb) : null;
  const countries = countriesLine(partner.territories);
  const website = websiteOf(partner.website);
  return (
    <li className="flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">{name}</h2>
        <span className="shrink-0 rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-xs font-medium text-muted">{KIND_LABELS[partner.kind]}</span>
      </div>
      {countries && (
        <p className="mt-2 flex items-start gap-2 text-sm leading-6 text-muted">
          <MapPin aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-subtle" />
          <span>
            <span className="sr-only">Countries: </span>
            {countries}
          </span>
        </p>
      )}
      {blurb && <p className="mt-4 whitespace-pre-line text-sm leading-6 text-text">{blurb}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-3 pt-6">
        <Link href="/contact?topic=sales" aria-label={`Ask us to introduce you to ${name}`} className={buttonClasses("secondary")}>
          Ask us to introduce you
        </Link>
        {website && (
          <a href={website.href} rel="nofollow noopener" className="inline-flex min-w-0 items-center gap-1 text-sm font-medium text-brand hover:underline">
            <span className="truncate">{website.host}</span>
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </a>
        )}
      </div>
    </li>
  );
}
