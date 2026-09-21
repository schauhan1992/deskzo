import { ExternalLink, Users } from "lucide-react";
import { OutboundLink, externalHref } from "@/components/ui/outbound-link";

/**
 * The company's website and LinkedIn, as two small outbound links.
 *
 * Shared by the company header and the Domain & web panel so the pair reads identically wherever
 * it appears — and so a change to how a website URL is normalised only has to happen once.
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

  return (
    <div className={className ?? "mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"}>
      {site && (
        <OutboundLink href={site} className="flex items-center gap-1 text-brand hover:underline">
          <ExternalLink className="h-3 w-3" />
          Visit
        </OutboundLink>
      )}
      {linkedin && (
        <OutboundLink href={linkedin} className="flex items-center gap-1 text-brand hover:underline">
          <Users className="h-3 w-3" />
          LinkedIn
        </OutboundLink>
      )}
    </div>
  );
}

