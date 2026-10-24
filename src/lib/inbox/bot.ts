import { INBOX_LIMITS, type ChannelSettings, type InboxKind } from "@/lib/inbox/settings";

/**
 * The Customer inbox's bot (owner, 24 Oct 2026: set answers by default; "like a real human agent talks").
 * Pure — no database, no clock — so the settings page can try it and the checks can walk it.
 *
 *   · It answers from the channel's set answers when a message has one of their words, and otherwise
 *     hands the customer to a person: first asking for a name (and, on a website, a phone number or
 *     email) when the channel says to. Asking for a person hands over at once, by the same route.
 *   · It talks the way a good agent does: a greeting answered with a greeting, thanks with "you're
 *     welcome", the customer called by their first name once it knows it, one short thing at a time,
 *     and never the same line twice running — each line has a few ways of saying it, chosen by `seed`
 *     (the conversation and how far into it), so a conversation reads naturally and a check reads the
 *     same every time.
 *   · Asked whether it's a person, it says honestly that it's the assistant, and offers somebody from the
 *     team. Sounding human is the style; claiming to be one is not.
 */

export type BotState = {
  step: "chatting" | "name" | "contact";
  /** Times a phone number or email was asked for and not given: the second miss hands over regardless. */
  misses?: number;
  /** Set answers given so far — after the first, it asks whether there's anything else. */
  answered?: number;
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
   * Why it said what it said: a set answer; small talk (a greeting, thanks, goodbye, "are you a bot?");
   * on the way to a person because they asked for one; because no set answer fitted ("unknown" — where
   * Deskzo AI may answer instead, if the channel lets it); or asking for and taking their details.
   */
  reason: "answer" | "smalltalk" | "asked" | "unknown" | "details";
};

// ─── What it says, several ways ──────────────────────────────────────────────────────────────────

/** `{first}` is the customer's first name, when there is one; a line that needs it is only picked with one. */
const LINES = {
  askName: ["Happy to get someone for you! Who am I chatting with?", "Sure — I'll bring in a teammate. May I have your name first?", "Of course. Before I pass you over, what's your name?"],
  askContact: [
    "Thanks, {first}! What's the best number or email to reach you on, just in case we get cut off?",
    "Nice to meet you, {first}. Could you share a phone number or email, so we can reach you if the chat drops?",
    "Thanks {first}! And a phone number or email, in case we need to get back to you?",
  ],
  askContactNoName: ["What's the best number or email to reach you on, just in case we get cut off?", "Could you share a phone number or email, so we can reach you if the chat drops?"],
  askContactAgain: ["Hmm, that doesn't look like a phone number or an email. Could you share one, so we don't lose you?", "Sorry, I couldn't spot a number or email there — mind sharing one?"],
  nameAgain: ["Sorry, I didn't quite catch that — what should I call you?", "Oops, I missed that. What's your name?"],
  hello: ["Hi there! 👋 How can I help?", "Hello! What can I do for you today?", "Hey! How can I help you today?"],
  helloNamed: ["Hi {first}! 👋 How can I help?", "Hello {first}! What can I do for you today?"],
  thanks: ["You're welcome! Anything else I can help with?", "Happy to help! Is there anything else?", "Anytime! Let me know if there's anything else."],
  thanksNamed: ["You're welcome, {first}! Anything else I can help with?", "Happy to help, {first}! Is there anything else?"],
  bye: ["Take care! 👋", "Thanks for chatting — have a great day!", "Bye for now! We're here whenever you need us."],
  ack: ["👍", "Great!", "Perfect."],
  anythingElse: ["Anything else I can help with?", "Is there anything else you'd like to know?", "Happy to help with anything else, too."],
  botIntro: [
    "I'm {assistant} — the virtual assistant here. I can answer quick questions, or get someone from the team whenever you like. Just say the word!",
    "I'm {assistant}, the virtual assistant for the team. Happy to help with quick questions — or I can bring in a person straight away if you'd prefer.",
  ],
} as const;

