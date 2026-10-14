/**
 * A pipeline's simple automations (owner, 14 Oct 2026 — Bigin's "workflow automation", kept simple):
 * when a lead arrives in a pipeline or moves into one of its stages, do up to ten of these, in order —
 *
 *   · TASK    a task for the lead's owner or a named person, due so many days on;
 *   · EMAIL   an email to the lead's contact, sent from the owner's own mailbox (My profile → Mailbox),
 *             so it is theirs, in their Sent folder, and the reply comes to them;
 *   · ASSIGN  the lead given to a named person, or to whoever the assignment rules choose;
 *   · NOTIFY  a notification to the owner or a named person.
 *
 * Text may carry {{lead}}, {{company}}, {{contact}}, {{owner}}, {{stage}}, {{pipeline}} and {{value}}.
 * Running them is src/lib/pipeline/automations.ts; this is what a saved automation may say, checked —
 * pure, so the settings screen and `check:team-pipelines` share it.
 */

export const AUTOMATION_LIMITS = { actions: 10, perPipeline: 30, name: 80, title: 160, subject: 200, body: 4000, message: 300, days: 365 } as const;

export type AutomationAction =
  | { type: "TASK"; title: string; dueInDays: number; assignTo: string }
  | { type: "EMAIL"; subject: string; body: string }
  | { type: "ASSIGN"; userId: string }
  | { type: "NOTIFY"; to: string; message: string };

export type ActionType = AutomationAction["type"];

/** Who an action goes to besides a named person: the lead's owner. ASSIGN may also name the assignment rules. */
export const OWNER = "OWNER";
export const RULES = "RULES";

export const ACTION_LABELS: Record<ActionType, string> = {
  TASK: "Create a task",
  EMAIL: "Email the contact",
  ASSIGN: "Give the lead to",
  NOTIFY: "Notify",
};

export const MERGE_TAGS = ["lead", "company", "contact", "owner", "stage", "pipeline", "value"] as const;
export type MergeValues = Record<(typeof MERGE_TAGS)[number], string>;

/** Fills {{tag}} with its value; an unknown tag is left as typed, so a mistake shows rather than vanishes. */
export function mergeText(text: string, values: MergeValues): string {
  return text.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (whole, tag: string) => ((MERGE_TAGS as readonly string[]).includes(tag) ? values[tag as keyof MergeValues] : whole));
}

const PERSON = /^[a-z0-9_-]{8,40}$/i;
const text = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "");

/**
 * A saved automation's actions, checked — or why they can't be saved. `people` is who may be named (active
 * users of the workspace); the lead's owner is always allowed.
 */
export function parseActions(raw: unknown, people: ReadonlySet<string>): { ok: true; actions: AutomationAction[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "Add something for it to do." };
  if (raw.length > AUTOMATION_LIMITS.actions) return { ok: false, error: `An automation can do ${AUTOMATION_LIMITS.actions} things at most.` };
  const actions: AutomationAction[] = [];
  for (const item of raw) {
    const a = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const named = (who: unknown, allowed: string[]) => {
      const id = text(who);
      return allowed.includes(id) || (PERSON.test(id) && people.has(id)) ? id : null;
    };
    switch (a.type) {
      case "TASK": {
        const title = text(a.title);
        const days = Number(a.dueInDays);
        const assignTo = named(a.assignTo, [OWNER]);
        if (!title) return { ok: false, error: "Give the task a title." };
        if (title.length > AUTOMATION_LIMITS.title) return { ok: false, error: `Keep a task's title to ${AUTOMATION_LIMITS.title} characters.` };
        if (!Number.isInteger(days) || days < 0 || days > AUTOMATION_LIMITS.days) return { ok: false, error: `A task is due 0 to ${AUTOMATION_LIMITS.days} days after.` };
        if (!assignTo) return { ok: false, error: "Choose who the task is for." };
        actions.push({ type: "TASK", title, dueInDays: days, assignTo });
        break;
      }
      case "EMAIL": {
        const subject = text(a.subject);
        const body = text(a.body);
        if (!subject || !body) return { ok: false, error: "Give the email a subject and a message." };
        if (subject.length > AUTOMATION_LIMITS.subject) return { ok: false, error: `Keep the subject to ${AUTOMATION_LIMITS.subject} characters.` };
        if (body.length > AUTOMATION_LIMITS.body) return { ok: false, error: `Keep the message to ${AUTOMATION_LIMITS.body} characters.` };
        actions.push({ type: "EMAIL", subject, body });
        break;
      }
      case "ASSIGN": {
        const userId = named(a.userId, [RULES]);
        if (!userId) return { ok: false, error: "Choose who to give the lead to." };
        actions.push({ type: "ASSIGN", userId });
        break;
      }
      case "NOTIFY": {
        const message = text(a.message);
        const to = named(a.to, [OWNER]);
        if (!message) return { ok: false, error: "Write what the notification says." };
        if (message.length > AUTOMATION_LIMITS.message) return { ok: false, error: `Keep a notification to ${AUTOMATION_LIMITS.message} characters.` };
        if (!to) return { ok: false, error: "Choose who to notify." };
        actions.push({ type: "NOTIFY", to, message });
        break;
      }
      default:
        return { ok: false, error: "Choose what each step does." };
    }
  }
  return { ok: true, actions };
}

/** Actions as stored, read back leniently: anything unreadable is skipped, never run half-understood. */
export function storedActions(raw: unknown): AutomationAction[] {
  if (!Array.isArray(raw)) return [];
  const all = new Set<string>();
  for (const item of raw) {
    const a = (item ?? {}) as Record<string, unknown>;
    for (const key of ["assignTo", "userId", "to"]) if (typeof a[key] === "string") all.add(a[key] as string);
  }
  const parsed = parseActions(raw, all);
  return parsed.ok ? parsed.actions : [];
}

/** An action in a line, for the settings list: "Task for the owner, due in 2 days". `name` names a person by id. */
export function describeAction(a: AutomationAction, name: (userId: string) => string): string {
  const who = (id: string) => (id === OWNER ? "the owner" : id === RULES ? "whoever the assignment rules choose" : name(id));
  switch (a.type) {
    case "TASK":
      return `Task “${a.title}” for ${who(a.assignTo)}, due ${a.dueInDays === 0 ? "the same day" : `in ${a.dueInDays} day${a.dueInDays === 1 ? "" : "s"}`}`;
    case "EMAIL":
      return `Email “${a.subject}” to the contact, from the owner's mailbox`;
    case "ASSIGN":
      return `Give the lead to ${who(a.userId)}`;
    case "NOTIFY":
      return `Notify ${who(a.to)}`;
  }
}

/** A plain-text message as the HTML an email carries: escaped, paragraphs and line breaks kept. */
export function textToHtml(body: string): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}
