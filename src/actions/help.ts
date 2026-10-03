"use server";

import { revalidatePath } from "next/cache";
import type { HelpLinkKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { workspaceClock } from "@/lib/time/workspace";
import { checkLink, youtubeId } from "@/lib/help/links";
import type { GettingStartedStep } from "@/lib/help/getting-started";
import { gettingStartedFor } from "@/lib/help/onboarding-facts";
import { deskzoContentFor, deskzoSeenThrough, type DeskzoContent, type PlatformHelpKindKey } from "@/lib/platform/help-content";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { ActionResult } from "@/actions/company";

/**
 * Help and What's new, from two sources that are always kept apart (owner, 2 Oct 2026):
 *
 *   · From Deskzo — the help articles, walkthrough videos and What's new that Deskzo's staff publish
 *     in the platform console for every workspace they apply to. Read-only here: nothing in this file
 *     writes them (src/lib/platform/help-content.ts reads them).
 *   · From the company — its own guides (articles and videos in the rail) and its company news, rows
 *     in its own database. Changing any of those is `help.manage`.
 *
 * Every list and every unread count is one source's alone, so a company's guide can never pass for
 * Deskzo's, nor Deskzo's for the company's. Reading either is open to everybody signed in.
 */

const NOT_ALLOWED = "You can't change your company's guides and news.";

const LIMITS = { label: 60, phone: 30, hours: 80, languages: 120, email: 120, title: 120, description: 300, body: 4000 };

async function mayManage(userId: string) {
  return can(userId, "help.manage");
}

// ─── The helpline ────────────────────────────────────────────────────────────────────────────────
//
// No longer shown: since the platform began selling workspaces, the dashboard and the rail's Help panel
// show the platform's support contact from its console (`getSupportContact`, src/actions/support.ts).
// Kept, with its data, until the workspace helpline is retired for good; check:help still covers it.

export type HelpDeskView = {
  label: string | null;
  phone: string | null;
  hours: string | null;
  languages: string | null;
  email: string | null;
};

/** What the dashboard shows. Null when there is neither a number nor an address to show. */
export async function getHelpDesk(): Promise<HelpDeskView | null> {
  await requireUser();
  const row = await db.helpDesk.findUnique({ where: { id: "global" } });
  if (!row || (!row.helplinePhone && !row.supportEmail)) return null;
  return {
    label: row.helplineLabel,
    phone: row.helplinePhone,
    hours: row.helplineHours,
    languages: row.helplineLanguages,
    email: row.supportEmail,
  };
}

export type HelpDeskInput = { label?: string; phone?: string; hours?: string; languages?: string; email?: string };

const PHONE = /^\+?[0-9][0-9 ()-]{5,28}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function saveHelpDesk(input: HelpDeskInput): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await mayManage(user.id))) return { ok: false, error: NOT_ALLOWED };

  const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "") || null;
  const data = {
    helplineLabel: clean(input?.label, LIMITS.label),
    helplinePhone: clean(input?.phone, LIMITS.phone),
    helplineHours: clean(input?.hours, LIMITS.hours),
    helplineLanguages: clean(input?.languages, LIMITS.languages),
    supportEmail: clean(input?.email, LIMITS.email),
  };
  if (data.helplinePhone && !PHONE.test(data.helplinePhone)) return { ok: false, error: "That doesn't look like a phone number — digits, spaces, + and - only." };
  if (data.supportEmail && !EMAIL.test(data.supportEmail)) return { ok: false, error: "That isn't an email address." };

  await db.helpDesk.upsert({
    where: { id: "global" },
    create: { id: "global", ...data, updatedById: user.id },
    update: { ...data, updatedById: user.id },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "HelpDesk", entityId: "global", entityLabel: "Helpline updated" });
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

// ─── The company's own guides: articles and videos ───────────────────────────────────────────────

/** An article or a video as the rail shows it — the company's own, or Deskzo's (`deskzoHelpLinks`). */
export type HelpLinkView = {
  id: string;
  kind: HelpLinkKind;
  title: string;
  url: string;
  description: string | null;
  external: boolean;
  /** For a thumbnail beside a YouTube video. */
  youtubeId: string | null;
};