export const ASK_NAME = LINES.askName[0];
export const ASK_NAME_LINES: readonly string[] = LINES.askName;

/** A stable number from a seed — the same seed picks the same line, so the bot is pure. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The customer's first name, for talking to them; null without one. */
export const firstNameOf = (name: string | null | undefined): string | null => name?.trim().split(/\s+/)[0]?.slice(0, 40) || null;

/** One way of saying `lines`, by `seed`, with the customer's first name and the assistant's name filled in. */
function say(lines: readonly string[], seed: string, first: string | null, assistant = "the assistant"): string {
  return lines[hash(seed) % lines.length]!.replace(/\{first\}/g, first ?? "").replace(/\{assistant\}/g, assistant);
}

/**
 * A channel's own line with `{name}` in it, as the customer reads it: their first name, or — without one —
 * the name and the comma before it left out ("Thanks, {name}!" → "Thanks!").
 */
export function withName(text: string, first: string | null): string {
  return first ? text.replace(/\{name\}/g, first) : text.replace(/,?\s*\{name\}/g, "");
}

// ─── Reading the customer ────────────────────────────────────────────────────────────────────────

const WANTS_PERSON = /\b(agent|human|person|someone|somebody|executive|representative|operator|staff|talk to|speak to|speak with|call me|call back|callback|real person)\b/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** The whole message is one of these — said on its own, not inside a question. */
const HELLO = /^(hi+|hello+|hey+|hiya|namaste|namaskar|hola|good (morning|afternoon|evening)|greetings|yo)[\s!.,👋🙏]*$/iu;
const THANKS = /^(ok(ay)?[\s,]*)?(thanks?|thank you|thx|ty|many thanks|thank u|dhanyavad|shukriya|thanks a lot)( (so much|a lot))?[\s!.🙏😊👍]*$/iu;
const BYE = /^(bye+|goodbye|good night|see (you|ya)|take care|cya|tata)[\s!.👋]*$/iu;
const ACK = /^(ok(ay)?|k|kk|cool|great|nice|got it|alright|sure|fine|done|👍|👌|🙂|😊)[\s!.]*$/iu;
const ARE_YOU_BOT = /\b(are you|r u|is this) (a |an )?(bot|robot|machine|ai|human|real( person)?|person|automated)\b|\bam i (talking|chatting|speaking) (to|with) (a |an )?(bot|human|real person|person|machine)\b/i;

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
  if (HELLO.test(cleaned) || THANKS.test(cleaned) || ACK.test(cleaned)) return null;
  return cleaned;
}

/** The bot's opening words, or null when it isn't on. */
export function botGreeting(settings: ChannelSettings): string | null {
  return settings.bot.on ? settings.greeting : null;
}

/** The small talk a whole message is, if it's only that. */
export function smallTalkOf(text: string): "hello" | "thanks" | "bye" | "ack" | "bot" | null {
  const t = text.trim();
  if (HELLO.test(t)) return "hello";
  if (THANKS.test(t)) return "thanks";
  if (BYE.test(t)) return "bye";
  if (ACK.test(t)) return "ack";
  if (ARE_YOU_BOT.test(t)) return "bot";
  return null;
}

// ─── A turn ──────────────────────────────────────────────────────────────────────────────────────

/** On the way to a person: what's still to ask, or the handover. */
function towardsPerson(settings: ChannelSettings, kind: InboxKind, known: Known, reason: BotTurn["reason"], seed: string, misses = 0): BotTurn {
  const ask = settings.bot.askDetails;
  const first = firstNameOf(known.name);
  if (ask && !known.name) return { replies: [say(LINES.askName, `${seed}:name`, null)], state: { step: "name", misses }, handover: false, learned: {}, reason };
  // WhatsApp already knows the number; a website visitor is asked once, and again once.
  if (ask && kind === "WEB" && !known.email && !known.phone && misses < 2) {
    const line = misses ? say(LINES.askContactAgain, `${seed}:again`, first) : say(first ? LINES.askContact : LINES.askContactNoName, `${seed}:contact`, first);
    return { replies: [line], state: { step: "contact", misses }, handover: false, learned: {}, reason };
  }
  return { replies: [withName(settings.bot.handover, first)], state: { step: "chatting" }, handover: true, learned: {}, reason };
}

