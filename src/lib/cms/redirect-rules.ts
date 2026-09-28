import { MAX_REDIRECT_HOPS, REDIRECT_STATUSES, SITE_BUILTIN_ROUTES, type CmsIssue, type RedirectChain, type RedirectStatus, type SiteRedirectMatch } from "@/lib/cms/types";

/**
 * The redirect manager's rules, pure: how a path is keyed, which paths can never be redirected, what
 * a target may be, how a redirect matches a request and what it answers, and how chains and loops
 * are found. No database and nothing server-only, so the CMS's redirect dialog can run the same
 * checks as the server (which always checks again) — src/lib/cms/redirects.ts does the storing.
 *
 *   · A source path is keyed lower-case, without its query or #fragment, with no trailing slash
 *     (except "/" itself) and no doubled slashes, percent-encoded exactly as a browser sends it — so
 *     "/Café/", "/caf%C3%A9?x=1" and "https://old.example/CAFÉ" are one key. A PREFIX source ends in
 *     "/*" and matches its base and everything under it.
 *   · A target is a path on the site ("/pricing", "/pricing?country=US", "/new/*") or an https://
 *     address. Nothing else: never http:, javascript:, data:, "//host" or "/\host".
 *   · The site's own routes, its machinery (/api, /_next, /media, /preview, the platform folders,
 *     robots.txt, the sitemap) and static files are never a source.
 */

const PARSE_BASE = "http://redirect.invalid";
const PARSE_HOST = "redirect.invalid";
/** The longest source or target stored (the database's CHECKs). */
export const REDIRECT_PATH_MAX = 2000;
export const REDIRECT_NOTE_MAX = 500;

const BUILTIN_MESSAGE = "That page is part of the site and can't be redirected.";
const MACHINERY_MESSAGE = "That address is used by the site itself and can't be redirected.";
const SYSTEM_PREFIXES = ["/api", "/_next", "/media", "/preview", "/platform-site", "/platform-console", "/platform-cms", "/platform-partners"] as const;
const SYSTEM_FILES = ["/favicon.ico", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest"] as const;
/** A file the site serves as it is — an old page's ".html", ".php" or ".pdf" address can still be redirected. */
const STATIC_FILE = /\.(?:ico|png|jpe?g|gif|svg|webp|avif|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|webmanifest)$/;

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * A path as the redirect manager keys it, or null when it is not one. Accepts "/old", "old",
 * "/Old/Page/?utm=x#top" and a full "https://…/old" address (whose host is ignored: redirects only
 * ever apply on the public site). The same function keys a request's path in the proxy.
 */
export function normalisePath(raw: unknown): string | null {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input || input.length > 4 * REDIRECT_PATH_MAX || hasControl(input)) return null;
  const absolute = /^https?:\/\//i.test(input);
  let url: URL;
  try {
    url = absolute ? new URL(input) : new URL(`/${input.replace(/^[\\/]+/, "")}`, PARSE_BASE);
  } catch {
    return null;
  }
  if (!absolute && url.host !== PARSE_HOST) return null;
  let path = url.pathname.toLowerCase().replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  return path.length <= REDIRECT_PATH_MAX ? path : null;
}

/** Why a (normalised) source can never be redirected, or null when it can. */
export function reservedSource(fromPath: string): string | null {
  const prefix = fromPath.endsWith("/*");
  const base = prefix ? fromPath.slice(0, -2) : fromPath;
  if (prefix && (base === "" || base === "/")) return "That would redirect the whole site.";
  if (base === "" || base === "/") return BUILTIN_MESSAGE;
  if (SITE_BUILTIN_ROUTES.some((route) => under(base, route))) return BUILTIN_MESSAGE;
  if (SYSTEM_PREFIXES.some((root) => under(base, root)) || (SYSTEM_FILES as readonly string[]).includes(base) || STATIC_FILE.test(base)) return MACHINERY_MESSAGE;
  return null;
}

/** Whether the proxy may look a request's path up at all: not the site's own routes, machinery or files. */
export function redirectablePath(pathname: string): boolean {
  const key = normalisePath(pathname);
  return !!key && reservedSource(key) === null;
}

export type TargetCheck = { ok: true; toUrl: string; external: boolean; splat: boolean } | { ok: false; message: string };