function linkView(l: { id: string; kind: HelpLinkKind; title: string; url: string; description: string | null }): HelpLinkView {
  return {
    id: l.id,
    kind: l.kind,
    title: l.title,
    url: l.url,
    description: l.description,
    external: !l.url.startsWith("/"),
    youtubeId: l.kind === "VIDEO" ? youtubeId(l.url) : null,
  };
}

/**
 * A stored link held to today's rule again on its way to a page: one saved before the rule refused
 * it (a path with a tab in it opens another site) is null, and never becomes an href.
 */
function linkStillGood(url: string | null): { url: string; external: boolean } | null {
  if (!url) return null;
  const checked = checkLink(url);
  return checked.ok ? { url: checked.url, external: checked.external } : null;
}

/** The rail's list of the company's own: live links only, in the order they were arranged. A link the rule now refuses is left out. */
export async function listHelpLinks(kind?: HelpLinkKind): Promise<HelpLinkView[]> {
  await requireUser();
  const rows = await db.helpLink.findMany({
    where: { active: true, ...(kind ? { kind } : {}) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: 200,
  });
  return rows.flatMap((r) => {
    const link = linkStillGood(r.url);
    return link ? [linkView({ ...r, url: link.url })] : [];
  });
}

/** The settings page's list — hidden ones too. */
export async function listHelpLinksForManage() {
  const user = await requireUser();
  if (!(await mayManage(user.id))) return null;
  const rows = await db.helpLink.findMany({ orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }] });
  return toPlain(rows.map((r) => ({ ...linkView(r), active: r.active, sortOrder: r.sortOrder })));
}

export type HelpLinkInput = {
  id?: string;
  kind: HelpLinkKind;
  title: string;
  url: string;
  description?: string;
  active?: boolean;
  sortOrder?: number;
};

export async function saveHelpLink(input: HelpLinkInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await mayManage(user.id))) return { ok: false, error: NOT_ALLOWED };
  if (input?.kind !== "ARTICLE" && input?.kind !== "VIDEO") return { ok: false, error: "Choose whether it's an article or a video." };

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return { ok: false, error: "Give it a title." };
  if (title.length > LIMITS.title) return { ok: false, error: `Keep the title under ${LIMITS.title} characters.` };
  const link = checkLink(typeof input.url === "string" ? input.url : "");
  if (!link.ok) return { ok: false, error: link.error };
  const description = typeof input.description === "string" ? input.description.trim().slice(0, LIMITS.description) || null : null;
  const sortOrder = Number.isInteger(input.sortOrder) ? Math.max(0, Math.min(9999, input.sortOrder!)) : 0;
  const data = { kind: input.kind, title, url: link.url, description, active: input.active !== false, sortOrder };

  let id: string;
  if (input.id) {
    const updated = await db.helpLink.updateMany({ where: { id: input.id }, data });
    if (updated.count === 0) return { ok: false, error: "That link has been removed." };
    id = input.id;
  } else {
    id = (await db.helpLink.create({ data: { ...data, createdById: user.id }, select: { id: true } })).id;
  }
  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "HelpLink",
    entityId: id,
    entityLabel: `${input.kind === "VIDEO" ? "Video" : "Help article"}: ${title}`,
  });
  revalidatePath("/settings/help");
  return { ok: true, data: { id } };
}

export async function deleteHelpLink(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await mayManage(user.id))) return { ok: false, error: NOT_ALLOWED };
  const row = await db.helpLink.findUnique({ where: { id: String(id) }, select: { id: true, title: true } });
  if (!row) return { ok: true, data: null };
  await db.helpLink.delete({ where: { id: row.id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "HelpLink", entityId: row.id, entityLabel: `Help link removed: ${row.title}` });
  revalidatePath("/settings/help");
  return { ok: true, data: null };
}

// ─── The company's news ──────────────────────────────────────────────────────────────────────────

/** A What's new post as a feed shows it — the company's news, or Deskzo's (`deskzoUpdates`). */
export type UpdateView = {
  id: string;
  title: string;
  body: string;
  linkUrl: string | null;
  external: boolean;
  pinned: boolean;
  publishedAt: string;
  author: string | null;
  unread: boolean;
};

