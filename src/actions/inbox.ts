"use server";

import { isModuleEnabled } from "@/actions/module";
import type { ActionResult } from "@/actions/company";
import { can } from "@/lib/authz/resolve";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import {
  assignConversation,
  assignablePeople,
  conversationDetail,
  conversationIdFrom,
  listConversations,
  setConversationStatus,
  staffMakeLead,
  staffMakeTicket,
  staffReply,
  staffTemplate,
  unreadCount,
  type InboxDetail,
  type InboxRow,
  type InboxView,
  type InboxViewer,
} from "@/lib/inbox/server";

/**
 * The Customer inbox's screen (src/app/(dashboard)/inbox): reading and answering customer conversations,
 * taking or passing one on, closing it, and making a lead or a ticket from it. Every action asks for the
 * inbox — in the plan, switched on, and "Answer customer conversations" — and the rules about each
 * conversation are src/lib/inbox/server.ts. Changes are refused while viewing as somebody: a reply would
 * go out in their name.
 */

const NO_INBOX = "The Customer inbox isn't open to you.";
const VIEWS: readonly InboxView[] = ["mine", "unassigned", "open", "closed"];

/** The person, as the inbox sees them — or null when it isn't theirs to use. */
async function inboxViewer(): Promise<InboxViewer | null> {
  const user = await requireModuleUser("inbox");
  if (!(await isModuleEnabled("inbox")) || !(await can(user.id, "inbox.view"))) return null;
  return { id: user.id, viewAll: await can(user.id, "inbox.viewAll") };
}

/** Like `inboxViewer`, for a change: also refused while viewing as somebody. */
async function changingViewer(): Promise<InboxViewer | string> {
  const viewer = await inboxViewer();
  if (!viewer) return NO_INBOX;
  const refused = await refuseWhileViewingAs();
  return refused ?? viewer;
}

const done = (r: { ok: true } | { ok: false; error: string }): ActionResult<null> => (r.ok ? { ok: true, data: null } : { ok: false, error: r.error });

export async function inboxList(filter: { view: string; channelId?: string | null; q?: string | null }): Promise<InboxRow[]> {
  const viewer = await inboxViewer();
  if (!viewer) return [];
  const view = (VIEWS as readonly string[]).includes(filter?.view) ? (filter.view as InboxView) : "open";
  return listConversations(viewer, { view, channelId: typeof filter?.channelId === "string" ? filter.channelId : null, q: typeof filter?.q === "string" ? filter.q : null });
}

/** One conversation by its id or CNV-000123 — marked read for this person. */
export async function inboxConversation(ref: string): Promise<InboxDetail | null> {
  const viewer = await inboxViewer();
  if (!viewer || typeof ref !== "string") return null;
  const id = await conversationIdFrom(ref);
  return id ? conversationDetail(viewer, id) : null;
}

export async function inboxUnread(): Promise<number> {
  const viewer = await inboxViewer();
  return viewer ? unreadCount(viewer) : 0;
}

export async function inboxPeople(): Promise<{ id: string; name: string }[]> {
  const viewer = await inboxViewer();
  return viewer ? assignablePeople() : [];
}

export async function inboxReply(id: string, text: string): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return done(await staffReply(viewer, String(id ?? ""), String(text ?? "")));
}

export async function inboxSendTemplate(id: string, template: { name: string; variables: string[] }): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  const variables = Array.isArray(template?.variables) ? template.variables.map((v) => String(v ?? "")) : [];
  return done(await staffTemplate(viewer, String(id ?? ""), { name: String(template?.name ?? ""), variables }));
}

export async function inboxAssign(id: string, userId: string | null): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return done(await assignConversation(viewer, String(id ?? ""), typeof userId === "string" && userId ? userId : null));
}

export async function inboxSetStatus(id: string, status: string): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  if (status !== "OPEN" && status !== "CLOSED") return { ok: false, error: "Choose open or closed." };
  return done(await setConversationStatus(viewer, String(id ?? ""), status));
}

/** A lead from the conversation — for somebody who may open Leads. */
export async function inboxMakeLead(id: string): Promise<ActionResult<{ reference: string | null; contactOnly: boolean }>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  if (!(await isModuleEnabled("leads")) || !(await can(viewer.id, "leads.view"))) return { ok: false, error: "Leads aren't open to you." };
  const made = await staffMakeLead(viewer, String(id ?? ""));
  return made.ok ? { ok: true, data: { reference: made.reference, contactOnly: made.contactOnly } } : { ok: false, error: made.error };
}

/** A helpdesk ticket from the conversation — for somebody who may open tickets. */
export async function inboxMakeTicket(id: string, title: string): Promise<ActionResult<{ ticketSeq: number }>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  if (!(await isModuleEnabled("helpdesk")) || !(await can(viewer.id, "tickets.create"))) return { ok: false, error: "You can't open tickets." };
  return staffMakeTicket(viewer, String(id ?? ""), String(title ?? ""));
}
