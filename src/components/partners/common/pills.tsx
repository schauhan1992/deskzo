import { StatusPill } from "@/components/console/kit/status";
import { ATTRIBUTION_SOURCE, COMMISSION_STATUS, DEAL_STATUS, PARTNER_KIND, PARTNER_STATUS, STATEMENT_STATUS } from "@/lib/console-shared/labels";
import type { Tone } from "@/lib/console-shared/types";
import {
  PARTNER_ROLE_LABELS,
  type AttributionSource,
  type CommissionStatus,
  type DealStatus,
  type PartnerKind,
  type PartnerRole,
  type PartnerStatus,
  type StatementStatus,
} from "@/lib/partners/types";
import { cn } from "@/lib/utils";

/**
 * The partner portal's pills, on top of the console's `StatusPill` and drawn from the same label and
 * tone maps the console uses (src/lib/console-shared/labels.ts) — so "Suspended" or "Approved — to
 * pay" reads the same to staff and to the partner. Every tone is paired with words, so none of them
 * is a colour test. A value a map does not know (written by a newer release) shows as itself.
 *
 * Server-safe: no hooks, no directive; client components import these freely too.
 */

type Label = { label: string; tone: Tone };

function entryOf<K extends string>(map: Record<K, Label>, value: K): Label {
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value] : { label: String(value), tone: "neutral" };
}

export function PartnerStatusPill({ status }: { status: PartnerStatus }) {
  const { label, tone } = entryOf(PARTNER_STATUS, status);
  return (
    <StatusPill tone={tone} dot>
      {label}
    </StatusPill>
  );
}

export function PartnerKindPill({ kind }: { kind: PartnerKind }) {
  const { label, tone } = entryOf(PARTNER_KIND, kind);
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

export function DealStatusPill({ status }: { status: DealStatus }) {
  const { label, tone } = entryOf(DEAL_STATUS, status);
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

export function CommissionStatusPill({ status }: { status: CommissionStatus }) {
  const { label, tone } = entryOf(COMMISSION_STATUS, status);
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

export function StatementStatusPill({ status }: { status: StatementStatus }) {
  const { label, tone } = entryOf(STATEMENT_STATUS, status);
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

/** How a customer came to be attributed ("Invitation code", "Referral link"…) — plain words, not a pill: it sits beside a date. */
export function SourceLabel({ source, className }: { source: AttributionSource; className?: string }) {
  return <span className={cn("text-muted", className)}>{entryOf(ATTRIBUTION_SOURCE, source).label}</span>;
}

export const PARTNER_ROLE_TONE: Record<PartnerRole, Tone> = { ADMIN: "brand", FINANCE: "info", SALES: "success", VIEWER: "neutral" };

/** A portal user's role. */
export function PartnerRolePill({ role }: { role: PartnerRole }) {
  return <StatusPill tone={PARTNER_ROLE_TONE[role] ?? "neutral"}>{PARTNER_ROLE_LABELS[role] ?? String(role)}</StatusPill>;
}
