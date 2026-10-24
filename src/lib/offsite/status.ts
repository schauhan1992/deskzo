import type { OffsiteRunKind, OffsiteRunStatus } from "@deskzo/control-client";
import { accessLogDir, accessLogEnabled } from "@/lib/logs/access-log";
import { pendingRequest, type ChoreRequest } from "@/lib/offsite/chores";
import { offsiteSetup, type OffsiteSetup } from "@/lib/offsite/config";
import { openStore, type StoreConfig } from "@/lib/offsite/store";
import { controlDb } from "@/lib/platform/control-db";
import { lastClockCheck, type ClockCheck } from "@/lib/platform/time-sync";

/**
 * What the console shows on Settings › Backups & logs, and what its alerts are worked out from. Plain
 * values only — dates, strings, numbers — so it crosses to the page's client parts as it is.
 */

export type RunRow = {
  id: string;
  kind: OffsiteRunKind;
  status: OffsiteRunStatus;
  startedBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  summary: string | null;
  error: string | null;
  objects: number;
  bytes: number;
  tenant: { id: string; slug: string } | null;
};

export type OffsiteStatus = {
  setup: OffsiteSetup;
  /** The store in words — "Azure Blob · account/container/deskzo" — or null when none is set. */
  label: string | null;
  /** The store's address without its secret, for the edit form. */
  config: StoreConfig | null;
  latest: Partial<Record<OffsiteRunKind, RunRow>>;
  lastSucceeded: Partial<Record<OffsiteRunKind, Date>>;
  recent: RunRow[];
  drills: RunRow[];
  workspaces: { live: number; offsite: number; newestSync: Date | null; failing: { id: string; slug: string; error: string; since: Date | null }[] };
  clock: ClockCheck | null;
  requested: ChoreRequest | null;
  accessLog: { enabled: boolean; dir: string };
};

const KINDS: OffsiteRunKind[] = ["SYNC", "CONTROL_DUMP", "DRILL", "LOGS"];

const SELECT = { id: true, kind: true, status: true, startedBy: true, startedAt: true, finishedAt: true, summary: true, error: true, objects: true, bytes: true, tenantId: true } as const;
type Raw = { id: string; kind: OffsiteRunKind; status: OffsiteRunStatus; startedBy: string; startedAt: Date; finishedAt: Date | null; summary: string | null; error: string | null; objects: number; bytes: bigint; tenantId: string | null };

export async function offsiteStatus(): Promise<OffsiteStatus> {
  const control = controlDb();
  const [setup, recentRaw, drillsRaw, latestRaw, okRaw, rows, live, clock, requested] = await Promise.all([
    offsiteSetup(),
    control.offsiteRun.findMany({ orderBy: { startedAt: "desc" }, take: 30, select: SELECT }),
    control.offsiteRun.findMany({ where: { kind: "DRILL" }, orderBy: { startedAt: "desc" }, take: 10, select: SELECT }),
    Promise.all(KINDS.map((kind) => control.offsiteRun.findFirst({ where: { kind }, orderBy: { startedAt: "desc" }, select: SELECT }))),
    Promise.all(KINDS.map((kind) => control.offsiteRun.findFirst({ where: { kind, status: "SUCCEEDED" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }))),
    control.offsiteWorkspace.findMany({ select: { tenantId: true, backups: true, lastSyncedAt: true, lastError: true, updatedAt: true } }),
    control.tenant.findMany({ where: { status: { not: "PROVISIONING" }, NOT: { status: "DEPROVISIONED", keyBundleCipher: "" } }, select: { id: true, slug: true } }),
    lastClockCheck(),
    pendingRequest(),
  ]);
  const slugs = new Map(live.map((t) => [t.id, t.slug]));
  const tenantIds = [...new Set([...recentRaw, ...drillsRaw, ...latestRaw.filter((r): r is Raw => !!r)].map((r) => r.tenantId).filter((id): id is string => !!id && !slugs.has(id)))];
  if (tenantIds.length) {
    for (const t of await control.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, slug: true } })) slugs.set(t.id, t.slug);
  }
  const row = (r: Raw): RunRow => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    startedBy: r.startedBy,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    summary: r.summary,
    error: r.error,
    objects: r.objects,
    bytes: Number(r.bytes),
    tenant: r.tenantId ? { id: r.tenantId, slug: slugs.get(r.tenantId) ?? r.tenantId } : null,
  });

  const latest: OffsiteStatus["latest"] = {};
  const lastSucceeded: OffsiteStatus["lastSucceeded"] = {};
  KINDS.forEach((kind, i) => {
    const l = latestRaw[i];
    if (l) latest[kind] = row(l);
    const ok = okRaw[i];
    if (ok) lastSucceeded[kind] = ok.startedAt;
  });

  const liveIds = new Set(live.map((t) => t.id));
  const mine = rows.filter((r) => liveIds.has(r.tenantId));
  const synced = mine.map((r) => r.lastSyncedAt?.getTime() ?? 0).filter(Boolean);

  let label: string | null = null;
  if (setup.config) {
    try {
      // A label needs no secret; any non-empty stand-in opens the store just far enough to name it.
      label = openStore(setup.config, "-").label;
    } catch {
      label = null;
    }
  }

  return {
    setup,
    label,
    config: setup.config,
    latest,
    lastSucceeded,
    recent: recentRaw.map(row),
    drills: drillsRaw.map(row),
    workspaces: {
      live: live.length,
      offsite: mine.filter((r) => r.backups > 0).length,
      newestSync: synced.length ? new Date(Math.max(...synced)) : null,
      failing: mine.filter((r) => r.lastError).map((r) => ({ id: r.tenantId, slug: slugs.get(r.tenantId) ?? r.tenantId, error: r.lastError!, since: r.updatedAt })),
    },
    clock,
    requested,
    accessLog: { enabled: accessLogEnabled(), dir: accessLogDir() },
  };
}

