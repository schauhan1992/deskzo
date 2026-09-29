import { taxonomySitemapEntries } from "@/lib/cms/taxonomy";
import { checkRedirectShape, findRule, indexRules, normalisePath, redirectablePath, type RuleLike } from "@/lib/cms/redirect-rules";
import type { LiveAddress, RedirectCheck, RedirectCovers, RedirectImportResult, RedirectInput, RedirectRow } from "@/lib/cms/types";
import { controlDb } from "@/lib/platform/control-db";
import { listSitePages, listSitePosts } from "@/lib/platform/site-content";

/**
 * What a redirect hides: the pages, posts and archives that are on the site now at an address a
 * redirect sends visitors away from. A redirect made by hand from a live post's own address is
 * allowed — it is sometimes meant — but the post can no longer be reached, and the sitemap leaves it
 * out (src/app/sitemap.ts). So the CMS says so: in the redirect dialog before saving, on each row of
 * an import's preview, and on the list for redirects that hide something now (a post published later
 * at a redirected address included).
 *
 * Matching is the proxy's own (./redirect-rules.ts): a live address is hidden by the redirect the
 * proxy would apply to it — an exact one first, then the longest "everything under" — and never when
 * the proxy doesn't look the address up at all (the site's built-in pages).
 *
 * Kept apart from ./redirects.ts on purpose: the proxy imports that file on every request, and this
 * one reads the site's content.
 */

type Live = LiveAddress & { key: string };

const EXAMPLES = 3;

/** Every address on the site a visitor can open now, that a redirect could take over. */
async function liveAddresses(): Promise<Live[]> {
  const [pages, posts, archives] = await Promise.all([listSitePages(), listSitePosts(), taxonomySitemapEntries()]);
  const all: LiveAddress[] = [
    ...pages.map((p) => ({ path: p.path, kind: "page" as const, title: p.title })),
    ...(posts.length ? [{ path: "/blog", kind: "blog" as const, title: "The blog" }] : []),
    ...posts.map((p) => ({ path: p.path, kind: "post" as const, title: "" })),
    ...(posts.length ? archives : []).map((a) => ({ path: a.path, kind: a.path.startsWith("/blog/category/") ? ("category" as const) : ("tag" as const), title: "" })),
  ];
  return all.flatMap((a) => {
    const key = normalisePath(a.path);
    return key && redirectablePath(a.path) ? [{ ...a, key }] : [];
  });
}

/** For each redirect among `rules`, the live addresses it is the proxy's match for. */
function coveredBy(rules: readonly RuleLike[], live: readonly Live[]): Map<string, Live[]> {
  const index = indexRules(rules);
  const out = new Map<string, Live[]>();
  for (const address of live) {
    const rule = findRule(index, address.key);
    if (!rule) continue;
    const list = out.get(rule.id);
    if (list) list.push(address);
    else out.set(rule.id, [address]);
  }
  return out;
}

/** The first few, with the titles of posts and archives looked up (a page's is already known). */
async function coversOf(found: readonly Live[]): Promise<RedirectCovers> {
  const examples = found.slice(0, EXAMPLES);
  const slugs = (kind: LiveAddress["kind"], prefix: string) => examples.filter((e) => e.kind === kind).map((e) => e.path.slice(prefix.length));
  const [posts, categories, tags] = await Promise.all([
    slugs("post", "/blog/").length ? controlDb().sitePost.findMany({ where: { slug: { in: slugs("post", "/blog/") } }, select: { slug: true, title: true } }) : [],
    slugs("category", "/blog/category/").length ? controlDb().siteCategory.findMany({ where: { slug: { in: slugs("category", "/blog/category/") } }, select: { slug: true, name: true } }) : [],
    slugs("tag", "/blog/tag/").length ? controlDb().siteTag.findMany({ where: { slug: { in: slugs("tag", "/blog/tag/") } }, select: { slug: true, name: true } }) : [],
  ]);
  const titleOf = (e: Live): string => {
    if (e.kind === "post") return posts.find((p) => `/blog/${p.slug}` === e.path)?.title ?? e.path;
    if (e.kind === "category") return categories.find((c) => `/blog/category/${c.slug}` === e.path)?.name ?? e.path;
    if (e.kind === "tag") return tags.find((t) => `/blog/tag/${t.slug}` === e.path)?.name ?? e.path;
    return e.title;
  };
  return { total: found.length, examples: examples.map((e) => ({ path: e.path, kind: e.kind, title: titleOf(e) })) };
}

async function enabledRules(): Promise<RuleLike[]> {
  return controlDb().siteRedirect.findMany({ where: { enabled: true }, select: { id: true, fromPath: true, toUrl: true, match: true } });
}

/**
 * The redirect dialog's check, with what it would hide once switched on: `covers`, null when nothing.
 * Asked only of a redirect that could be saved and is switched on — while off it hides nothing.
 * `exceptId`: the redirect being edited, whose own saved version is left out.
 */
export async function withCovers(check: RedirectCheck, input: RedirectInput, exceptId: string | null): Promise<RedirectCheck> {
  const shape = check.normalised;
  if (!check.ok || !shape || input.enabled === false) return { ...check, covers: null };
  const [rules, live] = await Promise.all([enabledRules(), liveAddresses()]);
  const self: RuleLike = { id: "self", fromPath: shape.fromPath, toUrl: shape.toUrl, match: shape.match };
  const found = coveredBy([...rules.filter((r) => r.id !== exceptId && r.fromPath !== shape.fromPath), self], live).get("self");
  return { ...check, covers: found?.length ? await coversOf(found) : null };
}

/** The list's rows, each with how many live pages it hides now (0 for one switched off). */
export async function withHides<T extends { rows: RedirectRow[] }>(list: T): Promise<T> {
  if (!list.rows.some((r) => r.enabled)) return { ...list, rows: list.rows.map((r) => ({ ...r, hides: 0 })) };
  const [rules, live] = await Promise.all([enabledRules(), liveAddresses()]);
  const covered = coveredBy(rules, live);
  return { ...list, rows: list.rows.map((r) => ({ ...r, hides: r.enabled ? (covered.get(r.id)?.length ?? 0) : 0 })) };
}

/**
 * An import's preview, each row to be created or updated with how many live pages it would hide —
 * over the redirects the site would then have. An updated redirect keeps its on/off state, so one
 * switched off hides nothing.
 */
export async function withImportHides(result: RedirectImportResult): Promise<RedirectImportResult> {
  const changing = result.rows.filter((r) => r.outcome === "create" || r.outcome === "update");
  if (!changing.length) return result;
  const [all, live] = await Promise.all([controlDb().siteRedirect.findMany({ select: { id: true, fromPath: true, toUrl: true, match: true, enabled: true } }), liveAddresses()]);
  const enabledById = new Map(all.map((r) => [r.id, r.enabled]));
  const replaced = new Set(changing.map((r) => r.from));
  const incoming: RuleLike[] = changing.flatMap((r) => {
    const shape = checkRedirectShape({ from: r.from, to: r.to, match: r.match ?? undefined, status: r.status ?? undefined });
    if (!shape.ok || (r.id && enabledById.get(r.id) === false)) return [];
    return [{ id: `line:${r.line}`, fromPath: shape.value.fromPath, toUrl: shape.value.toUrl, match: shape.value.match }];
  });
  const covered = coveredBy([...all.filter((r) => r.enabled && !replaced.has(r.fromPath)), ...incoming], live);
  return { ...result, rows: result.rows.map((r) => (r.outcome === "create" || r.outcome === "update" ? { ...r, hides: covered.get(`line:${r.line}`)?.length ?? 0 } : r)) };
}
