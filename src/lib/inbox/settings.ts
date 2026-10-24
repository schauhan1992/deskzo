/**
 * A Customer inbox channel's settings (owner, 24 Oct 2026; `InboxChannel.settings`): what its bot says
 * and knows, whether a new conversation makes a lead, office hours, who gets a conversation, and — for
 * a website's bubble — how it looks and which sites may show it. Pure and client-safe: the settings page,
 * the bot (./bot.ts), the widget's route and the checks all read it. A stored value is read through
 * `channelSettings`, which fills in whatever is missing, so a channel saved before a setting existed
 * still works.
 */

export type InboxKind = "WEB" | "WHATSAPP";

/** One of the bot's set answers: given when a customer's message has one of the words. */
export type BotAnswer = { keywords: string; answer: string };

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** A day's opening, as the workspace's clock reads it: "09:00" to "18:00". Null: closed all day. */
export type OpenSpan = { from: string; to: string } | null;

export type ChannelSettings = {
  /** The first thing a customer is told — the bubble's welcome, or the bot's reply to a first WhatsApp message. */
  greeting: string;
  bot: {
    /** Set answers, by default (owner: AI answers are a switch of their own). */
    on: boolean;
    answers: BotAnswer[];
    /** Before handing over, ask for a name — and on the website, a phone number or email. */
    askDetails: boolean;
    /** What the customer is told when the bot hands them to a person. */
    handover: string;
    /**
     * Deskzo AI answers what the set answers don't (owner: an option you switch on). It is told only the
     * conversation, the set answers and `about`, and hands over whenever it isn't sure. Each answer is
     * charged in AI credits as `chargedTo` — whoever switched it on, set by the server, never the form.
     */
    ai: { on: boolean; about: string; chargedTo: string | null };
  };
  /** A new customer makes a lead (owner: WhatsApp and bot chats can create leads) — once the bot has a name and a way to reach them. */
  autoLead: boolean;
  /** Office hours: outside them, a customer is told when the team is back — once, not every message. */
  hours: { on: boolean; days: Record<Weekday, OpenSpan>; away: string };
  /** Who gets a conversation the bot hands over, or one that starts without it: the queue, or each in turn (`people`; empty: everybody who answers). */
  assign: { mode: "queue" | "rotate"; people: string[] };
  /** WEB: the bubble's title and colour, and which corner. */
  look: { title: string; colour: string; position: "right" | "left" };
  /** WEB: the sites allowed to show the bubble, as origins ("https://example.com"). Empty: any site. */
  allowedSites: string[];
};

export const INBOX_LIMITS = {
  /** A message either way. WhatsApp's own limit is 4,096; a chat bubble needs far less. */
  message: 2000,
  name: 80,
  greeting: 300,
  answers: 30,
  keywords: 200,
  answer: 1000,
  handover: 300,
  sites: 10,
  title: 60,
  channelName: 60,
  ticketTitle: 200,
  about: 3000,
  away: 300,
  team: 50,
} as const;

/** WhatsApp lets a business write freely for 24 hours after the customer's last message; after that, only an approved template. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_GREETING = "Hi! How can we help you today? Type “agent” at any time to talk to a person.";
export const DEFAULT_HANDOVER = "Thanks — someone from the team will reply here shortly.";
export const DEFAULT_AWAY = "Thanks for your message! We're closed right now, and we'll reply as soon as we're back.";
export const DEFAULT_COLOUR = "#0249FE";
const NINE_TO_SIX: OpenSpan = { from: "09:00", to: "18:00" };

export function defaultChannelSettings(kind: InboxKind): ChannelSettings {
  return {
    greeting: DEFAULT_GREETING,
    bot: { on: kind === "WEB", answers: [], askDetails: true, handover: DEFAULT_HANDOVER, ai: { on: false, about: "", chargedTo: null } },
    autoLead: true,
    hours: { on: false, days: { mon: NINE_TO_SIX, tue: NINE_TO_SIX, wed: NINE_TO_SIX, thu: NINE_TO_SIX, fri: NINE_TO_SIX, sat: null, sun: null }, away: DEFAULT_AWAY },
    assign: { mode: "queue", people: [] },
    look: { title: "Chat with us", colour: DEFAULT_COLOUR, position: "right" },
    allowedSites: [],
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, fallback = ""): string => (typeof v === "string" ? v.trim().slice(0, max) : fallback);
const HEX = /^#[0-9a-f]{6}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A day's opening as stored, or the default when it isn't one: closed stays closed, nonsense is the default. */
function spanOf(raw: unknown, fallback: OpenSpan): OpenSpan {
  if (raw === null) return null;
  if (!isObj(raw) || typeof raw.from !== "string" || typeof raw.to !== "string" || !TIME.test(raw.from) || !TIME.test(raw.to) || raw.from >= raw.to) return fallback;
  return { from: raw.from, to: raw.to };
}