/**
 * The line a post has to be newer than to count as unread.
 *
 * Somebody who has never opened What's new has not "missed" every post since the company started;
 * they joined. So the floor is the later of when they last looked and when their account was made.
 * Each source has its own line: `updatesSeenAt` for the company's news, `deskzoUpdatesSeenAt` for
 * Deskzo's.
 */
function unreadFloor(seenAt: Date | null, createdAt: Date): Date {
  return seenAt && seenAt > createdAt ? seenAt : createdAt;
}

/** How many posts a feed asks for: 1 to 100, 30 when it says nothing usable. */
function feedSize(limit: unknown): number {
  return typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 30;
}

/** The company's published posts — pinned first, then newest — each marked read or unread for this person. */
export async function listUpdates(limit = 30): Promise<UpdateView[]> {
  const user = await requireUser();
  const me = await db.user.findUnique({ where: { id: user.id }, select: { updatesSeenAt: true, createdAt: true } });
  const floor = me ? unreadFloor(me.updatesSeenAt, me.createdAt) : new Date();
  const rows = await db.announcement.findMany({
    where: { publishedAt: { lte: new Date() } },
    orderBy: [{ pinned: "desc" }, { publishedAt: "desc" }],
    take: feedSize(limit),
    include: { createdBy: { select: { name: true } } },
  });
  return rows.map((r) => {
    // A "read more" the rule now refuses is dropped; the post itself still shows.
    const link = linkStillGood(r.linkUrl);
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      linkUrl: link?.url ?? null,
      external: link?.external ?? false,
      pinned: r.pinned,
      publishedAt: r.publishedAt.toISOString(),
      author: r.createdBy?.name ?? null,
      unread: r.publishedAt > floor,
    };
  });
}

/** How many of the company's posts this person hasn't seen — its own dot, apart from Deskzo's. */
export async function unreadUpdateCount(): Promise<number> {
  const user = await requireUser();
  const me = await db.user.findUnique({ where: { id: user.id }, select: { updatesSeenAt: true, createdAt: true } });
  if (!me) return 0;
  return db.announcement.count({ where: { publishedAt: { gt: unreadFloor(me.updatesSeenAt, me.createdAt), lte: new Date() } } });
}

/**
 * Everything the company has published up to now has been seen. Deskzo's posts are not touched:
 * they have their own line, moved by `markDeskzoUpdatesSeen`.
 *
 * Not while viewing as somebody: an administrator reading another person's screen has not read
 * that person's updates for them, and clearing the dot would hide news they have not seen.
 */
export async function markUpdatesSeen(): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (await viewAsContext()) return { ok: true, data: null };
  await db.user.update({ where: { id: user.id }, data: { updatesSeenAt: new Date() } });
  return { ok: true, data: null };
}

/** The settings page's list — scheduled posts too. */
export async function listUpdatesForManage() {
  const user = await requireUser();
  if (!(await mayManage(user.id))) return null;
  const rows = await db.announcement.findMany({
    orderBy: [{ publishedAt: "desc" }],
    take: 200,
    include: { createdBy: { select: { name: true } } },
  });
  const now = new Date();
  return toPlain({
    now,
    posts: rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      linkUrl: r.linkUrl,
      pinned: r.pinned,
      publishedAt: r.publishedAt,
      scheduled: r.publishedAt > now,
      author: r.createdBy?.name ?? null,
    })),
  });
}

export type UpdateInput = {
  id?: string;
  title: string;
  body: string;
  linkUrl?: string;
  pinned?: boolean;
  /** The workspace's time from a `datetime-local` input; empty means now. */
  publishAt?: string;
};

