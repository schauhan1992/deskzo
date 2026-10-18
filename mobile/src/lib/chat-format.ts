import type { ChatMemberView, ChatMessageView } from "@/lib/chat-types";

/** Times and ticks as the chat shows them, in the phone's own zone. */

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** The list's right-hand time: "10:32 am" today, "Yesterday", the weekday this week, else "12 Oct". */
export function listTime(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  const now = new Date();
  if (sameDay(at, now)) return time(at);
  if (sameDay(at, new Date(now.getTime() - 86_400_000))) return "Yesterday";
  if (now.getTime() - at.getTime() < 6 * 86_400_000) return at.toLocaleDateString(undefined, { weekday: "long" });
  return `${at.getDate()} ${at.toLocaleDateString(undefined, { month: "short" })}${at.getFullYear() === now.getFullYear() ? "" : ` ${at.getFullYear()}`}`;
}

export const bubbleTime = (iso: string) => time(new Date(iso));

/** The line between days: "Today", "Yesterday", or the date. */
export function dayLine(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  if (sameDay(at, now)) return "Today";
  if (sameDay(at, new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return at.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: at.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export const dayKey = (iso: string) => new Date(iso).toDateString();

/** "Last seen today at 4:10 pm", "… yesterday …", "… on 12 Oct". */
export function lastSeenLine(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  const now = new Date();
  if (sameDay(at, now)) return `last seen today at ${time(at)}`;
  if (sameDay(at, new Date(now.getTime() - 86_400_000))) return `last seen yesterday at ${time(at)}`;
  return `last seen ${at.getDate()} ${at.toLocaleDateString(undefined, { month: "short" })}`;
}

export const fileSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

/**
 * One of my messages' ticks, from where the others have read and received up to (as the website draws them): read by
 * everyone still in the chat — blue; reached everyone — grey double; otherwise one.
 */
export function ticksFor(message: ChatMessageView, members: ChatMemberView[], meId: string): "sent" | "delivered" | "read" {
  const others = members.filter((m) => m.userId !== meId && !m.leftAt && m.joinedAt <= message.createdAt);
  if (others.length === 0) return "sent";
  if (others.every((m) => m.lastReadAt && m.lastReadAt >= message.createdAt)) return "read";
  if (others.every((m) => (m.lastDeliveredAt && m.lastDeliveredAt >= message.createdAt) || (m.lastReadAt && m.lastReadAt >= message.createdAt))) return "delivered";
  return "sent";
}
