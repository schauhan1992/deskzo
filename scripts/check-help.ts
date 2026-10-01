/**
 * The header search, the dashboard's welcome band and tabs, the helpline, the rail's help panels and
 * What's new — src/lib/search, src/lib/help, src/actions/search.ts, src/actions/help.ts.
 *
 *   · Without a database: which links may be saved (https or an in-app path, nothing else), YouTube
 *     ids, the "Open LEAD-000123" shortcut, the Getting Started steps and their progress, and that
 *     every search scope names a real module, permission, list page and detail page.
 *   · Through the real code, as probe users: search finds what the person's own list would and
 *     nothing else; a scope they may not use is neither offered nor answered; the helpline and
 *     What's new refuse anybody without `help.manage`, check every link, audit every change;
 *     scheduled posts stay hidden until due; unread counts start from when somebody joined; opening
 *     What's new while viewing as somebody leaves their dot alone; and the dashboard renders each tab.
 *
 * Everything it creates is marked Zzhelp and removed in a `finally`; the helpline row is put back
 * exactly as it was found.
 *
 *   npm run check:help
 */
import "dotenv/config";
import Module from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { type HelpDesk } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { checkLink, youtubeId, LINK_MAX } from "../src/lib/help/links";
import { gettingStartedSteps, progressOf, type GettingStartedFacts } from "../src/lib/help/getting-started";
import { SEARCH_SCOPES, refShortcut, searchListHref, searchScope } from "../src/lib/search/scopes";
import { istDateTimeInput } from "../src/lib/india-time";

const db = directClient();
const MAIL = "@zzprobe-help.invalid";
const TAG = "Zzhelp";