export async function saveUpdate(input: UpdateInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await mayManage(user.id))) return { ok: false, error: NOT_ALLOWED };

  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const body = typeof input?.body === "string" ? input.body.trim() : "";
  if (!title) return { ok: false, error: "Give the update a title." };
  if (title.length > LIMITS.title) return { ok: false, error: `Keep the title under ${LIMITS.title} characters.` };
  if (!body) return { ok: false, error: "Say what's new." };
  if (body.length > LIMITS.body) return { ok: false, error: `Keep it under ${LIMITS.body} characters — link to the details instead.` };

  let linkUrl: string | null = null;
  if (typeof input.linkUrl === "string" && input.linkUrl.trim()) {
    const link = checkLink(input.linkUrl);
    if (!link.ok) return { ok: false, error: link.error };
    linkUrl = link.url;
  }

  let publishedAt: Date | undefined;
  if (typeof input.publishAt === "string" && input.publishAt.trim()) {
    const at = (await workspaceClock()).parseInput(input.publishAt);
    if (!at) return { ok: false, error: "That publish time isn't a date and time." };
    publishedAt = at;
  }

  const data = { title, body, linkUrl, pinned: input.pinned === true };
  let id: string;
  if (input.id) {
    const updated = await db.announcement.updateMany({ where: { id: input.id }, data: { ...data, ...(publishedAt ? { publishedAt } : {}) } });
    if (updated.count === 0) return { ok: false, error: "That update has been removed." };
    id = input.id;
  } else {
    id = (await db.announcement.create({ data: { ...data, publishedAt: publishedAt ?? new Date(), createdById: user.id }, select: { id: true } })).id;
  }
  await recordAudit({ userId: user.id, action: input.id ? "UPDATE" : "CREATE", entityType: "Announcement", entityId: id, entityLabel: `What's new: ${title}` });
  revalidatePath("/", "layout");
  return { ok: true, data: { id } };
}

