/**
 * The platform console's cross-layer types — what loaders return, what pages pass down and what client
 * components receive. Pure types only: a client component imports this file without pulling the
 * control plane into its bundle (src/lib/console-shared is outside src/lib/platform on purpose).
 *
 * The string unions mirror the control plane's enums (`@deskzo/control-client`) so a Prisma row can be
 * handed straight to a client component; `ConsoleRole` is `StaffRole` spelled out, and tsc proves they
 * stay the same wherever one is passed as the other (src/lib/platform/console-page.ts).
 */

export type ConsoleRole = "OWNER" | "ADMIN" | "SUPPORT" | "BILLING" | "READONLY";

/** One tone everywhere: pills, dots, banners, badges and chart marks (spec §1.2). */
export type Tone = "neutral" | "success" | "info" | "warning" | "danger" | "brand";

export type TenantStatusKey = "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "MIGRATING" | "DEPROVISIONED";

/** `Standing["kind"]` of src/lib/billing/lifecycle.ts. */
export type StandingKind = "exempt" | "paid" | "trial" | "trial-over" | "past-due" | "ending" | "lapsed" | "none";

export type GatewayKey = "MANUAL" | "STRIPE" | "RAZORPAY";

/** Which kind of key a gateway holds — worked out from its prefix on the server; null when none is set. */
export type GatewayMode = "test" | "live" | "unknown" | null;
export type GatewayModes = { stripe: GatewayMode; razorpay: GatewayMode };

export type SubscriptionStatusKey = "INCOMPLETE" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELLED";
export type InvoiceStatusKey = "DRAFT" | "OPEN" | "PAID" | "VOID" | "UNCOLLECTIBLE";
export type PlanKindKey = "EDITION" | "BUNDLE" | "ADDON" | "INTERNAL";

export type AuditCategoryKey = "lifecycle" | "billing" | "staff" | "support" | "setup" | "reference" | "invites" | "names" | "partners" | "notes" | "terminals" | "console";

/** One audit row as the console shows it — built by `toActivityItems` (src/lib/platform/console-guard.ts). */
export type ActivityItem = {
  id: string;
  at: Date;
  /** Past tense, never one of the phrases kept for the roles that may act ("Workspace held"). */
  title: string;
  /** The raw action key, shown small and monospace beside the title. */
  code: string;
  tone: Tone;
  category: AuditCategoryKey | null;
  /** A key-value one-liner, redacted; null when there is nothing useful to say. */
  detail: string | null;
  actor: string;
  actorKind: "STAFF" | "SCRIPT" | "SYSTEM";
  workspace: { slug: string } | null;
  href: string | null;
};

export type BulkItemResult = { tenantId: string; slug: string; ok: boolean; skipped?: boolean; outcome?: string; error?: string };
export type BulkResult = { batchId: string; ok: number; failed: number; skipped: number; items: BulkItemResult[] };

/** CSV text built on the server and downloaded by the browser — no API route involved. */
export type CsvExport = { filename: string; csv: string; rows: number };

export type PlatformEnv = {
  key: "production" | "staging" | "development";
  label: "Production" | "Staging" | "Development";
  tone: "danger" | "warning" | "info";
  /** "" in production, "[staging] " / "[development] " otherwise — the browser tab's title prefix. */
  titlePrefix: string;
};

export type NavBadgeKey = "alerts" | "support" | "trials" | "signups" | "partners" | "announcements" | "billing" | "commissions" | "health" | "provisioning" | "migrations" | "reference";
export type NavBadge = {
  /** null draws a dot instead of a number. */
  count: number | null;
  tone: "danger" | "warning" | "info" | "muted";
  /** Read out after the link's name, e.g. "2 failed setups". */
  label: string;
  pulse?: boolean;
};
export type NavCounts = { asOf: string /* ISO */; alertsOpen: number; badges: Partial<Record<NavBadgeKey, NavBadge>> };

export type SearchKind = "workspace" | "domain" | "subscription" | "invoice" | "terminal" | "staff" | "partner" | "plan" | "invite" | "signup";
export type SearchHit = { kind: SearchKind; key: string; title: string; subtitle: string; href: string };
export type SearchResults = { q: string; groups: { kind: SearchKind; label: string; hits: SearchHit[] }[] };

/** A module of the catalogue as the console shows it (plan editor, overrides dialog). */
export type CatalogueModuleView = { key: string; label: string; countries: readonly string[] | null; inEveryPlan: boolean; requires: readonly string[] };
