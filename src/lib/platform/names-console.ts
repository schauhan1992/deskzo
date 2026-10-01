import { staffNameMap } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { COMPETITOR_NAMES, OUR_NAMES, PLATFORM_HOSTS, RESERVED_WORD_GROUPS, ruleTouches, type BuiltInGroup, type NameRule, type NameRuleKind } from "@/lib/workspace-names";

/**
 * What the console's "Workspace names" page shows (src/app/platform-console/(console)/names): the
 * built-in list in its groups — the platform's own addresses, locked; the reserved words, our names
 * and competitors', each with staff's release if there is one — and staff's own rules, with the
 * workspaces each one touches: the ones that already have a name a block would now refuse, and keep
 * it; the ones that use a word staff released.
 */

/** How many of the workspaces a rule touches are named; the rest are counted. */
const SHOWN = 5;

type Touching = { workspaces: string[]; workspaceCount: number };

export type NameRuleRow = Touching & {
  id: string;
  value: string;
  kind: NameRuleKind;
  reason: string;
  createdAt: Date;
  createdByName: string;
};

export type BuiltInWord = Touching & {
  word: string;
  group: BuiltInGroup;
  /** Staff's release of it, when there is one. */
  release: { id: string; reason: string; createdAt: Date; createdByName: string } | null;
};

export type NamesBoard = {
  platformHosts: string[];
  reserved: { key: string; label: string; words: BuiltInWord[] }[];
  ours: BuiltInWord[];
  competitors: BuiltInWord[];
  /** Newest first. */
  rules: NameRuleRow[];
  counts: { blocks: number; releases: number; platformHosts: number; releasable: number };
};

/** The workspaces whose addresses a rule touches, from a list of every address. */
function touching(slugs: readonly string[], rule: NameRule): Touching {
  const hits = slugs.filter((slug) => ruleTouches(slug, rule));
  return { workspaces: hits.slice(0, SHOWN), workspaceCount: hits.length };
}

async function everySlug(): Promise<string[]> {
  const rows = await controlDb().tenant.findMany({ select: { slug: true }, orderBy: { slug: "asc" } });
  return rows.map((r) => r.slug);
}

export async function namesBoard(): Promise<NamesBoard> {
  const [rows, slugs] = await Promise.all([
    controlDb().workspaceNameRule.findMany({ orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: { id: true, value: true, kind: true, reason: true, createdBy: true, createdAt: true } }),
    everySlug(),
  ]);
  const names = await staffNameMap(rows.map((r) => r.createdBy));
  const nameOf = (by: string) => names.get(by) ?? (by.includes(":") ? "A script" : "A former staff member");
  const rules: NameRuleRow[] = rows.map((r) => ({ id: r.id, value: r.value, kind: r.kind, reason: r.reason, createdAt: r.createdAt, createdByName: nameOf(r.createdBy), ...touching(slugs, r) }));
  const releases = new Map(rules.filter((r) => r.kind === "RELEASE").map((r) => [r.value, r]));
  const word = (w: string, group: BuiltInGroup): BuiltInWord => {
    const release = releases.get(w);
    return {
      word: w,
      group,
      release: release ? { id: release.id, reason: release.reason, createdAt: release.createdAt, createdByName: release.createdByName } : null,
      ...touching(slugs, { kind: "RELEASE", value: w }),
    };
  };
  const reserved = RESERVED_WORD_GROUPS.map((g) => ({ key: g.key, label: g.label, words: [...g.words].sort().map((w) => word(w, "reserved")) }));
  return {
    platformHosts: [...PLATFORM_HOSTS].sort(),
    reserved,
    ours: OUR_NAMES.map((w) => word(w, "ours")),
    competitors: [...COMPETITOR_NAMES].sort().map((w) => word(w, "competitor")),
    rules,
    counts: {
      blocks: rules.filter((r) => r.kind !== "RELEASE").length,
      releases: releases.size,
      platformHosts: PLATFORM_HOSTS.size,
      releasable: reserved.reduce((n, g) => n + g.words.length, 0) + OUR_NAMES.length + COMPETITOR_NAMES.length,
    },
  };
}

/** The workspaces a rule not yet made would touch — for the confirmation before it is. */
export async function nameRuleImpact(rule: NameRule): Promise<Touching> {
  return touching(await everySlug(), rule);
}
