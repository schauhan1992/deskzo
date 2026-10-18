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
  return `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

export function length(seconds: number): string {
  if (!seconds) return "not answered";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export const overdue = (iso: string) => new Date(iso).getTime() < Date.now();
