import { actorRef, cmsAudit, refLabels, type CmsActor } from "@/lib/cms/audit";
import { CmsRefused, DEFAULT_SEARCH_POLICY, LLMS_SUMMARY_MAX, type EffectiveSearchPolicy, type SearchPolicy, type SearchPolicyDetail } from "@/lib/cms/types";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";

/**
 * What crawlers may do on the public website (owner, 5 Oct 2026) — CMS › Settings › Search & AI, for
 * admins. One `cms_settings` row ("search"), JSON; no draft: saved is live.
 *
 *   · hideSite     the whole site out of search: every page noindex (header and meta), the sitemap
 *                  and llms.txt empty, every AI crawler refused. A staging installation
 *                  (PLATFORM_ENV=staging) is always hidden, whatever is stored.
 *   · aiSearch     AI search crawlers may read the site (S-D2: yes).
 *   · aiTraining   AI training crawlers may (S-D2: no).
 *   · llmsTxt      /llms.txt is served (src/app/llms.txt/route.ts), opening with `llmsSummary`.
 *
 * Read by robots.txt, the sitemap, llms.txt, the site's layout metadata, the proxy's X-Robots-Tag and
 * the SEO scores. Each process keeps its copy for 30 seconds; a save bumps a counter on `globalThis`,
 * which the proxy's copy of this module (bundled apart from the CMS's actions) shares, so it reads again
 * at once. A failed read keeps the last copy, or the defaults — the site stays as S-D2 left it.
 */

const KEY = "search";
const TTL_MS = 30_000;
const RETRY_AFTER_FAILURE_MS = 10_000;

const GENERATION = Symbol.for("deskzo.site-search-policy.generation");
const generationNow = () => (globalThis as Record<symbol, number | undefined>)[GENERATION] ?? 0;

/** Every process's copy is out of date: read it again on the next request. */
export function invalidateSearchPolicy(): void {
  (globalThis as Record<symbol, number | undefined>)[GENERATION] = generationNow() + 1;
}

type Held = { generation: number; at: number; policy: SearchPolicy; updatedAt: Date | null };
let held: Held | null = null;
let loading: Promise<Held> | null = null;
let lastFailureLog = 0;

/** A stored value read tolerantly: anything missing or malformed keeps its default. */
export function parseSearchPolicy(raw: string | null | undefined): SearchPolicy {
  let value: unknown = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const flag = (key: keyof SearchPolicy) => (typeof v[key] === "boolean" ? (v[key] as boolean) : (DEFAULT_SEARCH_POLICY[key] as boolean));
  return {
    hideSite: flag("hideSite"),
    aiSearch: flag("aiSearch"),
    aiTraining: flag("aiTraining"),
    llmsTxt: flag("llmsTxt"),
    llmsSummary: typeof v.llmsSummary === "string" ? v.llmsSummary.slice(0, LLMS_SUMMARY_MAX) : DEFAULT_SEARCH_POLICY.llmsSummary,
  };
}

/** A staging installation is never indexed, whatever an admin chose. */
export const stagingInstallation = (): boolean => process.env.PLATFORM_ENV?.trim().toLowerCase() === "staging";

export function effectiveSearchPolicy(policy: SearchPolicy): EffectiveSearchPolicy {
  const forcedHidden = stagingInstallation();
  return { ...policy, hidden: policy.hideSite || forcedHidden, forcedHidden };
}

async function read(generation: number): Promise<Held> {
  const row = await controlDb().cmsSetting.findUnique({ where: { key: KEY }, select: { value: true, updatedAt: true } });
  return { generation, at: Date.now(), policy: parseSearchPolicy(row?.value), updatedAt: row?.updatedAt ?? null };
}

