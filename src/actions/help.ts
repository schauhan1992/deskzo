"use server";

import { revalidatePath } from "next/cache";
import type { HelpLinkKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { parseIstDateTime } from "@/lib/india-time";
import { isModuleEnabled } from "@/actions/module";
import { getBranding } from "@/actions/branding";
import { getOrganisation, isOrganisationReady } from "@/lib/organisation";
import { checkLink, youtubeId } from "@/lib/help/links";
import { gettingStartedSteps, type GettingStartedStep } from "@/lib/help/getting-started";
import type { ActionResult } from "@/actions/company";

/**
 * Help and What's new — the helpline in the corner of the dashboard, the help articles and videos in
 * the rail, and the posts under Recent Updates.
 *
 * Reading is open to everybody signed in: a helpline you need permission to see is no helpline.
 * Changing any of it is `help.manage`.
 */

const NOT_ALLOWED = "You can't change help and What's new.";

const LIMITS = { label: 60, phone: 30, hours: 80, languages: 120, email: 120, title: 120, description: 300, body: 4000 };

async function mayManage(userId: string) {
  return can(userId, "help.manage");
}

// ─── The helpline ────────────────────────────────────────────────────────────────────────────────

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

// ─── Help articles and videos ────────────────────────────────────────────────────────────────────

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

/** The rail's list: live links only, in the order they were arranged. */
export async function listHelpLinks(kind?: HelpLinkKind): Promise<HelpLinkView[]> {
  await requireUser();
  const rows = await db.helpLink.findMany({
    where: { active: true, ...(kind ? { kind } : {}) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: 200,
  });
  return rows.map(linkView);
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

// ─── What's new ──────────────────────────────────────────────────────────────────────────────────

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
 */
function unreadFloor(u: { updatesSeenAt: Date | null; createdAt: Date }): Date {
  return u.updatesSeenAt && u.updatesSeenAt > u.createdAt ? u.updatesSeenAt : u.createdAt;
}

/** Published posts — pinned first, then newest — each marked read or unread for this person. */
export async function listUpdates(limit = 30): Promise<UpdateView[]> {
  const user = await requireUser();
  const me = await db.user.findUnique({ where: { id: user.id }, select: { updatesSeenAt: true, createdAt: true } });
  const floor = me ? unreadFloor(me) : new Date();
  const rows = await db.announcement.findMany({
    where: { publishedAt: { lte: new Date() } },
    orderBy: [{ pinned: "desc" }, { publishedAt: "desc" }],
    take: Math.max(1, Math.min(100, limit)),
    include: { createdBy: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    linkUrl: r.linkUrl,
    external: !!r.linkUrl && !r.linkUrl.startsWith("/"),
    pinned: r.pinned,
    publishedAt: r.publishedAt.toISOString(),
    author: r.createdBy?.name ?? null,
    unread: r.publishedAt > floor,
  }));
}

/** For the dot on the rail's What's new button. */
export async function unreadUpdateCount(): Promise<number> {
  const user = await requireUser();
  const me = await db.user.findUnique({ where: { id: user.id }, select: { updatesSeenAt: true, createdAt: true } });
  if (!me) return 0;
  return db.announcement.count({ where: { publishedAt: { gt: unreadFloor(me), lte: new Date() } } });
}

/**
 * Everything published up to now has been seen.
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
  /** India time from a `datetime-local` input; empty means now. */
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
    const at = parseIstDateTime(input.publishAt);
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

// ─── Getting started ─────────────────────────────────────────────────────────────────────────────

export async function getGettingStarted(): Promise<GettingStartedStep[]> {
  const user = await requireUser();
  const [admin, helpManager, itemsModule, me] = await Promise.all([
    can(user.id, "settings.manage"),
    mayManage(user.id),
    isModuleEnabled("items"),
    db.user.findUnique({ where: { id: user.id }, select: { photoUpdatedAt: true, twoFactorEnabledAt: true } }),
  ]);
  // Company facts are read only for somebody who will be shown the company steps.
  const [organisation, branding, activeUsers, itemCount, helpDesk] = await Promise.all([
    admin ? getOrganisation() : null,
    admin ? getBranding() : null,
    admin ? db.user.count({ where: { active: true } }) : 0,
    admin && itemsModule ? db.item.count() : 0,
    helpManager ? db.helpDesk.findUnique({ where: { id: "global" }, select: { helplinePhone: true, supportEmail: true } }) : null,
  ]);
  return gettingStartedSteps({
    admin,
    helpManager,
    itemsModule,
    organisationReady: organisation ? isOrganisationReady(organisation) : false,
    hasLogo: !!branding?.logoDataUrl,
    activeUsers,
    itemCount,
    helplineSet: !!(helpDesk?.helplinePhone || helpDesk?.supportEmail),
    hasPhoto: !!me?.photoUpdatedAt,
    hasTwoFactor: !!me?.twoFactorEnabledAt,
  });
}
