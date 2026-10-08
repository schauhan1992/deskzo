/**
 * Reminders that chime while Deskzo is open (owner, 8 Oct 2026): a meeting about to start, a task due,
 * a note's reminder, a callback due. On for everybody unless they turn them off — all of them, or one
 * kind — under Notifications. Kept on the person (`User.reminderSounds`), so it follows them from one
 * browser to the next. Plain: read by the bell in the browser and by the server alike.
 */

export const SOUND_KINDS = [
  { key: "meetings", label: "A meeting is about to start", hint: "Ten minutes before, from your connected calendar." },
  { key: "tasks", label: "A task is due or overdue", hint: "On the day it falls due." },
  { key: "notes", label: "A note or to-do reminder", hint: "When a sticky note's reminder comes round." },
  { key: "callbacks", label: "A callback is due", hint: "At the time you promised to ring back." },
] as const;

export type SoundKind = (typeof SOUND_KINDS)[number]["key"];

/** Each kind on unless set false; `off` silences every one. */
export type ReminderSounds = { off?: boolean } & Partial<Record<SoundKind, boolean>>;

/** The notification types that chime, and the kind each one is. */
export const SOUND_FOR_TYPE: Record<string, SoundKind> = {
  MEETING_SOON: "meetings",
  TASK_DUE: "tasks",
  TASK_OVERDUE: "tasks",
  NOTE_REMINDER: "notes",
  CALLBACK_DUE: "callbacks",
};

/** Whatever is stored, as settings — anything unreadable is "all on". */
export function parseReminderSounds(value: unknown): ReminderSounds {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: ReminderSounds = {};
  if (raw.off === true) out.off = true;
  for (const { key } of SOUND_KINDS) if (raw[key] === false) out[key] = false;
  return out;
}

/** Whether a notification of this type chimes for somebody with these settings. */
export function chimes(settings: ReminderSounds, type: string): boolean {
  const kind = SOUND_FOR_TYPE[type];
  if (!kind || settings.off) return false;
  return settings[kind] !== false;
}
