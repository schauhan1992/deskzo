import { redactSecrets } from "@/lib/console-shared/redact";
import { moduleEntitled } from "@/lib/entitlements";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Deskzo's guides to its modules, as a workspace's Help panel shows them: the Help Center's published
 * guides (pages at help/<guide> on the public website, src/lib/help/guides.ts), each a link to the
 * guide on the website — never a copy inside the workspace, and never anything the workspace wrote.
 * The company's own guides are its HelpLink rows (src/actions/help.ts); the two are shown apart.
 *
 * Like the rest of Deskzo's help (./help-content.ts) the read must never throw and never slow the panel:
 * one shared, minute-long copy of every published guide's few fields, 1.5 s for the control plane to
 * answer, nothing shown when it can't. Each workspace sees the guides for the modules its plan has.
 */

/** A published guide's fields, as the shared copy keeps them. */
export type PublishedGuideRow = { slug: string; module: string; heading: string; summary: string; words: string };

/** A guide as a workspace is given it: a link to the Help Center. */
export type DeskzoGuide = { module: string; title: string; summary: string; url: string; words: string };

export type DeskzoGuides = { ok: boolean; guides: DeskzoGuide[] };

const CACHE_MS = 60_000;
const LOAD_TIMEOUT_MS = 1_500;
const GUIDE_SLUG = /^help\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Far more than there are modules. */
const MAX_GUIDES = 200;

/** The public website's own address — where the Help Center is — from PLATFORM_DOMAIN[:PLATFORM_PORT]. */
export function helpCenterOrigin(): string {
  const port = process.env.PLATFORM_PORT?.trim();
  const host = `${PLATFORM_DOMAIN}${port ? `:${port}` : ""}`;
  return `${protocolFor(host)}://${host}`;
}

/** The Help Center's index, on the public website. */
export const helpCenterUrl = () => `${helpCenterOrigin()}/help`;

/**
 * Every published guide's slug, module, heading, summary and the words its search looks in (tasks and
 * questions) — read straight out of the published copy, so a guide's whole body is never fetched for a
 * panel that shows a line of it. One per module: the first address in order wins, as the website's does.
 */
async function loadGuides(): Promise<PublishedGuideRow[]> {
  const rows = await controlDb().$queryRaw<{ slug: string; module: string | null; heading: string | null; summary: string | null; words: string | null }[]>`
    SELECT p.slug::text AS slug,
           b->'props'->>'module' AS module,
           b->'props'->>'heading' AS heading,
           b->'props'->>'summary' AS summary,
           concat_ws(' · ',
             (SELECT string_agg(t->>'title', ' · ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b->'props'->'tasks') = 'array' THEN b->'props'->'tasks' ELSE '[]'::jsonb END) t),
             (SELECT string_agg(q->>'question', ' · ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b->'props'->'faq') = 'array' THEN b->'props'->'faq' ELSE '[]'::jsonb END) q)
           ) AS words
    FROM site_pages p
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.published->'blocks') = 'array' THEN p.published->'blocks' ELSE '[]'::jsonb END) b
    WHERE p.status = 'PUBLISHED' AND p."archivedAt" IS NULL AND p.slug LIKE 'help/%' AND b->>'type' = 'helpGuide'
    ORDER BY p.slug
    LIMIT ${MAX_GUIDES}`;
  return publishedGuides(rows);
}

/** The rows a guide read keeps: a guide address, a module, a heading — one per module, the first by address. Pure. */
export function publishedGuides(rows: readonly { slug?: unknown; module?: unknown; heading?: unknown; summary?: unknown; words?: unknown }[]): PublishedGuideRow[] {
  const seen = new Set<string>();
  const out: PublishedGuideRow[] = [];
  for (const r of [...(Array.isArray(rows) ? rows : [])].sort((a, b) => String(a?.slug ?? "").localeCompare(String(b?.slug ?? "")))) {
    const slug = typeof r?.slug === "string" ? r.slug : "";
    const moduleKey = typeof r?.module === "string" ? r.module : "";
    const heading = typeof r?.heading === "string" ? r.heading.trim() : "";
    if (!GUIDE_SLUG.test(slug) || !moduleKey || !heading || seen.has(moduleKey)) continue;
    seen.add(moduleKey);
    out.push({ slug, module: moduleKey, heading, summary: typeof r.summary === "string" ? r.summary : "", words: typeof r.words === "string" ? r.words : "" });
  }
  return out;
}

type Loaded = { at: number; ok: boolean; rows: PublishedGuideRow[] };

let cache: Loaded | null = null;
let inflight: Promise<Loaded> | null = null;

async function within(load: () => Promise<PublishedGuideRow[]>): Promise<PublishedGuideRow[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<PublishedGuideRow[]>((resolve) => resolve(load())),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${LOAD_TIMEOUT_MS} ms`)), LOAD_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
    console.warn(`[help-guides] could not read Deskzo's guides, so none is shown for now: ${redactSecrets(message)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function liveGuides(now: number): Promise<Loaded> {
  if (cache && now >= cache.at && now - cache.at < CACHE_MS) return cache;
  if (inflight) return inflight;
  inflight = within(loadGuides).then((rows) => {
    // A failure is remembered as "nothing" for the minute too, so a control plane that is down is asked once a minute.
    cache = { at: now, ok: rows !== null, rows: rows ?? [] };
    return cache;
  });
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** The guides a workspace is given from the rows: those for a module its plan has, each a link to the Help Center. Pure. */
export function guidesForWorkspace(rows: readonly PublishedGuideRow[], tenant: Pick<Tenant, "country" | "entitlements">, origin: string): DeskzoGuide[] {
  const country = typeof tenant?.country === "string" ? tenant.country.toUpperCase() : "";
  if (!tenant?.entitlements) return [];
  return rows
    .filter((r) => moduleEntitled(tenant.entitlements, country, r.module))
    .map((r) => ({ module: r.module, title: r.heading, summary: r.summary, url: `${origin}/${r.slug}`, words: r.words }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Deskzo's guides for this workspace's modules. Never throws and never waits more than 1.5 s: a
 * workspace from the environment, or an installation without a control plane, is given none (with
 * `ok`); a control plane that is down or slow, none with `ok: false`. `load` replaces the query, for
 * check suites; what it returns is never cached.
 */
export async function deskzoGuidesFor(tenant: Pick<Tenant, "country" | "entitlements" | "source">, now = Date.now(), load?: () => Promise<PublishedGuideRow[]>): Promise<DeskzoGuides> {
  try {
    if (!tenant || tenant.source !== "control" || (!load && !controlConfigured())) return { ok: true, guides: [] };
    const got = load ? await within(load).then((rows) => ({ ok: rows !== null, rows: rows ? publishedGuides(rows) : [] })) : await liveGuides(now);
    return { ok: got.ok, guides: guidesForWorkspace(got.rows, tenant, helpCenterOrigin()) };
  } catch (err) {
    console.warn(`[help-guides] skipped: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
    return { ok: false, guides: [] };
  }
}

/** Forget this process's copy — after a guide is published or taken down in the CMS, so this process shows it at once. */
export function forgetHelpGuides(): void {
  cache = null;
}
