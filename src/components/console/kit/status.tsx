import type { ReactNode } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { HELD_FOR, JOB_STATUS, ROLE_LABEL, TENANT_STATUS, schemaStatus, standingLabel } from "@/lib/console-shared/labels";
import type { ConsoleRole, StandingKind, TenantStatusKey, Tone } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";

/**
 * Status pills, dots and the tone classes behind them (spec §1.2–§1.3). Every label and tone comes
 * from src/lib/console-shared/labels.ts, so "Held" is the same amber pill in the directory, the
 * workspace header and a chart legend. Server-safe: no hooks, no directive.
 */

export const TONE_PILL: Record<Tone, string> = {
  neutral: "border-line bg-surface-sunken text-muted",
  success: "border-success/30 bg-success-bg text-success",
  info: "border-info/30 bg-info-bg text-info",
  warning: "border-warning/40 bg-warning-bg text-warning",
  danger: "border-danger/40 bg-danger-bg text-danger",
  brand: "border-transparent bg-brand-subtle text-brand",
};

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  danger: "text-danger",
  brand: "text-brand",
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-subtle",
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
  danger: "bg-danger",
  brand: "bg-brand",
};

export const TONE_BANNER: Record<Tone, string> = {
  neutral: "border-line bg-surface-sunken text-muted",
  success: "border-success/40 bg-success-bg text-success",
  info: "border-info/30 bg-info-bg text-info",
  warning: "border-warning/40 bg-warning-bg text-warning",
  danger: "border-danger/40 bg-danger-bg text-danger",
  brand: "border-line bg-brand-subtle text-brand",
};

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap";

export function StatusPill({
  tone,
  children,
  dot,
  title,
  icon,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  dot?: boolean;
  title?: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <span title={title} className={cn(PILL, TONE_PILL[tone], className)}>
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />}
      {icon && (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}

/**
 * A coloured dot whose meaning is read out, not only seen: the label is sr-only text and the hover
 * title, so a row of green and red dots is not a colour test.
 */
export function StatusDot({ tone, label, pulse }: { tone: Tone; label: string; pulse?: boolean }) {
  return (
    <span title={label} className="inline-flex shrink-0 items-center">
      <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", TONE_DOT[tone], pulse && "animate-pulse")} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * A pill straight from one of the label maps (`LabelPill map={INVOICE_STATUS} value={row.status}`).
 * A value the map does not know — a row written by a newer release — shows as itself rather than
 * crashing the page.
 */
export function LabelPill<K extends string>({ map, value }: { map: Record<K, { label: string; tone: Tone }>; value: K }) {
  const entry = Object.prototype.hasOwnProperty.call(map, value) ? map[value] : undefined;
  return <StatusPill tone={entry?.tone ?? "neutral"}>{entry?.label ?? String(value)}</StatusPill>;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A workspace's status. A hold says who placed it — staff and billing holds are lifted by different
 * people — as the pill's title always, and as a sub-line under it with `showHeldFor` (tables).
 */
export function TenantStatusPill({
  status,
  suspendedFor,
  showHeldFor,
}: {
  status: TenantStatusKey;
  suspendedFor?: "STAFF" | "BILLING" | null;
  showHeldFor?: boolean;
}) {
  const entry = TENANT_STATUS[status] ?? { label: String(status), tone: "neutral" as const };
  const held = status === "SUSPENDED" && suspendedFor ? HELD_FOR[suspendedFor] : null;
  const pill = (
    <StatusPill tone={entry.tone} title={held ? capitalise(held.label) : undefined}>
      {entry.label}
    </StatusPill>
  );
  if (!held || !showHeldFor) return pill;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      {pill}
      <span className={cn("text-[11px] leading-4", TONE_TEXT[held.tone])}>{held.label}</span>
    </span>
  );
}

/** Billing standing: "Trial · 5 days left", counted from the loader's `asOf`, never the reader's clock. */
export function StandingPill({ kind, at, asOf }: { kind: StandingKind; at: Date | string | null; asOf: Date | string }) {
  const { label, tone } = standingLabel(kind, at, asOf);
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

export function JobStatusPill({ status }: { status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" }) {
  const entry = JOB_STATUS[status] ?? { label: String(status), tone: "neutral" as const };
  return (
    <StatusPill tone={entry.tone} icon={status === "RUNNING" ? <LoaderCircle className="h-3 w-3 animate-spin" /> : undefined}>
      {entry.label}
    </StatusPill>
  );
}

/** "Up to date", "Behind 3" or "Unknown" — the raw migration name is in the title for whoever needs it. */
export function SchemaPill({ version, latest, behindBy }: { version: string | null; latest: string | null; behindBy: number | null }) {
  const s = schemaStatus(version, latest, behindBy);
  return (
    <StatusPill tone={s.tone} title={s.title ?? undefined} icon={s.tone === "success" ? <Check className="h-3 w-3" /> : undefined}>
      {s.label}
    </StatusPill>
  );
}

export function RolePill({ role }: { role: ConsoleRole }) {
  const entry = ROLE_LABEL[role] ?? { label: String(role), tone: "neutral" as const };
  return <StatusPill tone={entry.tone}>{entry.label}</StatusPill>;
}