async function current(): Promise<Held | null> {
  if (!controlConfigured()) return null;
  const generation = generationNow();
  const now = Date.now();
  if (held && held.generation === generation && now - held.at < TTL_MS) return held;
  loading ??= read(generation)
    .then((fresh) => (held = fresh))
    .catch((err: unknown) => {
      if (Date.now() - lastFailureLog > 10 * 60_000) {
        lastFailureLog = Date.now();
        const code = (err as { code?: string } | null)?.code;
        console.warn(`[site] search settings unavailable, using the last known: ${code ?? (err instanceof Error ? err.name : "error")}`);
      }
      // Kept for the retry interval, not the full TTL, and marked current so a burst doesn't hammer a failing database.
      held = { generation, at: Date.now() - TTL_MS + RETRY_AFTER_FAILURE_MS, policy: held?.policy ?? DEFAULT_SEARCH_POLICY, updatedAt: held?.updatedAt ?? null };
      return held;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The policy as it applies now. Never throws. */
export async function searchPolicy(): Promise<EffectiveSearchPolicy> {
  return effectiveSearchPolicy((await current())?.policy ?? DEFAULT_SEARCH_POLICY);
}

/** When the stored policy last changed, or null (never) — the SEO scores read their crawler check from it. */
export async function searchPolicyChangedAt(): Promise<Date | null> {
  return (await current())?.updatedAt ?? null;
}

/** For check scripts: forget this process's copy. */
export function forgetSearchPolicy(): void {
  held = null;
  loading = null;
  invalidateSearchPolicy();
}

// ─── The Search & AI page ────────────────────────────────────────────────────────────────────────

function siteOriginForLinks(): string {
  const host = `${PLATFORM_DOMAIN}${process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : ""}`;
  return `${protocolFor(host)}://${host}`;
}

export async function getSearchPolicyDetail(): Promise<SearchPolicyDetail> {
  const row = await controlDb().cmsSetting.findUnique({ where: { key: KEY }, select: { value: true, updatedAt: true, updatedBy: true } });
  const policy = parseSearchPolicy(row?.value);
  const by = row?.updatedBy ? ((await refLabels([row.updatedBy])).get(row.updatedBy) ?? row.updatedBy) : null;
  return { policy, effective: effectiveSearchPolicy(policy), updatedAt: row?.updatedAt ?? null, updatedBy: by, siteOrigin: siteOriginForLinks() };
}

/** One line of plain text: control characters and runs of spaces out, trimmed. */
const cleanSummary = (raw: unknown) =>
  typeof raw === "string"
    ? raw
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

/** Saves the whole policy (every field given), live at once; audited with what changed. */
export async function saveSearchPolicy(input: unknown, actor: CmsActor): Promise<SearchPolicyDetail> {
  const v = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  const flags = ["hideSite", "aiSearch", "aiTraining", "llmsTxt"] as const;
  if (!v || flags.some((f) => typeof v[f] !== "boolean")) throw new CmsRefused("Every switch is on or off.");
  const summary = cleanSummary(v.llmsSummary);
  if (summary.length > LLMS_SUMMARY_MAX) throw new CmsRefused(`Keep the summary to ${LLMS_SUMMARY_MAX} characters.`, { issues: [{ path: "llmsSummary", message: `Keep it to ${LLMS_SUMMARY_MAX} characters.` }] });
  const next: SearchPolicy = { hideSite: v.hideSite as boolean, aiSearch: v.aiSearch as boolean, aiTraining: v.aiTraining as boolean, llmsTxt: v.llmsTxt as boolean, llmsSummary: summary };

  const before = parseSearchPolicy((await controlDb().cmsSetting.findUnique({ where: { key: KEY }, select: { value: true } }))?.value);
  const changed = (Object.keys(next) as (keyof SearchPolicy)[]).filter((k) => next[k] !== before[k]);
  if (changed.length) {
    const value = JSON.stringify(next);
    await controlDb().cmsSetting.upsert({ where: { key: KEY }, create: { key: KEY, value, updatedBy: actorRef(actor) }, update: { value, updatedBy: actorRef(actor) } });
    invalidateSearchPolicy();
    // The detail says which switches moved and to what — never the summary's words, which the page shows.
    const detail: Record<string, unknown> = { fields: changed };
    for (const f of flags) if (changed.includes(f)) detail[f] = next[f];
    await cmsAudit(actor, "settings.search", "settings", KEY, detail);
  }
  return getSearchPolicyDetail();
}