/**
 * The bot's turn after a customer's message. `seed` makes the choice of words: the conversation and how
 * far into it (src/lib/inbox/server.ts gives its id and the number of messages so far).
 */
export function botReply(input: { text: string; settings: ChannelSettings; state: BotState | null; known: Known; kind: InboxKind; seed?: string }): BotTurn {
  const { text, settings, kind } = input;
  const seed = input.seed ?? text;
  const state: BotState = input.state ?? { step: "chatting" };
  const known = { ...input.known };
  const first = firstNameOf(known.name);
  const assistant = settings.bot.name.trim() || "the assistant";

  if (state.step === "name") {
    const name = nameIn(text);
    if (!name) return { replies: [say(LINES.nameAgain, `${seed}:nameagain`, null)], state, handover: false, learned: {}, reason: "details" };
    known.name = name;
    return { ...towardsPerson(settings, kind, known, "details", seed), learned: { name } };
  }

  if (state.step === "contact") {
    const found = contactIn(text);
    if (!found.email && !found.phone) return towardsPerson(settings, kind, known, "details", seed, (state.misses ?? 0) + 1);
    Object.assign(known, found);
    return { ...towardsPerson(settings, kind, known, "details", seed), learned: found };
  }

  // Chatting. Small talk first, as a person would answer it — without handing over.
  const talk = smallTalkOf(text);
  const keep = { step: "chatting" as const, answered: state.answered ?? 0 };
  if (talk === "hello") return { replies: [say(first ? LINES.helloNamed : LINES.hello, `${seed}:hello`, first)], state: keep, handover: false, learned: {}, reason: "smalltalk" };
  if (talk === "thanks") return { replies: [say(first ? LINES.thanksNamed : LINES.thanks, `${seed}:thanks`, first)], state: keep, handover: false, learned: {}, reason: "smalltalk" };
  if (talk === "bye") return { replies: [say(LINES.bye, `${seed}:bye`, first)], state: keep, handover: false, learned: {}, reason: "smalltalk" };
  if (talk === "ack") return { replies: [say(LINES.ack, `${seed}:ack`, first)], state: keep, handover: false, learned: {}, reason: "smalltalk" };
  if (talk === "bot") return { replies: [say(LINES.botIntro, `${seed}:bot`, first, assistant)], state: keep, handover: false, learned: {}, reason: "smalltalk" };

  // A name or a number given unasked is kept all the same.
  const offered = contactIn(text);
  if (WANTS_PERSON.test(text)) {
    Object.assign(known, offered);
    return { ...towardsPerson(settings, kind, known, "asked", seed), learned: offered };
  }
  const answer = matchAnswer(text, settings.bot.answers);
  if (answer) {
    const answered = (state.answered ?? 0) + 1;
    // After the first answer, a second short message — the way a person checks in.
    const replies = answered === 1 ? [answer, say(LINES.anythingElse, `${seed}:else`, first)] : [answer];
    return { replies, state: { step: "chatting", answered }, handover: false, learned: offered, reason: "answer" };
  }
  Object.assign(known, offered);
  return { ...towardsPerson(settings, kind, known, "unknown", seed), learned: offered };
}

/**
 * How long a person would take to type `text` before it appears: a beat to read, then a quick typist's
 * pace, capped so nobody waits long. For the website bubble's typing dots and WhatsApp's pause.
 */
export function typingMs(text: string): number {
  return Math.round(Math.min(3200, Math.max(900, 500 + text.length * 22)));
}