/** A stored value, whole: what's missing or malformed is the default. Never throws. */
export function channelSettings(raw: unknown, kind: InboxKind): ChannelSettings {
  const d = defaultChannelSettings(kind);
  if (!isObj(raw)) return d;
  const bot = isObj(raw.bot) ? raw.bot : {};
  const ai = isObj(bot.ai) ? bot.ai : {};
  const look = isObj(raw.look) ? raw.look : {};
  const hours = isObj(raw.hours) ? raw.hours : {};
  const days = isObj(hours.days) ? hours.days : {};
  const assign = isObj(raw.assign) ? raw.assign : {};
  const answers = Array.isArray(bot.answers)
    ? bot.answers
        .filter(isObj)
        .map((a) => ({ keywords: str(a.keywords, INBOX_LIMITS.keywords), answer: str(a.answer, INBOX_LIMITS.answer) }))
        .filter((a) => a.keywords && a.answer)
        .slice(0, INBOX_LIMITS.answers)
    : [];
  return {
    greeting: str(raw.greeting, INBOX_LIMITS.greeting, d.greeting),
    bot: {
      on: typeof bot.on === "boolean" ? bot.on : d.bot.on,
      answers,
      askDetails: typeof bot.askDetails === "boolean" ? bot.askDetails : d.bot.askDetails,
      handover: str(bot.handover, INBOX_LIMITS.handover) || d.bot.handover,
      ai: { on: ai.on === true, about: str(ai.about, INBOX_LIMITS.about), chargedTo: typeof ai.chargedTo === "string" && ai.chargedTo ? ai.chargedTo : null },
    },
    autoLead: typeof raw.autoLead === "boolean" ? raw.autoLead : d.autoLead,
    hours: {
      on: hours.on === true,
      days: Object.fromEntries(WEEKDAYS.map((w) => [w, w in days ? spanOf(days[w], d.hours.days[w]) : d.hours.days[w]])) as Record<Weekday, OpenSpan>,
      away: str(hours.away, INBOX_LIMITS.away) || d.hours.away,
    },
    assign: {
      mode: assign.mode === "rotate" ? "rotate" : "queue",
      people: Array.isArray(assign.people) ? [...new Set(assign.people.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length < 64))].slice(0, INBOX_LIMITS.team) : [],
    },
    look: {
      title: str(look.title, INBOX_LIMITS.title) || d.look.title,
      colour: typeof look.colour === "string" && HEX.test(look.colour) ? look.colour : d.look.colour,
      position: look.position === "left" ? "left" : "right",
    },
    allowedSites: Array.isArray(raw.allowedSites) ? raw.allowedSites.map((s) => siteOrigin(String(s))).filter((s): s is string => !!s).slice(0, INBOX_LIMITS.sites) : [],
  };
}

/** "example.com/contact" → "https://example.com"; null for something that isn't a web address. */
export function siteOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Settings as the page sends them, checked for saving: the reason it can't be saved, or the settings.
 * A blank answer row is dropped rather than refused — the form adds rows freely. The AI's `chargedTo` is
 * the server's to set (src/actions/inbox-admin.ts), whatever the form sends.
 */