export async function deleteUpdate(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await mayManage(user.id))) return { ok: false, error: NOT_ALLOWED };
  const row = await db.announcement.findUnique({ where: { id: String(id) }, select: { id: true, title: true } });
  if (!row) return { ok: true, data: null };
  await db.announcement.delete({ where: { id: row.id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Announcement", entityId: row.id, entityLabel: `What's new removed: ${row.title}` });
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

// ─── From Deskzo ─────────────────────────────────────────────────────────────────────────────────
//
// Deskzo's help articles, walkthrough videos and What's new, as this workspace is shown them: read
// from the minute-long shared copy of the control plane's live rows, filtered to the modules and
// country this workspace has (src/lib/platform/help-content.ts). Read-only — there is no action here
// that writes them, and none of these lists ever holds a row of the company's.
//
// `ok` false on any of them means Deskzo's side couldn't be read just now: the list is empty for that
// reason, not because Deskzo has nothing, and nothing is marked read on the strength of it.

/** Deskzo's articles or videos for this workspace, in the console's order. */
export type DeskzoLinks = { ok: boolean; links: HelpLinkView[] };

/** Deskzo's What's new for this person — pinned first, then newest — each read or unread against their own Deskzo line. */
export type DeskzoFeed = { ok: boolean; posts: UpdateView[] };

/** This workspace's share of Deskzo's content. Never throws: a workspace that can't be told is a read that failed. */
async function deskzoContent(): Promise<DeskzoContent> {
  try {
    return await deskzoContentFor(await currentTenant());
  } catch {
    return { ok: false, links: [], updates: [] };
  }
}

export async function deskzoHelpLinks(kind?: PlatformHelpKindKey): Promise<DeskzoLinks> {
  await requireUser();
  const content = await deskzoContent();
  // Both kinds come in one list; a kind that is neither matches nothing rather than everything.
  const links = kind === undefined ? content.links : content.links.filter((l) => l.kind === kind);
  return {
    ok: content.ok,
    links: links.map((l) => ({ id: l.id, kind: l.kind, title: l.title, url: l.url, description: l.description, external: l.external, youtubeId: l.youtubeId })),
  };
}

export async function deskzoUpdates(limit = 30): Promise<DeskzoFeed> {
  const user = await requireUser();
  const [me, content] = await Promise.all([
    db.user.findUnique({ where: { id: user.id }, select: { deskzoUpdatesSeenAt: true, createdAt: true } }),
    deskzoContent(),
  ]);
  const floor = me ? unreadFloor(me.deskzoUpdatesSeenAt, me.createdAt) : new Date();
  return {
    ok: content.ok,
    posts: content.updates.slice(0, feedSize(limit)).map((u) => ({
      id: u.id,
      title: u.title,
      body: u.body,
      linkUrl: u.linkUrl,
      external: u.external,
      pinned: u.pinned,
      publishedAt: u.publishedAt.toISOString(),
      // Deskzo speaks as Deskzo: the feed's heading says so, and no staff name is handed out.
      author: null,
      unread: u.publishedAt > floor,
    })),
  };
}

/** How many of Deskzo's posts this person hasn't seen — its own dot, apart from the company's. None when the read failed. */
export async function deskzoUnreadCount(): Promise<number> {
  const user = await requireUser();
  const [me, content] = await Promise.all([
    db.user.findUnique({ where: { id: user.id }, select: { deskzoUpdatesSeenAt: true, createdAt: true } }),
    deskzoContent(),
  ]);
  if (!me) return 0;
  const floor = unreadFloor(me.deskzoUpdatesSeenAt, me.createdAt);
  return content.updates.filter((u) => u.publishedAt > floor).length;
}

/**
 * Both unread counts, each its own and never one merged number — for the layout's rail and the
 * dashboard's tab, on every page. One read of the person serves both lines and Deskzo's side comes
 * from the shared minute-long copy, so the pair costs a page what the company's count alone did.
 */
export async function unreadUpdateCounts(): Promise<{ deskzo: number; company: number }> {
  const user = await requireUser();
  const [me, content] = await Promise.all([
    db.user.findUnique({ where: { id: user.id }, select: { updatesSeenAt: true, deskzoUpdatesSeenAt: true, createdAt: true } }),
    deskzoContent(),
  ]);
  if (!me) return { deskzo: 0, company: 0 };
  const company = await db.announcement.count({ where: { publishedAt: { gt: unreadFloor(me.updatesSeenAt, me.createdAt), lte: new Date() } } });
  const floor = unreadFloor(me.deskzoUpdatesSeenAt, me.createdAt);
  return { deskzo: content.updates.filter((u) => u.publishedAt > floor).length, company };
}

/**
 * Deskzo's posts this person was shown have been seen: up to `shownThrough` — the publish time of the
 * newest post on their screen, as an ISO string — or every post live now when it is left out.
 *
 * The line (User.deskzoUpdatesSeenAt) moves to that post's publish time, never to "now", and only
 * forward (`deskzoSeenThrough`): a post published a moment after the page was drawn is still news. It
 * never moves on a read that failed or showed nothing — an empty list because the control plane was
 * down is not "seen everything". The company's line is not touched. And not while viewing as
 * somebody, for the reason `markUpdatesSeen` gives.
 */
export async function markDeskzoUpdatesSeen(shownThrough?: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (await viewAsContext()) return { ok: true, data: null };
  let limit: Date | null = null;
  if (shownThrough !== undefined && shownThrough !== null) {
    limit = typeof shownThrough === "string" ? new Date(shownThrough) : null;
    // Something that isn't a time names no post: nothing was shown that could be marked.
    if (!limit || Number.isNaN(limit.getTime())) return { ok: true, data: null };
  }
  const [me, content] = await Promise.all([
    db.user.findUnique({ where: { id: user.id }, select: { deskzoUpdatesSeenAt: true, createdAt: true } }),
    deskzoContent(),
  ]);
  if (!me) return { ok: true, data: null };
  const upTo = limit;
  const shown = upTo ? content.updates.filter((u) => u.publishedAt <= upTo) : content.updates;
  const through = deskzoSeenThrough({ ok: content.ok, updates: shown }, unreadFloor(me.deskzoUpdatesSeenAt, me.createdAt));
  if (!through) return { ok: true, data: null };
  // Forward only, even against another tab marking at the same moment with an older post.
  await db.user.updateMany({
    where: { id: user.id, OR: [{ deskzoUpdatesSeenAt: null }, { deskzoUpdatesSeenAt: { lt: through } }] },
    data: { deskzoUpdatesSeenAt: through },
  });
  return { ok: true, data: null };
}

// ─── Getting started ─────────────────────────────────────────────────────────────────────────────

/** Somebody's Getting Started steps — the dashboard's tab. The facts are read in src/lib/help/onboarding-facts.ts. */
export async function getGettingStarted(): Promise<GettingStartedStep[]> {
  const user = await requireUser();
  return (await gettingStartedFor(user.id)).steps;
}
