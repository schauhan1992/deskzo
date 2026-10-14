import { db } from "@/lib/db";
import { currentUser, viewAsContext } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { logActivity } from "@/lib/activity";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * One chat, exported whole as text — the super admin's only way into a conversation they aren't in
 * (owner, 15 Oct 2026). Nobody browses chats; an export names one, and is recorded twice: in the
 * audit trail and in the security log, where the members' own admins can see it happened.
 *
 * Files are listed by name, not included. Messages deleted for everyone appear as deleted: their
 * text is gone from the database too.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user || (await viewAsContext())) return new Response("Not found", { status: 404 });
  const me = await db.user.findUnique({ where: { id: user.id }, select: { isSuperAdmin: true, name: true, email: true } });
  if (!me?.isSuperAdmin) return new Response("Not found", { status: 404 });

  const { id } = await context.params;
  const chat = await db.chat.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      name: true,
      createdAt: true,
      members: { select: { joinedAt: true, leftAt: true, user: { select: { name: true, email: true } } }, orderBy: { joinedAt: "asc" } },
      messages: {
        select: {
          kind: true,
          body: true,
          createdAt: true,
          editedAt: true,
          deletedAt: true,
          sender: { select: { name: true } },
          attachments: { select: { fileName: true } },
          replyTo: { select: { body: true, deletedAt: true, sender: { select: { name: true } } } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!chat) return new Response("Not found", { status: 404 });

  const clock = await workspaceClock();
  const title = chat.kind === "GROUP" ? `Group "${chat.name ?? "Group"}"` : `Chat between ${chat.members.map((m) => m.user.name).join(" and ")}`;
  const lines: string[] = [
    title,
    `Exported by ${me.name} (${me.email}) on ${clock.dateTime(new Date())}`,
    "",
    "Members:",
    ...chat.members.map((m) => `  ${m.user.name} <${m.user.email}> — joined ${clock.dateTime(m.joinedAt)}${m.leftAt ? `, left ${clock.dateTime(m.leftAt)}` : ""}`),
    "",
    `${chat.messages.length} message(s), times in ${clock.offsetLabel()}:`,
    "",
  ];
  for (const m of chat.messages) {
    const at = clock.dateTime(m.createdAt);
    if (m.kind === "SYSTEM") {
      lines.push(`[${at}] — ${m.body}`);
      continue;
    }
    const who = m.sender?.name ?? "Former colleague";
    if (m.deletedAt) {
      lines.push(`[${at}] ${who}: (deleted for everyone on ${clock.dateTime(m.deletedAt)})`);
      continue;
    }
    if (m.replyTo) lines.push(`[${at}] ${who}, replying to ${m.replyTo.sender?.name ?? "a message"}: "${m.replyTo.deletedAt ? "(deleted)" : m.replyTo.body.slice(0, 80).replace(/\s+/g, " ")}"`);
    const body = m.body.split("\n").join("\n    ");
    lines.push(`${m.replyTo ? "    " : `[${at}] ${who}: `}${body}${m.editedAt ? " (edited)" : ""}`);
    for (const a of m.attachments) lines.push(`    [file: ${a.fileName}]`);
  }

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ChatExport", entityId: chat.id, entityLabel: title });
  await logActivity({ kind: "EXPORT", summary: `Exported the chat: ${title}`, entityType: "Chat", entityId: chat.id, metadata: { messages: chat.messages.length } });

  const fileName = `chat-${chat.id}-${clock.today()}.txt`;
  return new Response(lines.join("\r\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
