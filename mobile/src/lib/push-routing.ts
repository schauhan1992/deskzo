/**
 * Where a notification takes the person (owner, 22 Oct 2026) — the iPhone's pushes from Deskzo (src/lib/app/push.ts
 * on the server) and the app's own after-call reminder. Each carries only a type and an id or two, never the record:
 *
 *   · `call`        "Ring my phone": the number to dial. Its Call button dials; a tap opens Calls with the ring on top.
 *   · `chat`        A message in a chat: that conversation.
 *   · `approval`    Something waits for the person's decision: Approvals.
 *   · `after-call`  The app's reminder to say how a call went: the after-call sheet for it.
 *
 * Kept free of Expo so it can be tested on its own (src/lib/__tests__/push-routing.test.ts).
 */

/** The "Call" button on a "Ring my phone" notification (category `deskzo-call`, src/lib/notifications.ios.ts). */
export const CALL_ACTION = "call";
/** What iOS calls a plain tap on the notification. */
export const TAP = "expo.modules.notifications.actions.DEFAULT";

export type PushRoute =
  | { kind: "dial"; number: string; label: string | null; request: string | null }
  | { kind: "open"; pathname: string; params?: Record<string, string> }
  | null;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Only an id Deskzo would make: letters, digits, dashes and underscores — never a path or a URL. */
const id = (value: unknown): string | null => {
  const v = text(value);
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
};

/** A number to dial: digits, spaces, dashes, brackets and a leading + — anything else is not a phone number. */
const phone = (value: unknown): string | null => {
  const v = text(value);
  return v && /^\+?[\d\s().-]{3,40}$/.test(v) && /\d{3}/.test(v.replace(/\D/g, "")) ? v : null;
};

export function routeFor(data: Record<string, unknown> | null | undefined, action: string = TAP): PushRoute {
  if (!data) return null;
  switch (data.type) {
    case "call": {
      const number = phone(data.number);
      if (!number) return { kind: "open", pathname: "/calls" };
      const label = text(data.label);
      const request = id(data.request);
      if (action === CALL_ACTION) return { kind: "dial", number, label, request };
      return { kind: "open", pathname: "/calls", params: { ring: request ?? "", number, ...(label ? { label } : {}) } };
    }
    case "chat": {
      const chat = id(data.chat);
      return chat ? { kind: "open", pathname: "/conversation/[id]", params: { id: chat } } : { kind: "open", pathname: "/chat" };
    }
    case "approval":
      return { kind: "open", pathname: "/approvals" };
    case "after-call": {
      const number = phone(data.number);
      const at = Number(data.at);
      if (!number || !Number.isFinite(at) || at <= 0) return null;
      const label = text(data.label);
      return { kind: "open", pathname: "/after-call", params: { number, at: String(at), ...(label ? { label } : {}) } };
    }
    default:
      return null;
  }
}

/**
 * Whether a notification that arrives while the app is open shows as a banner. A chat message doesn't — the app's own
 * banner says so already (src/components/chat/banner.tsx), and the conversation on screen needs neither — nor does the
 * after-call reminder, whose sheet the app opens itself when it comes back.
 */
export function showWhileOpen(data: Record<string, unknown> | null | undefined): boolean {
  if (!data) return true;
  return data.type !== "chat" && data.type !== "after-call";
}
