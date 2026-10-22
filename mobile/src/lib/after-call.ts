/**
 * The after-call sheet's timing on an iPhone (owner, 22 Oct 2026). iOS gives no app the call log, so a call can't log
 * itself as it does on Android. What the app does know is when it starts a call — a callback, "Ring my phone", a
 * number on the Deskzo tab — and when it comes back afterwards. So: a call started from here is remembered; once the
 * phone has gone to the call (the app left the screen) and comes back, the sheet asks how it went.
 *
 *   · iOS asks "Call …?" first. Cancelled there, the app is back on screen without having left it — no call, no
 *     sheet, and the call is forgotten (so a later trip to the home screen isn't taken for it).
 *   · Back within a few hours: the sheet. Later than that, it is history, not a call just made — forgotten.
 *   · One call at a time: a second call started replaces the first.
 *
 * The remembering (a store that survives the app being closed during a call) is given by the iOS side,
 * src/lib/calling.ios.ts. Kept free of React Native so it can be tested on its own.
 */

export type CallVia = "ring" | "callback" | "page" | "list";

export type PendingCall = {
  number: string;
  /** Who, as the screen that started it named them — "Ravi Kumar, Acme". */
  label: string | null;
  startedAt: number;
  via: CallVia;
  /** The "Ring my phone" request it answers. */
  request: string | null;
  /** The app left the screen after the call started: the phone went to the call. */
  away: boolean;
};

/** After this long the call isn't one just made: no sheet. */
export const ASK_WITHIN_MS = 3 * 3_600_000;
/** The reminder, if the person hasn't come back by then: a long call is fine — it waits in Notification Centre. */
export const REMIND_AFTER_S = 120;

export type Store = { load(): PendingCall | null; save(call: PendingCall | null): void };

let store: Store = { load: () => null, save: () => {} };
let pending: PendingCall | null = null;
let loaded = false;

export function setStore(next: Store) {
  store = next;
  loaded = false;
}

function current(): PendingCall | null {
  if (!loaded) {
    pending = store.load();
    loaded = true;
  }
  return pending;
}

function set(next: PendingCall | null) {
  pending = next;
  loaded = true;
  store.save(next);
}

/** A call the app is about to hand to the phone. */
export function started(call: { number: string; label?: string | null; via: CallVia; request?: string | null }, now: number = Date.now()): PendingCall {
  const next: PendingCall = { number: call.number, label: call.label ?? null, startedAt: now, via: call.via, request: call.request ?? null, away: false };
  set(next);
  return next;
}

/** The app left the screen. Only a call started before it went counts as the phone going to it. */
export function wentAway() {
  const call = current();
  if (call && !call.away) set({ ...call, away: true });
}

/** Whether the sheet is due for this call now: the phone went to it, and not too long ago. */
export function due(call: PendingCall | null, now: number = Date.now()): call is PendingCall {
  return !!call && call.away && now - call.startedAt >= 0 && now - call.startedAt < ASK_WITHIN_MS;
}

/**
 * Back on screen: the call to ask about, if one is due — handed over once. One the phone never went to ("Call …?"
 * cancelled) or long gone is forgotten.
 */
export function cameBack(now: number = Date.now()): PendingCall | null {
  const call = current();
  if (!call) return null;
  set(null);
  return due(call, now) ? call : null;
}

export function forget() {
  set(null);
}

export const peek = () => current();