export type OffsiteFacts = {
  configured: boolean;
  latest: Partial<Record<OffsiteRunKind, { id: string; status: OffsiteRunStatus; startedAt: Date; finishedAt: Date | null; summary: string | null; error: string | null; tenantId: string | null }>>;
  lastSucceeded: Partial<Record<OffsiteRunKind, Date>>;
  /** The newest drill of a workspace, and of the control plane: a week's drill runs both, and one failing must not hide behind the other. */
  drills: { workspace: OffsiteFacts["latest"]["DRILL"] | null; control: OffsiteFacts["latest"]["DRILL"] | null };
  /** When anything first ran — a store set up yesterday has had no week to drill in. */
  firstRunAt: Date | null;
  clock: ClockCheck | null;
};

/**
 * The few facts the console's alerts need, in four small reads — they are worked out on every console
 * page for the nav badge (src/lib/platform/alerts.ts).
 */
export async function offsiteFacts(): Promise<OffsiteFacts> {
  const control = controlDb();
  type Latest = { id: string; kind: OffsiteRunKind; status: OffsiteRunStatus; startedAt: Date; finishedAt: Date | null; summary: string | null; error: string | null; tenantId: string | null };
  const [settings, latest, succeeded, first, drills] = await Promise.all([
    control.platformSetting.findMany({ where: { key: { in: ["offsite.provider", "offsite.config", "platform.clockCheck"] } }, select: { key: true, value: true } }),
    control.$queryRaw<Latest[]>`
      SELECT DISTINCT ON ("kind") "id", "kind"::text AS "kind", "status"::text AS "status", "startedAt", "finishedAt", "summary", "error", "tenantId"
      FROM "offsite_runs" ORDER BY "kind", "startedAt" DESC`,
    control.$queryRaw<{ kind: OffsiteRunKind; at: Date }[]>`
      SELECT "kind"::text AS "kind", max("startedAt") AS "at" FROM "offsite_runs" WHERE "status" = 'SUCCEEDED' GROUP BY "kind"`,
    control.offsiteRun.findFirst({ orderBy: { startedAt: "asc" }, select: { startedAt: true } }),
    control.$queryRaw<Latest[]>`
      SELECT DISTINCT ON ("tenantId" IS NULL) "id", "kind"::text AS "kind", "status"::text AS "status", "startedAt", "finishedAt", "summary", "error", "tenantId"
      FROM "offsite_runs" WHERE "kind" = 'DRILL' ORDER BY ("tenantId" IS NULL), "startedAt" DESC`,
  ]);
  const value = (key: string) => settings.find((s) => s.key === key)?.value ?? null;
  let clock: ClockCheck | null = null;
  try {
    clock = value("platform.clockCheck") ? (JSON.parse(value("platform.clockCheck")!) as ClockCheck) : null;
  } catch {
    clock = null;
  }
  return {
    configured: !!value("offsite.provider") && !!value("offsite.config"),
    latest: Object.fromEntries(latest.map((r) => [r.kind, r])),
    lastSucceeded: Object.fromEntries(succeeded.map((r) => [r.kind, r.at])),
    drills: { workspace: drills.find((d) => d.tenantId !== null) ?? null, control: drills.find((d) => d.tenantId === null) ?? null },
    firstRunAt: first?.startedAt ?? null,
    clock,
  };
}
