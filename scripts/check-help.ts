/**
 * The header search, the dashboard's welcome band and tabs, the helpline, the rail's help panels and
 * What's new — src/lib/search, src/lib/help, src/actions/search.ts, src/actions/help.ts.
 *
 * Help and What's new come from two sources, always shown apart (owner, 2 Oct 2026): Deskzo's,
 * published in the platform console and read-only in a workspace, and the company's own guides and
 * news, written under `help.manage`.
 *
 *   · Without a database: which links may be saved (https or an in-app path, nothing else), YouTube
 *     ids, the "Open LEAD-000123" shortcut, the Getting Started steps and their progress — the help
 *     step optional and the company's own — and that every search scope names a real module,
 *     permission, list page and detail page.
 *   · Through the real code, as probe users: search finds what the person's own list would and
 *     nothing else; a scope they may not use is neither offered nor answered; the helpline and the
 *     company's guides and news refuse anybody without `help.manage`, check every link, audit every
 *     change; scheduled posts stay hidden until due; unread counts start from when somebody joined;
 *     opening What's new while viewing as somebody leaves their dot alone.
 *   · Deskzo's side through the same actions, with its rows handed in (the loader's own test hook,
 *     src/lib/platform/help-content.ts — nothing is written to the control plane): its lists never
 *     hold a company row nor the company's a Deskzo one, the two unread counts move independently,
 *     Deskzo's line moves to the newest post shown — never to now, never back, and never on a read
 *     that failed or showed nothing.
 *   · Renders: the two groups of every rail panel and both What's new feeds, each under its own
 *     heading with its own empty state; only the company's offers to add, and only to a manager.
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
import { indiaClock } from "../src/lib/time/zone";

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

/**
 * Deskzo's side, as src/actions/help.ts reads it: the real `deskzoContentFor`, with its rows either
 * read from the control plane ("real"), refused as a control plane that is down ("down"), or handed in
 * ("rows") through the loader's own test hook — which never caches what it is given. The workspace is
 * read as a control-plane one, so the rows are filtered exactly as a customer's would be.
 */
type HelpContentModule = typeof import("../src/lib/platform/help-content");
let deskzoSource: { kind: "real" } | { kind: "down" } | { kind: "rows"; rows: import("../src/lib/platform/help-content").PlatformHelpRows } = { kind: "real" };
const helpContentFile = load.resolve("../src/lib/platform/help-content");
let helpContentStub: HelpContentModule | null = null;

internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  if (resolved === helpContentFile) {
    if (!helpContentStub) {
      const real = realLoad.call(this, request, parent, isMain) as HelpContentModule;
      helpContentStub = {
        ...real,
        deskzoContentFor: (tenant, now, loader) => {
          const source = deskzoSource;
          if (source.kind === "real") return real.deskzoContentFor(tenant, now, loader);
          const asControl = { ...tenant, source: "control" as const };
          if (source.kind === "down") return real.deskzoContentFor(asControl, now, async () => Promise.reject(new Error("check:help — the control plane is down")));
          return real.deskzoContentFor(asControl, now, async () => source.rows);
        },
      };
    }
    return helpContentStub;
  }
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
    // A browser drops a tab or a line break from an address before reading it, and reads a backslash as "/".
    ["a path with a tab in it", "/\t/evil.example.com"],
    ["a path with a line break in it", "/\n/evil.example.com"],
    ["a path with a backslash inside it", "/help\\evil.example.com"],
    ["a path with a space in it", "/orders/new list"],
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
  // Since 2 Oct 2026 Deskzo's help is in every workspace: the step is the company's own guides, optional.
  const helpStep = gettingStartedSteps(facts({ admin: true, helpManager: true })).find((s) => s.key === "helpline")!;
  ok(
    "  it is the company's own guides, optional — skippable, never required — and says Deskzo's help is already there",
    helpStep.title === "Add your company's own guides" && !helpStep.required && helpStep.skippable && /^Optional/.test(helpStep.description) && helpStep.description.includes("Deskzo's help") && helpStep.where === "Settings → Your company's guides",
    JSON.stringify(helpStep),
  );
  const skippedHelp = gettingStartedSteps(facts({ admin: true, helpManager: true, companySkipped: ["helpline"] })).find((s) => s.key === "helpline")!;
  ok("  skipped, with no guide added, it is finished", skippedHelp.finished && skippedHelp.skipped && !skippedHelp.done);
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
    ok("a bad email is refused", !(await help.saveHelpDesk({ email: "support at acme" })).ok);
    const saved = await help.saveHelpDesk({ label: `${TAG} Support`, phone: "+91 1800 123 4567", hours: "Mon – Fri", languages: "English, हिन्दी", email: "help@zz.invalid" });
    ok("help.manage can set it", saved.ok, JSON.stringify(saved));
    as(seller);
    const desk = await help.getHelpDesk();
    ok("everybody can read it", desk?.phone === "+91 1800 123 4567" && desk?.languages === "English, हिन्दी", JSON.stringify(desk));
    as(manager);
    await help.saveHelpDesk({ label: "", phone: "", email: "" });
    ok("with no number and no email nothing is shown", (await help.getHelpDesk()) === null);
    ok("changing it is audited", (await db.auditLog.count({ where: { userId: manager.id, entityType: "HelpDesk" } })) === 2);

    // The company's own guides: articles and videos.
    as(seller);
    ok("without help.manage a company guide can't be added", !(await help.saveHelpLink({ kind: "ARTICLE", title: `${TAG} x`, url: "https://example.com" })).ok);
    as(manager);
    ok("a javascript: link is refused on save", !(await help.saveHelpLink({ kind: "ARTICLE", title: `${TAG} bad`, url: "javascript:alert(1)" })).ok);
    const article = await help.saveHelpLink({ kind: "ARTICLE", title: `${TAG} Punching an order`, url: "/orders/new", sortOrder: 2 });
    const video = await help.saveHelpLink({ kind: "VIDEO", title: `${TAG} Renewals tour`, url: "https://youtu.be/dQw4w9WgXcQ" });
    const hidden = await help.saveHelpLink({ kind: "ARTICLE", title: `${TAG} Draft guide`, url: "https://example.com/draft", active: false });
    ok("help.manage can add the company's own articles and videos", article.ok && video.ok && hidden.ok);
    as(seller);
    const articles = (await help.listHelpLinks("ARTICLE")).filter((l) => l.title.startsWith(TAG));
    const videos = (await help.listHelpLinks("VIDEO")).filter((l) => l.title.startsWith(TAG));
    ok("the rail lists the company's live articles, not hidden ones", articles.length === 1 && articles[0].title.endsWith("Punching an order") && !articles[0].external);
    ok("a YouTube video carries its thumbnail id", videos.length === 1 && videos[0].youtubeId === "dQw4w9WgXcQ" && videos[0].external);
    ok("the management list is refused without help.manage", (await help.listHelpLinksForManage()) === null);
    as(manager);
    ok("…and includes hidden links with it", ((await help.listHelpLinksForManage()) ?? []).some((l) => l.title.endsWith("Draft guide") && !l.active));
    if (hidden.ok) await help.deleteHelpLink(hidden.data.id);
    ok("a link can be removed", !(await db.helpLink.findFirst({ where: { title: `${TAG} Draft guide` } })));
    // Saved before the rule refused it: a path with a tab in it, which a browser opens as another site.
    const tabbed = await db.helpLink.create({ data: { kind: "ARTICLE", title: `${TAG} Tabbed guide`, url: "/\t/evil.example.com", createdById: manager.id }, select: { id: true } });
    as(seller);
    ok("a stored link the rule now refuses is left out of the rail — never an href", !(await help.listHelpLinks("ARTICLE")).some((l) => l.title.endsWith("Tabbed guide")));
    as(manager);
    ok("  the management list still shows it, to be put right or removed", ((await help.listHelpLinksForManage()) ?? []).some((l) => l.title.endsWith("Tabbed guide")));
    await db.helpLink.delete({ where: { id: tabbed.id } });

    // What's new.
    as(seller);
    const before = await help.unreadUpdateCount();
    ok("somebody who just joined has nothing unread", before === 0, before);
    ok("without help.manage nothing can be posted", !(await help.saveUpdate({ title: `${TAG} x`, body: "x" })).ok);
    as(manager);
    ok("a post needs a body", !(await help.saveUpdate({ title: `${TAG} empty`, body: "  " })).ok);
    ok("a post's link is checked too", !(await help.saveUpdate({ title: `${TAG} bad link`, body: "x", linkUrl: "http://example.com" })).ok);
    // Published an hour before the seller's account existed: they joined after it, so it is not news.
    // Typed on the workspace's clock, which is India's here.
    const old = await help.saveUpdate({ title: `${TAG} Old news`, body: "Before your time.", publishAt: indiaClock.input(new Date(seller.createdAt.getTime() - 3_600_000)) });
    const fresh = await help.saveUpdate({ title: `${TAG} Fresh news`, body: "Renewals now remind 90 days ahead.", linkUrl: "/renewals" });
    const pinned = await help.saveUpdate({ title: `${TAG} Pinned`, body: "Read this first.", pinned: true, linkUrl: "https://example.com/policy" });
    const later = await help.saveUpdate({ title: `${TAG} Not yet`, body: "Coming soon.", publishAt: indiaClock.input(new Date(Date.now() + 2 * 86_400_000)) });
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
    // A "read more" saved before the rule refused it is dropped on the way out; the post still shows.
    const tabbedPost = await db.announcement.create({ data: { title: `${TAG} Tabbed news`, body: "Still news.", linkUrl: "/\n/evil.example.com", createdById: manager.id }, select: { id: true } });
    const tabbedShown = (await help.listUpdates(100)).find((p) => p.id === tabbedPost.id);
    ok("a stored read-more the rule now refuses is dropped — the post is still shown", !!tabbedShown && tabbedShown.linkUrl === null && !tabbedShown.external, JSON.stringify(tabbedShown));
    await db.announcement.delete({ where: { id: tabbedPost.id } });

    // ─────────────────────────────────────────────────────────────────────────
    section("From Deskzo — read-only, and never mixed with the company's");

    const { controlConfigured } = load("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    // Filled in below when there is a control plane to read as: the renders use them.
    let dzFeed: Awaited<ReturnType<typeof help.deskzoUpdates>> = { ok: true, posts: [] };
    let dzArticles: Awaited<ReturnType<typeof help.deskzoHelpLinks>> = { ok: true, links: [] };
    let dzVideos: Awaited<ReturnType<typeof help.deskzoHelpLinks>> = { ok: true, links: [] };
    if (!controlConfigured()) {
      ok("(no control plane here: a workspace is shown nothing from Deskzo — the rest is covered by check:help-content)", true);
    } else {
      // Somebody who joined two hours ago, so Deskzo's posts can fall either side of it without waiting.
      const reader = await mk("Reader", {});
      const t0 = Date.now() - 2 * 3_600_000;
      await db.user.update({ where: { id: reader.id }, data: { createdAt: new Date(t0) } });
      const at = (ms: number) => new Date(t0 + ms);
      const MIN = 60_000;
      const everybody = { modules: [] as string[], countries: [] as string[], archivedAt: null as Date | null };
      const rows: import("../src/lib/platform/help-content").PlatformHelpRows = {
        links: [
          { ...everybody, id: "zzhelp-dz-article", kind: "ARTICLE", title: "Zzdz Raising a quote", url: "/proposals/new", description: "How Deskzo does it", sortOrder: 1, publishedAt: at(-1440 * MIN) },
          { ...everybody, id: "zzhelp-dz-video", kind: "VIDEO", title: "Zzdz Orders walkthrough", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", description: null, sortOrder: 2, publishedAt: at(-1440 * MIN) },
          { ...everybody, id: "zzhelp-dz-offsite", kind: "ARTICLE", title: "Zzdz Off-site", url: "https://evil.example.com/guide", description: null, sortOrder: 3, publishedAt: at(-1440 * MIN) },
          { ...everybody, id: "zzhelp-dz-draft", kind: "ARTICLE", title: "Zzdz Draft", url: "/dashboard", description: null, sortOrder: 0, publishedAt: null },
        ],
        updates: [
          { ...everybody, id: "zzhelp-dz-old", title: "Zzdz Before you joined", body: "Old.", linkUrl: null, pinned: false, publishedAt: at(-60 * MIN) },
          { ...everybody, id: "zzhelp-dz-badlink", title: "Zzdz Bad link", body: "Kept, its link dropped.", linkUrl: "https://evil.example.com/notes", pinned: false, publishedAt: at(5 * MIN) },
          { ...everybody, id: "zzhelp-dz-pinned", title: "Zzdz Pinned", body: "Read this first.", linkUrl: null, pinned: true, publishedAt: at(10 * MIN) },
          { ...everybody, id: "zzhelp-dz-archived", title: "Zzdz Archived", body: "Gone.", linkUrl: null, pinned: false, publishedAt: at(20 * MIN), archivedAt: at(25 * MIN) },
          { ...everybody, id: "zzhelp-dz-one", title: "Zzdz Release one", body: "One.", linkUrl: "https://deskzo.com/notes/1", pinned: false, publishedAt: at(30 * MIN) },
          { ...everybody, id: "zzhelp-dz-two", title: "Zzdz Release two", body: "Two.", linkUrl: "/renewals", pinned: false, publishedAt: at(60 * MIN) },
          { ...everybody, id: "zzhelp-dz-later", title: "Zzdz Scheduled", body: "Not yet.", linkUrl: null, pinned: false, publishedAt: new Date(Date.now() + 86_400_000) },
        ],
      };
      const line = () => db.user.findUniqueOrThrow({ where: { id: reader.id }, select: { deskzoUpdatesSeenAt: true, updatesSeenAt: true } });
      const iso = (d: Date | null) => d?.toISOString() ?? null;
      try {
        deskzoSource = { kind: "rows", rows };
        as(reader);
        dzArticles = await help.deskzoHelpLinks("ARTICLE");
        dzVideos = await help.deskzoHelpLinks("VIDEO");
        ok("Deskzo's articles: live, on an allowed host — no draft, no off-site link", dzArticles.ok && JSON.stringify(dzArticles.links.map((l) => l.id)) === JSON.stringify(["zzhelp-dz-article"]), JSON.stringify(dzArticles));
        ok("  its videos carry their YouTube thumbnail id", dzVideos.ok && dzVideos.links.length === 1 && dzVideos.links[0].youtubeId === "dQw4w9WgXcQ" && dzVideos.links[0].external);
        ok("  a kind that is neither is nothing, not everything", (await help.deskzoHelpLinks("OTHER" as never)).links.length === 0);
        const companyArticles = await help.listHelpLinks("ARTICLE");
        ok(
          "never mixed: no company guide in Deskzo's lists, no Deskzo guide in the company's",
          ![...dzArticles.links, ...dzVideos.links].some((l) => l.title.startsWith(TAG)) && !companyArticles.some((l) => l.id.startsWith("zzhelp-dz")) && companyArticles.some((l) => l.title === `${TAG} Punching an order`),
        );

        dzFeed = await help.deskzoUpdates();
        const byId = new Map(dzFeed.posts.map((p) => [p.id, p]));
        ok(
          "Deskzo's What's new: live posts only, pinned first, then newest",
          dzFeed.ok && dzFeed.posts.map((p) => p.id).join(",") === "zzhelp-dz-pinned,zzhelp-dz-two,zzhelp-dz-one,zzhelp-dz-badlink,zzhelp-dz-old",
          dzFeed.posts.map((p) => p.id).join(","),
        );
        ok("  unread from when they joined, on Deskzo's own line", dzFeed.posts.filter((p) => p.unread).map((p) => p.id).sort().join(",") === "zzhelp-dz-badlink,zzhelp-dz-one,zzhelp-dz-pinned,zzhelp-dz-two");
        ok(
          "  a link that fails Deskzo's host rule is dropped and the post kept; an in-app one stays in the app",
          byId.get("zzhelp-dz-badlink")?.linkUrl === null && byId.get("zzhelp-dz-one")?.linkUrl === "https://deskzo.com/notes/1" && byId.get("zzhelp-dz-one")?.external === true && byId.get("zzhelp-dz-two")?.linkUrl === "/renewals" && byId.get("zzhelp-dz-two")?.external === false,
        );
        ok("  Deskzo speaks as Deskzo: no staff name", dzFeed.posts.every((p) => p.author === null));
        const companyFeed = await help.listUpdates(100);
        ok("never mixed: no company post in Deskzo's feed, no Deskzo post in the company's", !dzFeed.posts.some((p) => p.title.startsWith(TAG)) && !companyFeed.some((p) => p.id.startsWith("zzhelp-dz")));

        const companyUnread = await help.unreadUpdateCount();
        const counts = await help.unreadUpdateCounts();
        ok("two unread counts, each its own: Deskzo's 4, the company's its own", counts.deskzo === 4 && (await help.deskzoUnreadCount()) === 4 && counts.company === companyUnread && companyUnread > 0, JSON.stringify({ counts, companyUnread }));

        deskzoSource = { kind: "down" };
        const downFeed = await help.deskzoUpdates();
        ok("a control plane that is down: Deskzo's feed is empty and says so (ok false) — the company's is still there", !downFeed.ok && downFeed.posts.length === 0 && (await help.listUpdates()).length > 0);
        ok("  Deskzo's dot is 0 for it; the company's is untouched", (await help.unreadUpdateCounts()).deskzo === 0 && (await help.deskzoUnreadCount()) === 0 && (await help.unreadUpdateCount()) === companyUnread);
        ok("  Deskzo's help lists say so too", !(await help.deskzoHelpLinks("ARTICLE")).ok);
        await help.markDeskzoUpdatesSeen();
        await help.markDeskzoUpdatesSeen(byId.get("zzhelp-dz-two")!.publishedAt);
        ok("  and opening What's new on a failed read moves Deskzo's line nowhere", (await line()).deskzoUpdatesSeenAt === null);
        deskzoSource = { kind: "rows", rows: { links: [], updates: [] } };
        await help.markDeskzoUpdatesSeen();
        ok("an empty read moves nothing either", (await line()).deskzoUpdatesSeenAt === null);

        deskzoSource = { kind: "rows", rows };
        viewingAs = true;
        await help.markDeskzoUpdatesSeen();
        viewingAs = false;
        ok("opening it while viewing as them leaves Deskzo's dot alone", (await line()).deskzoUpdatesSeenAt === null && (await help.deskzoUnreadCount()) === 4);
        await help.markDeskzoUpdatesSeen("not a time");
        ok("a 'shown up to' that isn't a time marks nothing", (await line()).deskzoUpdatesSeenAt === null);

        await help.markDeskzoUpdatesSeen(byId.get("zzhelp-dz-one")!.publishedAt);
        const afterOne = await line();
        ok("marked up to the newest post shown: the line is that post's time, not now", iso(afterOne.deskzoUpdatesSeenAt) === byId.get("zzhelp-dz-one")!.publishedAt, iso(afterOne.deskzoUpdatesSeenAt));
        ok("  so only what is newer is still unread", (await help.deskzoUnreadCount()) === 1 && (await help.deskzoUpdates()).posts.filter((p) => p.unread).map((p) => p.id).join(",") === "zzhelp-dz-two");
        ok("  and the company's line and dot are untouched", afterOne.updatesSeenAt === null && (await help.unreadUpdateCount()) === companyUnread);
        await help.markDeskzoUpdatesSeen();
        const afterAll = await line();
        ok("marking all of it: the newest post's time — never now", iso(afterAll.deskzoUpdatesSeenAt) === byId.get("zzhelp-dz-two")!.publishedAt && (await help.deskzoUnreadCount()) === 0, iso(afterAll.deskzoUpdatesSeenAt));
        await help.markDeskzoUpdatesSeen(byId.get("zzhelp-dz-one")!.publishedAt);
        ok("  and never back: an older post's time leaves it where it is", iso((await line()).deskzoUpdatesSeenAt) === byId.get("zzhelp-dz-two")!.publishedAt);
        await help.markUpdatesSeen();
        ok("the company's 'seen' clears the company's dot only — Deskzo's line is as it was", (await help.unreadUpdateCount()) === 0 && iso((await line()).deskzoUpdatesSeenAt) === byId.get("zzhelp-dz-two")!.publishedAt);
        deskzoSource = {
          kind: "rows",
          rows: { links: rows.links, updates: [...rows.updates, { ...everybody, id: "zzhelp-dz-three", title: "Zzdz Release three", body: "Three.", linkUrl: null, pinned: false, publishedAt: new Date(Date.now() - 1000) }] },
        };
        const again = await help.unreadUpdateCounts();
        ok("a new post from Deskzo: Deskzo's dot is back, the company's stays clear", again.deskzo === 1 && again.company === 0, JSON.stringify(again));
      } finally {
        deskzoSource = { kind: "real" };
        as(seller);
      }
    }

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
        companyName: "Acme Technologies Private Limited",
        logoDataUrl: null,
        helpDesk: { label: "Support", phone: "+91 1800-572 6671", hours: "Mon – Fri", languages: null, email: null },
        tabs: [
          { key: "overview", label: "Dashboard", badges: [{ count: 0, label: "new from Deskzo", tone: "soft" }] },
          { key: "getting-started", label: "Getting Started", badge: 12 },
          {
            key: "updates",
            label: "Recent Updates",
            badges: [
              { count: 3, label: "new from Deskzo", tone: "soft" },
              { count: 1, label: "new from your company" },
            ],
          },
        ],
        activeTab: "overview",
      }),
    );
    ok("the band greets and names the company", band.includes("Good morning, Sachin") && band.includes("Acme Technologies Private Limited"));
    ok("without a logo it shows initials", band.includes(">AT<"));
    ok("the helpline dials the digits only", band.includes('href="tel:+9118005726671"'));
    ok("the first tab is the plain dashboard, the others say which", band.includes('href="/dashboard"') && band.includes('href="/dashboard?tab=updates"'));
    ok("the active tab is marked current", /aria-current="page"[^>]*>Dashboard/.test(band));
    ok("a big unread count reads 9+", band.includes("9+"));
    const updatesTab = band.match(/href="\/dashboard\?tab=updates"[\s\S]*?<\/a>/)?.[0] ?? "";
    ok(
      "Recent Updates carries two counts, never one sum: Deskzo's and the company's, each named",
      /title="3 new from Deskzo"[^>]*>3<span class="sr-only"> new from Deskzo<\/span>/.test(updatesTab) && /title="1 new from your company"[^>]*>1<span class="sr-only"> new from your company<\/span>/.test(updatesTab) && !updatesTab.includes(">4<"),
      updatesTab,
    );
    ok("  a count of 0 shows no pill", !(band.match(/href="\/dashboard\?tab=overview"[\s\S]*?<\/a>/)?.[0] ?? "").includes("new from Deskzo"));

    /** One source's group of a rendered panel or feed — `data-source` marks them (src/components/layout/rail-help.tsx, recent-updates.tsx). */
    const group = (html: string, source: "deskzo" | "company") => html.match(new RegExp(`<section[^>]*data-source="${source}"[\\s\\S]*?</section>`))?.[0] ?? "";
    const firstOf = (html: string) => html.match(/data-source="(deskzo|company)"/)?.[1];
    // A Deskzo feed for the renders: what the loader gave above, or a stand-in where there is no control plane.
    const dzShown = dzFeed.posts.length
      ? dzFeed
      : { ok: true, posts: [{ id: "zzhelp-dz-one", title: "Zzdz Release one", body: "One.", linkUrl: null, external: false, pinned: false, publishedAt: new Date().toISOString(), author: null, unread: true }] };
    const companyShown = feed;

    const { RecentUpdates } = load("../src/components/help/recent-updates") as typeof import("../src/components/help/recent-updates");
    const updatesHtml = render(React.createElement(RecentUpdates, { deskzo: dzShown, company: companyShown, canManage: false }));
    ok("an external read-more opens safely in a new tab", /href="https:\/\/example\.com\/policy"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*referrerPolicy="no-referrer"/i.test(updatesHtml));
    ok("an in-app read-more stays in the app", updatesHtml.includes('href="/renewals"'));
    ok("somebody who can't post isn't offered to", !updatesHtml.includes("Post company news") && !updatesHtml.includes("/settings/updates"));
    const dzGroup = group(updatesHtml, "deskzo");
    const coGroup = group(updatesHtml, "company");
    ok("What's new is two feeds, From Deskzo first, then Company news", firstOf(updatesHtml) === "deskzo" && dzGroup.includes("From Deskzo") && coGroup.includes("Company news"));
    ok(
      "  never mixed: each feed holds its own posts and none of the other's",
      dzShown.posts.every((p) => dzGroup.includes(p.title) && !coGroup.includes(p.title)) && companyShown.every((p) => coGroup.includes(p.title) && !dzGroup.includes(p.title)),
    );
    // The heading's "2 new" (React may put a comment between the number and the word).
    const unreadIn = (html: string) => Number(html.match(/>(\d+)(?:<!-- -->)? new<\/span>/)?.[1] ?? 0);
    ok(
      "  each counts its own unread",
      unreadIn(dzGroup) === dzShown.posts.filter((p) => p.unread).length && unreadIn(coGroup) === companyShown.filter((p) => p.unread).length,
      JSON.stringify({ deskzo: unreadIn(dzGroup), company: unreadIn(coGroup) }),
    );
    const managerUpdates = render(React.createElement(RecentUpdates, { deskzo: dzShown, company: companyShown, canManage: true }));
    ok("a manager is offered to post company news — in the company's feed only, never Deskzo's", group(managerUpdates, "company").includes("Post company news") && !group(managerUpdates, "deskzo").includes("/settings/"));
    const emptyUpdates = render(React.createElement(RecentUpdates, { deskzo: { ok: true, posts: [] }, company: [], canManage: true, compact: true }));
    ok(
      "  empty, each feed says so in its own words; only the company's offers to post",
      group(emptyUpdates, "deskzo").includes("Nothing new from Deskzo yet.") && !group(emptyUpdates, "deskzo").includes("href=") && group(emptyUpdates, "company").includes("hasn&#x27;t posted any news yet") && group(emptyUpdates, "company").includes('href="/settings/updates"'),
      emptyUpdates,
    );
    const downUpdates = render(React.createElement(RecentUpdates, { deskzo: { ok: false, posts: [] }, company: companyShown, canManage: false, compact: true }));
    ok("  Deskzo's side unreadable: said in its own feed, and the company's still shows", group(downUpdates, "deskzo").includes("couldn&#x27;t be reached") && companyShown.every((p) => group(downUpdates, "company").includes(p.title)));

    // The rail's Help and Videos panels, once loaded.
    const rail = load("../src/components/layout/rail-help") as typeof import("../src/components/layout/rail-help");
    const companyArticles = articles;
    const dzArticleShown = dzArticles.links.length ? dzArticles : { ok: true, links: [{ id: "zzhelp-dz-article", kind: "ARTICLE" as const, title: "Zzdz Raising a quote", url: "/proposals/new", description: null, external: false, youtubeId: null }] };
    const helpHtml = render(React.createElement(rail.RailHelpView, { desk: null, deskzo: dzArticleShown, company: companyArticles, canManage: true }));
    ok("the Help panel: From Deskzo first, then From your company", firstOf(helpHtml) === "deskzo" && group(helpHtml, "deskzo").includes("From Deskzo") && group(helpHtml, "company").includes("From your company"));
    ok(
      "  never mixed: Deskzo's articles in Deskzo's group only, the company's in the company's only",
      dzArticleShown.links.every((l) => group(helpHtml, "deskzo").includes(l.title) && !group(helpHtml, "company").includes(l.title)) &&
        companyArticles.every((l) => group(helpHtml, "company").includes(l.title) && !group(helpHtml, "deskzo").includes(l.title)),
    );
    ok("  Deskzo's group never offers to add", !/Add/.test(group(helpHtml, "deskzo")) && !group(helpHtml, "deskzo").includes("/settings/help"));
    const emptyHelp = (canManage: boolean) => render(React.createElement(rail.RailHelpView, { desk: null, deskzo: { ok: true, links: [] }, company: [], canManage }));
    ok(
      "  the company's empty group offers a manager a quiet link to add their own — nobody else",
      group(emptyHelp(true), "company").includes("Add your company&#x27;s own guide") && group(emptyHelp(true), "company").includes('href="/settings/help"') && !emptyHelp(false).includes("/settings/help") && !/Add/.test(group(emptyHelp(true), "deskzo")),
    );
    ok("  Deskzo's empty group says so, apart", group(emptyHelp(false), "deskzo").includes("Nothing from Deskzo here yet.") && group(emptyHelp(false), "company").includes("hasn&#x27;t added guides of its own"));
    ok(
      "  Deskzo's help unreadable: said in its own group; the company's guides still show",
      (() => {
        const html = render(React.createElement(rail.RailHelpView, { desk: null, deskzo: { ok: false, links: [] }, company: companyArticles, canManage: false }));
        return group(html, "deskzo").includes("couldn&#x27;t be reached") && companyArticles.every((l) => group(html, "company").includes(l.title));
      })(),
    );
    const dzVideoShown = dzVideos.links.length ? dzVideos : { ok: true, links: [{ id: "zzhelp-dz-video", kind: "VIDEO" as const, title: "Zzdz Orders walkthrough", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", description: null, external: true, youtubeId: "dQw4w9WgXcQ" }] };
    const videosHtml = render(React.createElement(rail.RailVideosView, { deskzo: dzVideoShown, company: videos, canManage: false }));
    ok(
      "the Videos panel: the same two groups, each with its own videos",
      firstOf(videosHtml) === "deskzo" && dzVideoShown.links.every((v) => group(videosHtml, "deskzo").includes(v.title) && !group(videosHtml, "company").includes(v.title)) && videos.every((v) => group(videosHtml, "company").includes(v.title) && !group(videosHtml, "deskzo").includes(v.title)),
    );
    ok("  YouTube's still, fetched with no referrer; the video opens off-site with none either — never embedded", /<img[^>]*src="https:\/\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/mqdefault\.jpg"[^>]*referrerPolicy="no-referrer"/i.test(videosHtml) && /target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"/i.test(videosHtml) && !videosHtml.includes("<iframe"));
    ok("  with nothing of the company's, no offer to add to somebody who can't", !videosHtml.includes("/settings/help") && !render(React.createElement(rail.RailVideosView, { deskzo: dzVideoShown, company: [], canManage: false })).includes("/settings/help"));

    const { HeaderSearch } = load("../src/components/layout/header-search") as typeof import("../src/components/layout/header-search");
    as(seller);
    const searchHtml = render(React.createElement(HeaderSearch, { scopes: await searchScopesForMe() }));
    ok("the box names what it searches and the shortcut", searchHtml.includes("Search in Customers ( / )") || searchHtml.includes("Search in Companies ( / )"), searchHtml.slice(0, 200));
    ok("the scope picker is a real, labelled select", searchHtml.includes('aria-label="Search in"') && searchHtml.includes("<select"));
    ok("the field is a combobox", searchHtml.includes('role="combobox"'));

    const Dashboard = (load("../src/app/(dashboard)/dashboard/page") as { default: (p: { searchParams: Promise<{ tab?: string }> }) => Promise<unknown> }).default;
    const onUpdates = render(await Dashboard({ searchParams: Promise.resolve({ tab: "updates" }) }));
    ok("the Recent Updates tab renders the posts under the band", onUpdates.includes("Fresh news") && onUpdates.includes("Recent Updates") && onUpdates.includes("<pattern"));
    ok("  as two feeds: From Deskzo, then Company news — the company's posts in its own", firstOf(onUpdates) === "deskzo" && group(onUpdates, "deskzo").includes("From Deskzo") && group(onUpdates, "company").includes("Fresh news") && !group(onUpdates, "deskzo").includes("Fresh news"));
    const onStart = render(await Dashboard({ searchParams: Promise.resolve({ tab: "getting-started" }) }));
    ok("the Getting Started tab renders the checklist", onStart.includes("Add your photo") && onStart.includes('role="progressbar"'));
    const onBogus = render(await Dashboard({ searchParams: Promise.resolve({ tab: "../../etc" }) }));
    // The probe is new, so still being onboarded: its first tab is Getting Started (src/lib/help/onboarding.ts, check:onboarding).
    ok("an unknown tab falls back to the first tab — Getting Started, for somebody still setting up", /aria-current="page"[^>]*>Getting Started/.test(onBogus));

    const HelpPage = (load("../src/app/(dashboard)/settings/help/page") as { default: () => Promise<unknown> }).default;
    const UpdatesPage = (load("../src/app/(dashboard)/settings/updates/page") as { default: () => Promise<unknown> }).default;
    ok("the company's guides page turns away somebody without help.manage", render(await HelpPage()).includes("Only somebody who can manage your company&#x27;s guides and news"));
    ok("  so does the company news page", render(await UpdatesPage()).includes("Only somebody who can manage your company&#x27;s guides and news"));
    as(manager);
    const helpPage = render(await HelpPage());
    // The support contact is the platform's now (console Settings → Support), and Deskzo's help is Deskzo's: no helpline form here.
    ok(
      "…and shows somebody with it the company's own guides, saying Deskzo's help, videos and What's new come from Deskzo, apart — no helpline form",
      helpPage.includes("Your company&#x27;s guides") && helpPage.includes("come from Deskzo and") && helpPage.includes("appear separately") && !helpPage.includes("Save helpline"),
    );
    const updatesPage = render(await UpdatesPage());
    ok("the company news page says it is the company's, and that Deskzo's What's new is apart", updatesPage.includes(">Company news<") && updatesPage.includes("come from Deskzo and appear separately"));
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