const TARGET_HELP = "A redirect goes to a path on this site (/pricing) or an https:// address.";

/**
 * A redirect's target as it is stored: a site path keeps its query and #fragment (encoded as a
 * browser would), loses a trailing slash; an https:// address is normalised by the URL parser
 * (lower-case scheme and host, spaces encoded). A final "/*" stands for the rest of the address (a
 * PREFIX redirect's). `ownHosts`: the public site's own hosts — an address on one of them is stored
 * as a path.
 */
export function normaliseTarget(raw: unknown, options: { ownHosts?: readonly string[] } = {}): TargetCheck {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return { ok: false, message: `Say where it goes. ${TARGET_HELP}` };
  if (input.length > REDIRECT_PATH_MAX) return { ok: false, message: `Keep the target to ${REDIRECT_PATH_MAX.toLocaleString("en-IN")} characters.` };
  if (hasControl(input)) return { ok: false, message: TARGET_HELP };
  const splat = input.endsWith("/*");
  const body = splat ? input.slice(0, -2) : input;
  if (input.startsWith("/")) {
    if (/^\/[\\/]/.test(input)) return { ok: false, message: "A path on this site starts with a single /." };
    let url: URL;
    try {
      url = new URL(body || "/", PARSE_BASE);
    } catch {
      return { ok: false, message: TARGET_HELP };
    }
    if (url.host !== PARSE_HOST) return { ok: false, message: TARGET_HELP };
    let path = url.pathname.replace(/\/{2,}/g, "/");
    if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
    if (path.includes("*")) return { ok: false, message: "Only a final /* can stand for the rest of the address." };
    if (splat && (url.search || url.hash)) return { ok: false, message: "A target ending in /* can't have a ? or # part." };
    const toUrl = splat ? (path === "/" ? "/*" : `${path}/*`) : `${path}${url.search}${url.hash}`;
    if (toUrl.length > REDIRECT_PATH_MAX) return { ok: false, message: `Keep the target to ${REDIRECT_PATH_MAX.toLocaleString("en-IN")} characters.` };
    return { ok: true, toUrl, external: false, splat };
  }
  if (/^https:\/\//i.test(input)) {
    // "https:///x" and "https://\x" would be read as another host by the URL parser: never guess.
    if (/^https:\/\/[\\/]/i.test(input)) return { ok: false, message: "That isn't a web address." };
    let url: URL;
    try {
      url = new URL(body);
    } catch {
      return { ok: false, message: "That isn't a web address." };
    }
    if (url.protocol !== "https:" || !url.hostname) return { ok: false, message: "That isn't a web address." };
    if (url.username || url.password) return { ok: false, message: "An address with a user name or password in it can't be a redirect's target." };
    if (options.ownHosts?.includes(url.host)) {
      const path = url.pathname.replace(/\/+$/, "");
      return normaliseTarget(splat ? `${path}/*` : `${path || "/"}${url.search}${url.hash}`);
    }
    // Another site is a public web address: a dotted host name.
    if (!url.hostname.includes(".") || url.hostname.endsWith(".")) return { ok: false, message: "That isn't a web address." };
    if (url.pathname.includes("*")) return { ok: false, message: "Only a final /* can stand for the rest of the address." };
    if (splat && (url.search || url.hash)) return { ok: false, message: "A target ending in /* can't have a ? or # part." };
    const toUrl = splat ? `${url.origin}${url.pathname.replace(/\/+$/, "")}/*` : url.href;
    if (toUrl.length > REDIRECT_PATH_MAX) return { ok: false, message: `Keep the target to ${REDIRECT_PATH_MAX.toLocaleString("en-IN")} characters.` };
    return { ok: true, toUrl, external: true, splat };
  }
  if (/^http:\/\//i.test(input)) return { ok: false, message: "Use an https:// address for another site." };
  return { ok: false, message: TARGET_HELP };
}

/** A stored target's site path without its query or fragment — or null for another site's address. */
export function internalPathOf(toUrl: string): string | null {
  if (!toUrl.startsWith("/")) return null;
  return toUrl.split(/[?#]/)[0] || "/";
}

/** A redirect, as checked before it is stored. */
export type RedirectShape = { fromPath: string; toUrl: string; match: SiteRedirectMatch; status: RedirectStatus; external: boolean; note: string | null; enabled: boolean };

export type ShapeCheck = { ok: true; value: RedirectShape; issues: CmsIssue[] } | { ok: false; value: Partial<RedirectShape>; issues: CmsIssue[] };

function cleanNote(raw: unknown): string {
  let out = "";
  for (const ch of String(raw ?? "")) out += hasControl(ch) ? " " : ch;
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Everything about one redirect that needs no database: the source keyed and allowed, the target
 * allowed, `match` agreeing with the source's "/*" (inferred when left out), the status one of
 * 301/302/307/308 (301 when left out), the note at most 500 characters, and never to itself. Issues
 * name the field: "from", "to", "status", "match", "note". Whether it is an admin's to make (another
 * site's address), a duplicate, over the limit, a loop or a long chain is src/lib/cms/redirects.ts's.
 */
export function checkRedirectShape(
  input: { from?: unknown; to?: unknown; status?: unknown; match?: unknown; note?: unknown; enabled?: unknown },
  options: { ownHosts?: readonly string[] } = {},
): ShapeCheck {
  const issues: CmsIssue[] = [];
  const value: Partial<RedirectShape> = {};
  let fromPath = normalisePath(input.from);
  const requested = typeof input.match === "string" && input.match.trim() ? input.match.trim().toUpperCase() : null;
  if (requested !== null && requested !== "EXACT" && requested !== "PREFIX") issues.push({ path: "match", message: "Choose “Exact” or “Starts with”." });
  let match: SiteRedirectMatch = "EXACT";
  if (!fromPath) {
    issues.push({ path: "from", message: "Enter the old address: a path on this site, like /old-page." });
  } else {
    if (requested === "PREFIX" && !fromPath.endsWith("/*")) fromPath = fromPath === "/" ? "/*" : `${fromPath}/*`;
    if (requested === "EXACT" && fromPath.endsWith("/*")) issues.push({ path: "from", message: "An address ending in /* matches everything under it — choose “Starts with”." });
    match = requested === "EXACT" || requested === "PREFIX" ? requested : fromPath.endsWith("/*") ? "PREFIX" : "EXACT";
    const body = fromPath.endsWith("/*") ? fromPath.slice(0, -2) : fromPath;
    if (body.includes("*")) issues.push({ path: "from", message: "Only a final /* can stand for everything under an address." });
    else if (fromPath.length > REDIRECT_PATH_MAX) issues.push({ path: "from", message: `Keep the address to ${REDIRECT_PATH_MAX.toLocaleString("en-IN")} characters.` });
    else {
      const reserved = reservedSource(fromPath);
      if (reserved) issues.push({ path: "from", message: reserved });
    }
    value.fromPath = fromPath;
    value.match = match;
  }
  const target = normaliseTarget(input.to, options);
  if (!target.ok) issues.push({ path: "to", message: target.message });
  else {
    value.toUrl = target.toUrl;
    value.external = target.external;
    if (target.splat && match !== "PREFIX") issues.push({ path: "to", message: "Only a “Starts with” redirect's target can end in /*." });
    const toPath = internalPathOf(target.toUrl);
    if (fromPath && toPath !== null) {
      const fromBase = fromPath.endsWith("/*") ? fromPath.slice(0, -2) || "/" : fromPath;
      const toKey = normalisePath(target.splat ? toPath.slice(0, -2) || "/" : toPath);
      if (toKey === fromBase || (!target.splat && toKey === fromPath)) issues.push({ path: "to", message: "It would send the address to itself." });
    }
  }
  const rawStatus = input.status;
  const status = rawStatus === undefined || rawStatus === null || rawStatus === "" ? 301 : Number(rawStatus);
  if (!(REDIRECT_STATUSES as readonly number[]).includes(status)) issues.push({ path: "status", message: "Choose 301, 302, 307 or 308." });
  else value.status = status as RedirectStatus;
  const note = cleanNote(input.note);
  if (note.length > REDIRECT_NOTE_MAX) issues.push({ path: "note", message: `Keep the note to ${REDIRECT_NOTE_MAX} characters.` });
  value.note = note || null;
  value.enabled = input.enabled !== false;
  if (issues.length) return { ok: false, value, issues };
  return { ok: true, value: value as RedirectShape, issues };
}

// ─── Matching ────────────────────────────────────────────────────────────────────────────────────

export type RuleLike = { id: string; fromPath: string; toUrl: string; match: SiteRedirectMatch };
export type RuleIndex<R extends RuleLike> = { exact: Map<string, R>; prefixes: { base: string; rule: R }[] };

/** Redirects arranged for lookup: EXACT by path, PREFIX by base, longest first. */
export function indexRules<R extends RuleLike>(rules: Iterable<R>): RuleIndex<R> {
  const exact = new Map<string, R>();
  const prefixes: { base: string; rule: R }[] = [];
  for (const rule of rules) {
    if (rule.match === "PREFIX" && rule.fromPath.endsWith("/*")) prefixes.push({ base: rule.fromPath.slice(0, -2), rule });
    else if (rule.match === "EXACT") exact.set(rule.fromPath, rule);
  }
  prefixes.sort((a, b) => b.base.length - a.base.length || a.base.localeCompare(b.base));
  return { exact, prefixes };
}

/** The redirect for a keyed path: an EXACT one first, then the PREFIX with the longest base (which matches the base itself too). */
export function findRule<R extends RuleLike>(index: RuleIndex<R>, key: string): R | null {
  const exact = index.exact.get(key);
  if (exact) return exact;
  for (const p of index.prefixes) if (p.base && (key === p.base || key.startsWith(`${p.base}/`))) return p.rule;
  return null;
}

/**
 * Where a redirect sends `requestPath` (the path as requested, not keyed). A PREFIX redirect whose
 * target ends in "/*" carries over the rest of the path after its base — segment by segment, as it
 * was requested (its case and encoding kept); any other target is used as it is.
 */
export function targetFor(rule: RuleLike, requestPath: string): string {
  if (rule.match !== "PREFIX" || !rule.toUrl.endsWith("/*")) return rule.toUrl;
  const base = rule.fromPath.slice(0, -2);
  const baseSegments = base.split("/").filter(Boolean).length;
  const rest = requestPath.split(/[?#]/)[0].split("/").filter(Boolean).slice(baseSegments).join("/");
  const toBase = rule.toUrl.slice(0, -2);
  return rest ? `${toBase}/${rest}` : toBase || "/";
}

export type ChainWalk = RedirectChain & { ids: string[] };

/** Follows a redirect through any that come after it (at most `maxSteps`), and says where a visitor ends up. */
export function followChain<R extends RuleLike>(index: RuleIndex<R>, start: R, maxSteps = 10): ChainWalk {
  const startPath = start.match === "PREFIX" && start.fromPath.endsWith("/*") ? start.fromPath.slice(0, -2) || "/" : start.fromPath;
  const through = [startPath];
  const ids = [start.id];
  let target = targetFor(start, startPath);
  let loop = false;
  for (let step = 0; step < maxSteps; step++) {
    const path = internalPathOf(target);
    if (path === null) break;
    const key = normalisePath(path);
    const next = key ? findRule(index, key) : null;
    if (!key || !next) break;
    through.push(key);
    if (ids.includes(next.id)) {
      loop = true;
      break;
    }
    ids.push(next.id);
    target = targetFor(next, path);
  }
  return { hops: ids.length, final: target, loop, through, ids };
}

/**
 * Which of the `focus` redirects would take part in a loop or a chain of more than three: an id →
 * why, for each. Every chain through one of them counts — from a redirect before it too.
 */
export function chainProblems<R extends RuleLike>(rules: readonly R[], focus: ReadonlySet<string>, maxHops = MAX_REDIRECT_HOPS): Map<string, string> {
  const problems = new Map<string, string>();
  if (!focus.size) return problems;
  const index = indexRules(rules);
  for (const rule of rules) {
    const walk = followChain(index, rule);
    if (!walk.loop && walk.hops <= maxHops) continue;
    const involved = walk.ids.filter((id) => focus.has(id));
    if (!involved.length) continue;
    const message = walk.loop
      ? `That would make a loop: ${walk.through.join(" → ")}.`
      : `That would make a chain of ${walk.hops} redirects (${[...walk.through, walk.final].join(" → ")}); at most ${maxHops} in a row. Point ${walk.through[0]} straight at ${walk.final}.`;
    for (const id of involved) if (!problems.has(id)) problems.set(id, message);
  }
  return problems;
}