let actor: { id: string; name: string; email: string; role: string } | null = null;
let viewingAs = false;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const substitutes = new Map<string, unknown>([
  [
    load.resolve("../src/lib/session"),
    {
      requireUser: async () => {
        if (!actor) throw new Error("The check called an action without saying who was calling it.");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => (viewingAs ? { user: actor, actor } : null),
      refuseWhileViewingAs: async () => null,
    },
  ],
  [load.resolve("next/cache"), { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }],
  [
    load.resolve("next/navigation"),
    {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/dashboard",
    },
  ],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const facts = (over: Partial<GettingStartedFacts> = {}): GettingStartedFacts => ({
  admin: false,
  helpManager: false,
  itemsModule: true,
  organisationReady: false,
  hasLogo: false,
  activeUsers: 1,
  itemCount: 0,
  helplineSet: false,
  hasPhoto: false,
  hasTwoFactor: false,
  ...over,
});

let deskBefore: HelpDesk | null = null;

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.announcement.deleteMany({ where: { OR: [{ createdById: { in: ids } }, { title: { startsWith: TAG } }] } });
  await db.helpLink.deleteMany({ where: { OR: [{ createdById: { in: ids } }, { title: { startsWith: TAG } }] } });
  await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function restoreDesk() {
  if (deskBefore) {
    const { id, ...rest } = deskBefore;
    await db.helpDesk.upsert({ where: { id }, create: deskBefore, update: rest });
  } else {
    await db.helpDesk.deleteMany({ where: { id: "global" } });
  }
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("Which links may be saved");

  ok("an https address is accepted, trimmed", (() => {
    const r = checkLink("  https://learn.example.com/guide  ");
    return r.ok && r.url === "https://learn.example.com/guide" && r.external;
  })());
  ok("a path in the app is accepted and is not external", (() => {
    const r = checkLink("/orders/new");
    return r.ok && r.url === "/orders/new" && !r.external;
  })());
  for (const [label, url] of [
    ["plain http", "http://example.com"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["a protocol-relative address", "//evil.example.com/x"],
    ["a backslash-relative address", "/\\evil.example.com"],
    ["an address with a username and password", "https://user:pass@example.com/"],
    ["an empty link", "   "],
    ["words, not a link", "our help page"],
  ] as const) {
    ok(`${label} is refused`, !checkLink(url).ok);
  }
  ok("an over-long link is refused", !checkLink(`https://example.com/${"a".repeat(LINK_MAX)}`).ok);

  ok("a YouTube watch link gives its id", youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10") === "dQw4w9WgXcQ");
  ok("a youtu.be link gives its id", youtubeId("https://youtu.be/dQw4w9WgXcQ?si=abc") === "dQw4w9WgXcQ");
  ok("a Shorts link gives its id", youtubeId("https://m.youtube.com/shorts/dQw4w9WgXcQ") === "dQw4w9WgXcQ");
  ok("an embed link gives its id", youtubeId("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ") === "dQw4w9WgXcQ");
  ok("another site has no YouTube id", youtubeId("https://vimeo.com/123456") === null);
  ok("a malformed id is not trusted into an image URL", youtubeId("https://youtu.be/../../x") === null);

  // ─────────────────────────────────────────────────────────────────────────────
  section("The search scopes and the ref shortcut");

  const leads = searchScope("leads")!;
  const orders = searchScope("orders")!;
  const contacts = searchScope("contacts")!;
  ok("LEAD-000123 in Leads opens that lead", refShortcut(leads, "LEAD-000123")?.href === "/leads/LEAD-000123");
  ok("a lower-case, unpadded ref works too", refShortcut(leads, "lead-5")?.href === "/leads/LEAD-000005");
  ok("a bare number in Orders opens that order", refShortcut(orders, " 42 ")?.href === "/orders/ORD-000042");
  ok("another list's prefix is not offered", refShortcut(leads, "ORD-000042") === null);
  ok("a list without readable refs offers none", refShortcut(contacts, "123") === null);
  ok("zero is not a record", refShortcut(orders, "0") === null);
  ok("a name is not a ref", refShortcut(orders, "acme") === null);
  ok("the list link carries the text, encoded", searchListHref(searchScope("customers")!, " A&B Traders ") === "/customers?q=A%26B%20Traders");

  const { MODULE_REGISTRY } = load("../src/lib/modules") as typeof import("../src/lib/modules");
  const { PERMISSION_REGISTRY } = load("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const app = path.join(__dirname, "..", "src", "app", "(dashboard)");
  const moduleKeys = new Set(MODULE_REGISTRY.map((m) => m.key));
  const permissionKeys = new Set(PERMISSION_REGISTRY.map((p) => p.key as string));
  const badModule = SEARCH_SCOPES.filter((s) => !moduleKeys.has(s.module)).map((s) => s.key);
  const badPermission = SEARCH_SCOPES.filter((s) => s.permission && !permissionKeys.has(s.permission)).map((s) => s.key);
  const noList = SEARCH_SCOPES.filter((s) => !existsSync(path.join(app, ...s.listPath.split("/").filter(Boolean), "page.tsx"))).map((s) => s.key);
  const noDetail = SEARCH_SCOPES.filter((s) => s.ref && !existsSync(path.join(app, ...s.ref.path.split("/").filter(Boolean), "[id]", "page.tsx"))).map((s) => s.key);
  ok("every scope's module exists", badModule.length === 0, badModule.join(", "));
  ok("every scope's extra permission exists", badPermission.length === 0, badPermission.join(", "));
  ok("every scope's list page exists", noList.length === 0, noList.join(", "));
  ok("every ref shortcut lands on a detail page", noDetail.length === 0, noDetail.join(", "));
  // "See all results" is only honest if the list page reads the same text back.
  const ignoresQ = SEARCH_SCOPES.filter((s) => {
    const dir = path.join(app, ...s.listPath.split("/").filter(Boolean));
    const page = readFileSync(path.join(dir, "page.tsx"), "utf8");
    // A page may hand its search params to a shared list (the trade documents do), so the components
    // it imports are read too.
    const imported = [...page.matchAll(/from "@\/components\/([^"]+)"/g)]
      .map((m) => path.join(__dirname, "..", "src", "components", `${m[1]}.tsx`))
      .filter(existsSync)
      .map((f) => readFileSync(f, "utf8"));
    return ![page, ...imported].some((src) => /\bq\b/.test(src));
  }).map((s) => s.key);
  ok("every list page reads ?q=", ignoresQ.length === 0, ignoresQ.join(", "));

  // ─────────────────────────────────────────────────────────────────────────────
  section("Getting started");

  const plain = gettingStartedSteps(facts());
  ok("somebody without admin rights sees only their own steps", plain.every((s) => s.group === "you") && plain.length === 2, plain.map((s) => s.key).join(","));
  const admin = gettingStartedSteps(facts({ admin: true }));
  ok("an admin also sees the company steps", ["organisation", "logo", "team", "items"].every((k) => admin.some((s) => s.key === k)));
  ok("with Items switched off, 'add what you sell' is not offered", !gettingStartedSteps(facts({ admin: true, itemsModule: false })).some((s) => s.key === "items"));
  // A company step since onboarding (1 Oct 2026): for somebody setting the company up who may also change help.
  ok("the help step is a company step, for settings.manage with help.manage", gettingStartedSteps(facts({ admin: true, helpManager: true })).some((s) => s.key === "helpline" && s.group === "company") && !gettingStartedSteps(facts({ helpManager: true })).some((s) => s.key === "helpline") && !admin.some((s) => s.key === "helpline"));
  const doneAll = gettingStartedSteps(
    facts({ admin: true, helpManager: true, organisationReady: true, hasLogo: true, activeUsers: 5, itemCount: 3, helplineSet: true, hasPhoto: true, hasTwoFactor: true }),
  );
  ok("every step is ticked by its data", doneAll.every((s) => s.done));
  ok("one person alone has not brought in a team", !admin.find((s) => s.key === "team")!.done);
  const half = progressOf(gettingStartedSteps(facts({ hasPhoto: true })));
  ok("progress counts what is done", half.done === 1 && half.total === 2 && half.percent === 50, JSON.stringify(half));
  ok("nothing to do is 100%", progressOf([]).percent === 100);

  // ─────────────────────────────────────────────────────────────────────────────
  section("Through the real code");

  await cleanup();
  deskBefore = await db.helpDesk.findUnique({ where: { id: "global" } });
  try {
    const mk = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `${TAG} ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: "ZZHELP" })) },
        },
      });
    const manager = await mk("Manager", { "help.manage": true, "companies.viewAll": true });
    const seller = await mk("Seller", { "leads.view": false });
    const other = await mk("Other", {});
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = { id: u.id, name: u.name, email: u.email, role: u.role };
    };

    const { searchRecords, searchScopesForMe } = load("../src/actions/search") as typeof import("../src/actions/search");
    const help = load("../src/actions/help") as typeof import("../src/actions/help");

    // Two companies, one each, both matching the same text.
    const company = (name: string, ownerId: string) =>
      db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: ownerId, ownerUserId: ownerId, assignedToUserId: ownerId },
      });
    const alpha = await company("Alpha Traders", seller.id);
    const beta = await company("Beta Traders", other.id);

    // Search, as the list would.
    as(seller);
    const mine = await searchRecords("companies", `${TAG} `);
    const mineIds = mine.ok ? mine.hits.map((h) => h.id) : [];
    ok("a salesperson finds their own company", mineIds.includes(alpha.id), JSON.stringify(mine));
    ok("…and not somebody else's", !mineIds.includes(beta.id));
    ok("a hit opens the company page", mine.ok && mine.hits.find((h) => h.id === alpha.id)?.href === `/companies/${alpha.id}`);
    as(other);
    const theirs = await searchRecords("companies", TAG);
    ok("the other salesperson sees the reverse", theirs.ok && theirs.hits.some((h) => h.id === beta.id) && !theirs.hits.some((h) => h.id === alpha.id));
    as(manager);
    const all = await searchRecords("companies", TAG);
    ok("companies.viewAll finds both", all.ok && [alpha.id, beta.id].every((id) => all.hits.some((h) => h.id === id)));

    as(seller);
    const short = await searchRecords("companies", "z");
    ok("one letter is not searched", short.ok && short.hits.length === 0);
    ok("an unknown scope is refused", !(await searchRecords("everything", "acme")).ok);
    const scopes = await searchScopesForMe();
    ok("the box offers Companies", scopes.some((s) => s.key === "companies"));
    ok("a list they may not open is not offered", !scopes.some((s) => s.key === "leads"), scopes.map((s) => s.key).join(","));
    ok("…and not answered if asked for anyway", !(await searchRecords("leads", TAG)).ok);

    // The helpline.
    as(seller);
    ok("without help.manage the helpline can't be changed", !(await help.saveHelpDesk({ phone: "1800 000 0000" })).ok);
    as(manager);
    ok("a bad phone number is refused", !(await help.saveHelpDesk({ phone: "call us!" })).ok);
    ok("a bad email is refused", !(await help.saveHelpDesk({ email: "support at wroffy" })).ok);
    const saved = await help.saveHelpDesk({ label: `${TAG} Support`, phone: "+91 1800 123 4567", hours: "Mon – Fri", languages: "English, हिन्दी", email: "help@zz.invalid" });
    ok("help.manage can set it", saved.ok, JSON.stringify(saved));
    as(seller);
    const desk = await help.getHelpDesk();
    ok("everybody can read it", desk?.phone === "+91 1800 123 4567" && desk?.languages === "English, हिन्दी", JSON.stringify(desk));
    as(manager);
    await help.saveHelpDesk({ label: "", phone: "", email: "" });
    ok("with no number and no email nothing is shown", (await help.getHelpDesk()) === null);
    ok("changing it is audited", (await db.auditLog.count({ where: { userId: manager.id, entityType: "HelpDesk" } })) === 2);

    // Help links.
    as(seller);
    ok("without help.manage a link can't be added", !(await help.saveHelpLink({ kind: "ARTICLE", title: `${TAG} x`, url: "https://example.com" })).ok);
    as(manager);
    ok("a javascript: link is refused on save", !(await help.saveHelpLink({ kind: "ARTICLE", title: `${TAG} bad`, url: "javascript:alert(1)" })).ok);
    const article = await help.saveHelpLink({ kind: "ARTICLE", title: `${TAG} Punching an order`, url: "/orders/new", sortOrder: 2 });
    const video = await help.saveHelpLink({ kind: "VIDEO", title: `${TAG} Renewals tour`, url: "https://youtu.be/dQw4w9WgXcQ" });
    const hidden = await help.saveHelpLink({ kind: "ARTICLE", title: `${TAG} Draft guide`, url: "https://example.com/draft", active: false });
    ok("help.manage can add articles and videos", article.ok && video.ok && hidden.ok);
    as(seller);
    const articles = (await help.listHelpLinks("ARTICLE")).filter((l) => l.title.startsWith(TAG));
    const videos = (await help.listHelpLinks("VIDEO")).filter((l) => l.title.startsWith(TAG));
    ok("the rail lists live articles, not hidden ones", articles.length === 1 && articles[0].title.endsWith("Punching an order") && !articles[0].external);
    ok("a YouTube video carries its thumbnail id", videos.length === 1 && videos[0].youtubeId === "dQw4w9WgXcQ" && videos[0].external);
    ok("the management list is refused without help.manage", (await help.listHelpLinksForManage()) === null);
    as(manager);
    ok("…and includes hidden links with it", ((await help.listHelpLinksForManage()) ?? []).some((l) => l.title.endsWith("Draft guide") && !l.active));
    if (hidden.ok) await help.deleteHelpLink(hidden.data.id);
    ok("a link can be removed", !(await db.helpLink.findFirst({ where: { title: `${TAG} Draft guide` } })));

    // What's new.
    as(seller);
    const before = await help.unreadUpdateCount();
    ok("somebody who just joined has nothing unread", before === 0, before);
    ok("without help.manage nothing can be posted", !(await help.saveUpdate({ title: `${TAG} x`, body: "x" })).ok);
    as(manager);
    ok("a post needs a body", !(await help.saveUpdate({ title: `${TAG} empty`, body: "  " })).ok);
    ok("a post's link is checked too", !(await help.saveUpdate({ title: `${TAG} bad link`, body: "x", linkUrl: "http://example.com" })).ok);
    // Published an hour before the seller's account existed: they joined after it, so it is not news.
    const old = await help.saveUpdate({ title: `${TAG} Old news`, body: "Before your time.", publishAt: istDateTimeInput(new Date(seller.createdAt.getTime() - 3_600_000)) });
    const fresh = await help.saveUpdate({ title: `${TAG} Fresh news`, body: "Renewals now remind 90 days ahead.", linkUrl: "/renewals" });
    const pinned = await help.saveUpdate({ title: `${TAG} Pinned`, body: "Read this first.", pinned: true, linkUrl: "https://example.com/policy" });
    const later = await help.saveUpdate({ title: `${TAG} Not yet`, body: "Coming soon.", publishAt: istDateTimeInput(new Date(Date.now() + 2 * 86_400_000)) });
    ok("help.manage can post, now and for later", old.ok && fresh.ok && pinned.ok && later.ok);

    as(seller);
    const feed = (await help.listUpdates()).filter((p) => p.title.startsWith(TAG));
    ok("a scheduled post stays hidden until it is due", !feed.some((p) => p.title.endsWith("Not yet")));
    ok("a pinned post comes first", feed[0]?.title.endsWith("Pinned"), feed.map((p) => p.title).join(" | "));
    ok("posts made after they joined are unread", feed.filter((p) => p.unread).map((p) => p.title.replace(`${TAG} `, "")).sort().join(",") === "Fresh news,Pinned");
    ok("a post from before they joined is not", feed.find((p) => p.title.endsWith("Old news"))?.unread === false);
    ok("an external read-more is marked external", feed.find((p) => p.title.endsWith("Pinned"))?.external === true && feed.find((p) => p.title.endsWith("Fresh news"))?.external === false);
    ok("the dot counts the unread ones", (await help.unreadUpdateCount()) === 2);

    viewingAs = true;
    await help.markUpdatesSeen();
    viewingAs = false;
    ok("opening What's new while viewing as them leaves their dot alone", (await help.unreadUpdateCount()) === 2);
    await help.markUpdatesSeen();
    ok("opening it themselves clears it", (await help.unreadUpdateCount()) === 0);

    as(manager);
    const managed = await help.listUpdatesForManage();
    ok("the management list shows the scheduled post, marked scheduled", !!managed?.posts.find((p) => p.title.endsWith("Not yet"))?.scheduled);
    if (later.ok) await help.deleteUpdate(later.data.id);
    ok("a post can be removed", !(await db.announcement.findFirst({ where: { title: `${TAG} Not yet` } })));
    ok("posts are audited", (await db.auditLog.count({ where: { userId: manager.id, entityType: "Announcement" } })) === 5);

    // Getting started, with real facts.
    as(seller);
    const sellerSteps = await help.getGettingStarted();
    ok("a salesperson's checklist is about them", sellerSteps.map((s) => s.key).join(",") === "photo,two-factor", sellerSteps.map((s) => s.key).join(","));
    as(manager);
    ok("help.manage alone adds no company step — the help step is the company's", !(await help.getGettingStarted()).some((s) => s.group === "company"));

    // ─────────────────────────────────────────────────────────────────────────
    section("What renders");

    const React = load("react") as typeof import("react");
    const { renderToStaticMarkup } = load("react-dom/server") as typeof import("react-dom/server");
    const render = (el: unknown) => renderToStaticMarkup(el as ReactElement);

    const { IconPattern } = load("../src/components/layout/icon-pattern") as typeof import("../src/components/layout/icon-pattern");
    const twoPatterns = render(React.createElement("div", null, React.createElement(IconPattern), React.createElement(IconPattern)));
    const ids = [...twoPatterns.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]);
    ok("the pattern is hidden from assistive technology", twoPatterns.includes('aria-hidden="true"'));
    ok("two patterns on one page don't share an id", ids.length === 2 && ids[0] !== ids[1], ids.join(" "));
    ok("the pattern is drawn from icons", (twoPatterns.match(/<svg/g) ?? []).length > 40);

    const { WelcomeHeader } = load("../src/components/dashboard/welcome-header") as typeof import("../src/components/dashboard/welcome-header");
    const band = render(
      React.createElement(WelcomeHeader, {
        greeting: "Good morning, Sachin",
        moments: [],
        companyName: "Wroffy Technologies Private Limited",
        logoDataUrl: null,
        helpDesk: { label: "Support", phone: "+91 1800-572 6671", hours: "Mon – Fri", languages: null, email: null },
        tabs: [
          { key: "overview", label: "Dashboard" },
          { key: "getting-started", label: "Getting Started" },
          { key: "updates", label: "Recent Updates", badge: 12 },
        ],
        activeTab: "overview",
      }),
    );
    ok("the band greets and names the company", band.includes("Good morning, Sachin") && band.includes("Wroffy Technologies Private Limited"));
    ok("without a logo it shows initials", band.includes(">WT<"));
    ok("the helpline dials the digits only", band.includes('href="tel:+9118005726671"'));
    ok("the first tab is the plain dashboard, the others say which", band.includes('href="/dashboard"') && band.includes('href="/dashboard?tab=updates"'));
    ok("the active tab is marked current", /aria-current="page"[^>]*>Dashboard/.test(band));
    ok("a big unread count reads 9+", band.includes("9+"));

    const { RecentUpdates } = load("../src/components/help/recent-updates") as typeof import("../src/components/help/recent-updates");
    const updatesHtml = render(React.createElement(RecentUpdates, { posts: feed, canManage: false }));
    ok("an external read-more opens safely in a new tab", /href="https:\/\/example\.com\/policy"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/.test(updatesHtml));
    ok("an in-app read-more stays in the app", updatesHtml.includes('href="/renewals"'));
    ok("somebody who can't post isn't offered to", !updatesHtml.includes("Post an update"));

    const { HeaderSearch } = load("../src/components/layout/header-search") as typeof import("../src/components/layout/header-search");
    as(seller);
    const searchHtml = render(React.createElement(HeaderSearch, { scopes: await searchScopesForMe() }));
    ok("the box names what it searches and the shortcut", searchHtml.includes("Search in Customers ( / )") || searchHtml.includes("Search in Companies ( / )"), searchHtml.slice(0, 200));
    ok("the scope picker is a real, labelled select", searchHtml.includes('aria-label="Search in"') && searchHtml.includes("<select"));
    ok("the field is a combobox", searchHtml.includes('role="combobox"'));

    const Dashboard = (load("../src/app/(dashboard)/dashboard/page") as { default: (p: { searchParams: Promise<{ tab?: string }> }) => Promise<unknown> }).default;
    const onUpdates = render(await Dashboard({ searchParams: Promise.resolve({ tab: "updates" }) }));
    ok("the Recent Updates tab renders the posts under the band", onUpdates.includes("Fresh news") && onUpdates.includes("Recent Updates") && onUpdates.includes("<pattern"));
    const onStart = render(await Dashboard({ searchParams: Promise.resolve({ tab: "getting-started" }) }));
    ok("the Getting Started tab renders the checklist", onStart.includes("Add your photo") && onStart.includes('role="progressbar"'));
    const onBogus = render(await Dashboard({ searchParams: Promise.resolve({ tab: "../../etc" }) }));
    // The probe is new, so still being onboarded: its first tab is Getting Started (src/lib/help/onboarding.ts, check:onboarding).
    ok("an unknown tab falls back to the first tab — Getting Started, for somebody still setting up", /aria-current="page"[^>]*>Getting Started/.test(onBogus));

    const HelpPage = (load("../src/app/(dashboard)/settings/help/page") as { default: () => Promise<unknown> }).default;
    ok("the help settings page turns away somebody without help.manage", render(await HelpPage()).includes("Only somebody who can manage help"));
    as(manager);
    const helpPage = render(await HelpPage());
    // The support contact is the platform's now (console Settings → Support): no helpline form here.
    ok("…and shows the help links to somebody with it, saying the support contact is the platform's — no helpline form", helpPage.includes("comes from the platform") && !helpPage.includes("Save helpline"));
  } finally {
    actor = null;
    await cleanup();
    await restoreDesk();
    const after = await db.helpDesk.findUnique({ where: { id: "global" } });
    ok("the helpline row is exactly as it was found", JSON.stringify(after) === JSON.stringify(deskBefore));
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll help checks passed.");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  await restoreDesk().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