export function checkChannelSettings(input: unknown, kind: InboxKind): { ok: true; settings: ChannelSettings } | { ok: false; error: string } {
  if (!isObj(input)) return { ok: false, error: "Nothing to save." };
  const bot = isObj(input.bot) ? input.bot : {};
  const rawAnswers = Array.isArray(bot.answers) ? bot.answers.filter(isObj) : [];
  const filled = rawAnswers.filter((a) => str(a.keywords, 10_000) || str(a.answer, 10_000));
  if (filled.length > INBOX_LIMITS.answers) return { ok: false, error: `Keep it to ${INBOX_LIMITS.answers} answers.` };
  for (const a of filled) {
    if (!str(a.keywords, 10_000) || !str(a.answer, 10_000)) return { ok: false, error: "Each answer needs both its words and what the bot says." };
    if (String(a.keywords).trim().length > INBOX_LIMITS.keywords) return { ok: false, error: `Keep an answer's words under ${INBOX_LIMITS.keywords} characters.` };
    if (String(a.answer).trim().length > INBOX_LIMITS.answer) return { ok: false, error: `Keep an answer under ${INBOX_LIMITS.answer} characters.` };
  }
  if (typeof input.greeting === "string" && input.greeting.trim().length > INBOX_LIMITS.greeting) return { ok: false, error: `Keep the greeting under ${INBOX_LIMITS.greeting} characters.` };
  const ai = isObj(bot.ai) ? bot.ai : {};
  if (typeof ai.about === "string" && ai.about.trim().length > INBOX_LIMITS.about) return { ok: false, error: `Keep what the AI may say under ${INBOX_LIMITS.about.toLocaleString("en-IN")} characters.` };
  if (ai.on === true && !str(ai.about, INBOX_LIMITS.about) && filled.length === 0) return { ok: false, error: "Give the AI something to go on: set answers, or a few lines about your business." };
  const hours = isObj(input.hours) ? input.hours : {};
  if (typeof hours.away === "string" && hours.away.trim().length > INBOX_LIMITS.away) return { ok: false, error: `Keep the away message under ${INBOX_LIMITS.away} characters.` };
  if (isObj(hours.days)) {
    for (const w of WEEKDAYS) {
      const day = hours.days[w];
      if (day === null || day === undefined) continue;
      if (!isObj(day) || typeof day.from !== "string" || typeof day.to !== "string" || !TIME.test(day.from) || !TIME.test(day.to)) return { ok: false, error: "Give each open day its hours as 09:00 to 18:00." };
      if (day.from >= day.to) return { ok: false, error: "A day's closing time comes after its opening time." };
    }
  }
  const assign = isObj(input.assign) ? input.assign : {};
  if (Array.isArray(assign.people) && assign.people.length > INBOX_LIMITS.team) return { ok: false, error: `Name at most ${INBOX_LIMITS.team} people to take turns.` };
  const look = isObj(input.look) ? input.look : {};
  if (typeof look.colour === "string" && look.colour && !HEX.test(look.colour)) return { ok: false, error: "Choose the colour as #RRGGBB." };
  const sites = Array.isArray(input.allowedSites) ? input.allowedSites.map((s) => String(s).trim()).filter(Boolean) : [];
  if (sites.length > INBOX_LIMITS.sites) return { ok: false, error: `Name at most ${INBOX_LIMITS.sites} sites.` };
  const bad = sites.find((s) => !siteOrigin(s));
  if (bad) return { ok: false, error: `“${bad.slice(0, 60)}” isn't a website address.` };
  return { ok: true, settings: channelSettings({ ...input, bot: { ...bot, answers: filled } }, kind) };
}

/**
 * Whether the team is in, by the channel's office hours, at a moment as the workspace's clock reads it
 * (src/lib/time/zone.ts `parts`: 0 is Sunday). Always in while office hours are off.
 */
export function withinHours(hours: ChannelSettings["hours"], at: { weekday: number; hour: number; minute: number }): boolean {
  if (!hours.on) return true;
  const day = hours.days[WEEKDAYS[(at.weekday + 6) % 7]!];
  if (!day) return false;
  const now = `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
  return now >= day.from && now < day.to;
}

/** CNV-000123: what staff quote. */
export const conversationRef = (seq: number) => `CNV-${String(seq).padStart(6, "0")}`;

/** Whether free text may go to a WhatsApp customer now. */
export function whatsappWindowOpen(lastCustomerAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!lastCustomerAt) return false;
  const at = typeof lastCustomerAt === "string" ? new Date(lastCustomerAt) : lastCustomerAt;
  return now.getTime() - at.getTime() < WHATSAPP_WINDOW_MS;
}

/** The snippet a website pastes before </body>. */
export function widgetSnippet(origin: string, publicKey: string): string {
  return `<script src="${origin}/api/inbox/public/widget.js" data-key="${publicKey}" async></script>`;
}
