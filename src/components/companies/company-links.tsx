import { Globe } from "lucide-react";
import { OutboundLink, externalHref } from "@/components/ui/outbound-link";

/**
 * The company's website and LinkedIn, as two small icons — each opening in a new tab with no referrer
 * (OutboundLink), and naming where it goes on hover and to a screen reader.
 *
 * Shared by the company header, the lead header and the Domain & web panel so the pair reads identically
 * wherever it appears — and so a change to how a website URL is normalised only has to happen once.
 *
 * Renders nothing when neither is on file, rather than leaving an empty row behind.
 */
export function CompanyLinks({
  website,
  linkedinUrl,
  className,
}: {
  website: string | null | undefined;
  linkedinUrl: string | null | undefined;
  className?: string;
}) {
  const site = externalHref(website);
  const linkedin = externalHref(linkedinUrl);
  if (!site && !linkedin) return null;

  const icon =
    "inline-grid h-7 w-7 shrink-0 place-items-center rounded-base text-subtle transition-colors hover:bg-surface-sunken hover:text-brand";
  return (
    <div className={className ?? "mt-1 flex flex-wrap items-center gap-1"}>
      {site && (
        <OutboundLink href={site} className={icon} title={`Website — ${hostOf(site)} (opens in a new tab)`} aria-label={`Website, ${hostOf(site)}, opens in a new tab`}>
          <Globe className="h-4 w-4" aria-hidden />
        </OutboundLink>
      )}
      {linkedin && (
        <OutboundLink href={linkedin} className={icon} title="LinkedIn (opens in a new tab)" aria-label="LinkedIn, opens in a new tab">
          {/* lucide has no LinkedIn mark: its "in", in the current colour. */}
          <span aria-hidden className="grid h-4 w-4 place-items-center rounded-[3px] bg-current">
            <span className="text-[10px] font-bold leading-none text-surface">in</span>
          </span>
        </OutboundLink>
      )}
    </div>
  );
}

/** "acme.co.in" from "https://www.acme.co.in/about" — what the tooltip names. */
function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}
