import { tenantKey } from "@/lib/tenancy/cache";
import { broadcast, clustered, onBroadcast } from "@/lib/cluster/hub";
import type { ChatEvent } from "@/lib/chat/types";

/**
 * Who is listening for chat, and how to reach them: each open live stream (src/app/api/chat/stream)
 * registers here under its workspace and person, and an action that changes a chat publishes to the
 * people it concerns.
 *
 * In memory. With several web processes in the container (deploy/start.mjs, src/lib/cluster/hub.ts) a
 * stream is held by one of them and the action that publishes may run in another, so each process keeps
 * a copy of who is listening in the others (`remote`, by process), and an event for somebody listening
 * elsewhere is passed on to be delivered there. A second container would need the messages passed
 * between containers — Postgres NOTIFY on a direct connection, or Redis — and nothing else would change.
 *
 * On `globalThis` rather than in module scope, like the tenancy state (src/lib/tenancy/state.ts): the
 * stream is a route handler and the actions are bundled with the pages, so a module-level Map would
 * be two Maps, and nothing published would reach a listener. Keys start with the workspace's id, so
 * one workspace's events never reach another's listeners.
 */

type Listener = (event: ChatEvent) => void;
type BusState = { listeners: Map<string, Set<Listener>>; remote: Map<string, Set<number>>; joined: boolean };

function busState(): BusState {
  const g = globalThis as { [key: symbol]: BusState | undefined };
  const key = Symbol.for("deskzo.chat-bus");
  g[key] ??= { listeners: new Map(), remote: new Map(), joined: false };
  const state = g[key]!;
  if (!state.joined) join(state);
  return state;
}

/** Hears the other processes: who starts and stops listening there, and events for people listening here. */
function join(state: BusState) {
  state.joined = true;
  if (!clustered()) return;
  const mark = (key: string, pid: number, on: boolean) => {
    const pids = state.remote.get(key) ?? new Set<number>();
    if (on) pids.add(pid);
    else pids.delete(pid);
    if (pids.size === 0) state.remote.delete(key);
    else state.remote.set(key, pids);
  };
  onBroadcast("chat:listen", (p) => {
    const { key, pid, on } = p as { key: string; pid: number; on: boolean };
    mark(key, pid, on);
  });
  // A process just started: everybody says who they hold, so it knows from its first publish.
  onBroadcast("chat:hello", () => broadcast("chat:present", { pid: process.pid, keys: [...state.listeners.keys()] }));
  onBroadcast("chat:present", (p) => {
    const { pid, keys } = p as { pid: number; keys: string[] };
    for (const key of keys) mark(key, pid, true);
  });
  // A process stopped (deploy/start.mjs says which): nobody is listening there any more.
  onBroadcast("process:gone", (p) => {
    const { pid } = p as { pid: number };
    for (const key of [...state.remote.keys()]) mark(key, pid, false);
  });
  onBroadcast("chat:event", (p) => {
    const { deliveries } = p as { deliveries: { key: string; event: ChatEvent }[] };
    for (const { key, event } of deliveries) deliverHere(state, key, event);
  });
  broadcast("chat:hello", { pid: process.pid });
}

const keyOf = (tenantId: string, userId: string) => `${tenantId}|${userId}`;

/** Registers one open stream. Returns the function that removes it. */
export function subscribe(tenantId: string, userId: string, listener: Listener): () => void {
  const { listeners } = busState();
  const key = keyOf(tenantId, userId);
  const set = listeners.get(key) ?? new Set<Listener>();
  if (set.size === 0) broadcast("chat:listen", { key, pid: process.pid, on: true });
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(key) === set) {
      listeners.delete(key);
      broadcast("chat:listen", { key, pid: process.pid, on: false });
    }
  };
}

/** Whether this person has chat open anywhere — a tab, the rail — in any process. */
export function isListening(tenantId: string, userId: string): boolean {
  const state = busState();
  const key = keyOf(tenantId, userId);
  return (state.listeners.get(key)?.size ?? 0) > 0 || state.remote.has(key);
}

/** The people of this workspace with chat open now. */
export function listeningIn(tenantId: string): string[] {
  const state = busState();
  const prefix = `${tenantId}|`;
  const keys = new Set([...state.listeners.keys(), ...state.remote.keys()]);
  return [...keys].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

function deliverHere(state: BusState, key: string, payload: ChatEvent) {
  for (const listener of state.listeners.get(key) ?? []) {
    try {
      listener(payload);
    } catch {
      // A stream that closed between the lookup and the write: its own cleanup removes it.
    }
  }
}

/** Sends one event to each of these people's open streams, in the current workspace. Never throws. */
export async function publish(userIds: Iterable<string>, event: ChatEvent | ((userId: string) => ChatEvent)): Promise<void> {
  const tenantId = await tenantKey();
  publishIn(tenantId, userIds, event);
}

/** `publish` for a caller that already knows the workspace — the stream itself. */
export function publishIn(tenantId: string, userIds: Iterable<string>, event: ChatEvent | ((userId: string) => ChatEvent)): void {
  const state = busState();
  // With other processes, every one of these people is passed on, in one message, whatever this process
  // last heard of who listens where: one that has only just started hasn't heard yet, and an event must
  // not be lost to that. Each process delivers to its own listeners only.
  const others = clustered();
  const elsewhere: { key: string; event: ChatEvent }[] = [];
  for (const userId of new Set(userIds)) {
    const key = keyOf(tenantId, userId);
    const here = state.listeners.has(key);
    if (!here && !others) continue;
    const payload = typeof event === "function" ? event(userId) : event;
    if (here) deliverHere(state, key, payload);
    if (others) elsewhere.push({ key, event: payload });
  }
  if (elsewhere.length) broadcast("chat:event", { deliveries: elsewhere });
}

// Heard from as soon as this module is loaded, rather than at its first use: a process learns who is
// listening in the others before anybody asks it.
busState();
