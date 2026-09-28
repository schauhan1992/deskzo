import { CircleDashed, Clock, Radio } from "lucide-react";
import { StatusPill } from "@/components/console/kit/status";
import type { Tone } from "@/lib/console-shared/types";
import { CMS_ROLE_LABELS, LEAD_STATUS_LABELS, type CmsRole, type PageStatus, type SiteLeadStatus, type SitePostStatus } from "@/lib/cms/types";

/**
 * The CMS's pills — a role, a page's or a post's state, a lead's status, and whether something is
 * live — on top of the console's `StatusPill`, so the two apps speak one visual language. Every tone
 * is paired with words (and, for the states that matter most, an icon), so none of them is a colour
 * test. Server-safe: no hooks, no directive.
 */

export const CMS_ROLE_TONE: Record<CmsRole, Tone> = { ADMIN: "brand", EDITOR: "info", AUTHOR: "success", VIEWER: "neutral" };

export function CmsRolePill({ role }: { role: CmsRole }) {
  return <StatusPill tone={CMS_ROLE_TONE[role] ?? "neutral"}>{CMS_ROLE_LABELS[role] ?? String(role)}</StatusPill>;
}

const PAGE_STATUS: Record<PageStatus, { label: string; tone: Tone; title: string }> = {
  DEFAULT: { label: "Default content", tone: "neutral", title: "Nobody has edited this page yet — the site shows its built-in content." },
  DRAFT: { label: "Draft", tone: "warning", title: "Not on the site yet." },
  PUBLISHED: { label: "Published", tone: "success", title: "On the site." },
};

/**
 * A page's state. `changed`: published, with a draft that differs — the site still shows the
 * published copy. `archived` wins over everything: an archived page is off the site.
 */
export function PageStatusPill({ status, changed, archived }: { status: PageStatus; changed?: boolean; archived?: boolean }) {
  if (archived) return <StatusPill tone="neutral" title="Off the site; restore it to edit again.">Archived</StatusPill>;
  const entry = PAGE_STATUS[status] ?? { label: String(status), tone: "neutral" as const, title: "" };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusPill tone={entry.tone} dot title={entry.title}>
        {entry.label}
      </StatusPill>
      {changed && status === "PUBLISHED" && (
        <StatusPill tone="info" icon={<CircleDashed className="h-3 w-3" />} title="The draft has changes the site does not show yet.">
          Changed since publish
        </StatusPill>
      )}
    </span>
  );
}

/** A post's state. A SCHEDULED post whose time has come is `live` — it reads as published. */
export function PostStatusPill({ status, live, archived }: { status: SitePostStatus; live?: boolean; archived?: boolean }) {
  if (archived) return <StatusPill tone="neutral">Archived</StatusPill>;
  if (status === "PUBLISHED" || (status === "SCHEDULED" && live)) {
    return (
      <StatusPill tone="success" dot title="On the site.">
        Published
      </StatusPill>
    );
  }
  if (status === "SCHEDULED") {
    return (
      <StatusPill tone="info" icon={<Clock className="h-3 w-3" />} title="Goes live at its scheduled time.">
        Scheduled
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="warning" dot title="Not on the site yet.">
      Draft
    </StatusPill>
  );
}

export const LEAD_STATUS_TONE: Record<SiteLeadStatus, Tone> = { NEW: "brand", CONTACTED: "info", QUALIFIED: "success", CLOSED: "neutral", SPAM: "danger" };

export function LeadStatusPill({ status }: { status: SiteLeadStatus }) {
  return (
    <StatusPill tone={LEAD_STATUS_TONE[status] ?? "neutral"} dot={status === "NEW"}>
      {LEAD_STATUS_LABELS[status] ?? String(status)}
    </StatusPill>
  );
}

/**
 * Whether what is being edited is what the site shows: "Live", or "Draft — not live" while the draft
 * holds changes nobody has published yet.
 */
export function LiveStatePill({ live }: { live: boolean }) {
  return live ? (
    <StatusPill tone="success" icon={<Radio className="h-3 w-3" />} title="The site shows exactly this.">
      Live
    </StatusPill>
  ) : (
    <StatusPill tone="warning" icon={<CircleDashed className="h-3 w-3" />} title="Saved, but the site does not show it until it is published.">
      Draft — not live
    </StatusPill>
  );
}
