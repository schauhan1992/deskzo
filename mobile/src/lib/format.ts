/** Times and lengths as the app shows them, in the phone's own time zone. */

export function when(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (at.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${dm(at)} ${time}`;
}

export function length(seconds: number): string {
  if (!seconds) return "not answered";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export const overdue = (iso: string) => new Date(iso).getTime() < Date.now();

/** A calendar day as Deskzo sends it (yyyy-mm-dd), read as that day wherever the phone is. */
export const dayOf = (key: string) => new Date(`${key}T12:00:00`);

/** yyyy-mm-dd for a day on the phone's calendar. */
export const keyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "20 Oct" — day before month, as Deskzo writes dates, whatever the phone's language orders them. */
const dm = (d: Date) => `${d.getDate()} ${d.toLocaleDateString(undefined, { month: "short" })}`;

/** "Mon 20 Oct", or "Today" / "Tomorrow" / "Yesterday". */
export function dayLabel(key: string, today: string = keyOf(new Date())): string {
  const diff = Math.round((dayOf(key).getTime() - dayOf(today).getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return `${dayOf(key).toLocaleDateString(undefined, { weekday: "short" })} ${dm(dayOf(key))}`;
}

/** "20 Oct" or "20 – 24 Oct" for a span of days. */
export function span(from: string, to: string): string {
  const a = dayOf(from);
  if (from === to) return dm(a);
  const b = dayOf(to);
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  return `${sameMonth ? a.getDate() : dm(a)} – ${dm(b)}`;
}

/** A time of day from Deskzo's timestamp, in the phone's zone. */
export const clockTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "7h 45m" for minutes worked. */
export function worked(minutes: number | null): string {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

/** "1 day", "2.5 days". */
export const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
