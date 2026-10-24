import { INBOX_LIMITS, type ChannelSettings, type InboxKind } from "@/lib/inbox/settings";

/**
 * The Customer inbox's bot (owner, 24 Oct 2026: set answers by default). Pure — no database, no clock —
 * so the settings page can try it and the checks can walk it. It answers from the channel's set answers
 * when a message has one of their words, and otherwise hands the customer to a person: first asking for
 * a name (and, on a website, a phone number or email) when the channel says to, so whoever picks it up —
 * and the lead it may make — knows who they are. Asking for a person ("agent", "talk to someone") hands
 * over at once, by the same route.
 */

export type BotState = {
  step: "chatting" | "name" | "contact";
  /** Times a phone number or email was asked for and not given: the second miss hands over regardless. */
  misses?: number;
};

export type Known = { name: string | null; email: string | null; phone: string | null };

export type BotTurn = {
  replies: string[];
  state: BotState;
  /** The bot is done: a person takes the conversation from here. */
  handover: boolean;
  /** What the customer told it. */
  learned: Partial<Known>;
  /**
   * Why it said what it said: a set answer; on the way to a person because they asked for one; because
   * no set answer fitted ("unknown" — where Deskzo AI may answer instead, if the channel lets it); or
   * asking for and taking their details.
   */
  reason: "answer" | "asked" | "unknown" | "details";
};

export const ASK_NAME = "Before I pass you to the team — what's your name?";
export const ASK_CONTACT = "Thanks! What's the best phone number or email to reach you on, in case we get cut off?";
export const ASK_CONTACT_AGAIN = "That doesn't look like a phone number or an email. Could you share one so we can reach you?";
export const NAME_AGAIN = "Sorry, I didn't catch your name. What should we call you?";

const WANTS_PERSON = /\b(agent|human|person|someone|somebody|executive|representative|operator|staff|talk to|speak to|speak with|call me|call back|callback)\b/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/** Words and phrases, lower case, from an answer's comma-separated list. */
function keywordsOf(list: string): string[] {
  return list
    .split(",")
    .map((k) => k.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((k) => k.length >= 2);
}

/** Whether `phrase` appears in `text` as whole words. */
function hasPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * The set answer a message asks for — the one with most of its words in it, and between two with as many,
 * the one whose longest match says more ("price list" over "price") — or null.
 */
export function matchAnswer(text: string, answers: ChannelSettings["bot"]["answers"]): string | null {
  let best: { answer: string; hits: number; longest: number } | null = null;
  for (const a of answers) {
    const matched = keywordsOf(a.keywords).filter((k) => hasPhrase(text, k));
    if (!matched.length) continue;
    const longest = Math.max(...matched.map((k) => k.length));
    if (!best || matched.length > best.hits || (matched.length === best.hits && longest > best.longest)) best = { answer: a.answer, hits: matched.length, longest };
  }
  return best?.answer ?? null;
}

/** An email or a phone number in what the customer typed. */
export function contactIn(text: string): { email?: string; phone?: string } {
  const email = text.match(EMAIL)?.[0];
  if (email) return { email: email.toLowerCase() };
  const candidate = text.match(/\+?[\d][\d\s().-]{6,20}\d/)?.[0];
  if (candidate) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) return { phone: candidate.trim().startsWith("+") ? `+${digits}` : digits };
  }
  return {};
}

/** A name from "I'm Priya", "my name is Priya Sharma" or just "Priya" — or null for something that isn't one. */
export function nameIn(text: string): string | null {
  const cleaned = text
    .trim()
    .replace(/^(hi|hello|hey)[,!.\s]+/i, "")
    .replace(/^(my name is|my name's|name is|this is|i am|i'm|im|it's|its)\s+/i, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > INBOX_LIMITS.name) return null;
  if (EMAIL.test(cleaned) || /\d{3,}/.test(cleaned)) return null;
  if (cleaned.split(/\s+/).length > 5) return null;
  return cleaned;
}

/** The bot's opening words, or null when it isn't on. */
export function botGreeting(settings: ChannelSettings): string | null {
  return settings.bot.on ? settings.greeting : null;
}

/** On the way to a person: what's still to ask, or the handover. */
function towardsPerson(settings: ChannelSettings, kind: InboxKind, known: Known, reason: BotTurn["reason"], misses = 0): BotTurn {
  const ask = settings.bot.askDetails;
  if (ask && !known.name) return { replies: [ASK_NAME], state: { step: "name", misses }, handover: false, learned: {}, reason };
  // WhatsApp already knows the number; a website visitor is asked once, and again once.
  if (ask && kind === "WEB" && !known.email && !known.phone && misses < 2) {
    return { replies: [misses ? ASK_CONTACT_AGAIN : ASK_CONTACT], state: { step: "contact", misses }, handover: false, learned: {}, reason };
  }
  return { replies: [settings.bot.handover], state: { step: "chatting" }, handover: true, learned: {}, reason };
}

/** The bot's turn after a customer's message. */
export function botReply(input: { text: string; settings: ChannelSettings; state: BotState | null; known: Known; kind: InboxKind }): BotTurn {
  const { text, settings, kind } = input;
  const state: BotState = input.state ?? { step: "chatting" };
  const known = { ...input.known };

  if (state.step === "name") {
    const name = nameIn(text);
    if (!name) return { replies: [NAME_AGAIN], state, handover: false, learned: {}, reason: "details" };
    known.name = name;
    return { ...towardsPerson(settings, kind, known, "details"), learned: { name } };
  }

  if (state.step === "contact") {
    const found = contactIn(text);
    if (!found.email && !found.phone) return towardsPerson(settings, kind, known, "details", (state.misses ?? 0) + 1);
    Object.assign(known, found);
    return { ...towardsPerson(settings, kind, known, "details"), learned: found };
  }

  // Chatting: a name or a number given unasked is kept all the same.
  const offered = contactIn(text);
  if (WANTS_PERSON.test(text)) {
    Object.assign(known, offered);
    return { ...towardsPerson(settings, kind, known, "asked"), learned: offered };
  }
  const answer = matchAnswer(text, settings.bot.answers);
  if (answer) return { replies: [answer], state: { step: "chatting" }, handover: false, learned: offered, reason: "answer" };
  Object.assign(known, offered);
  return { ...towardsPerson(settings, kind, known, "unknown"), learned: offered };
}
