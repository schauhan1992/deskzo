import { tenantKey } from "@/lib/tenancy/cache";
import type { ChatEvent } from "@/lib/chat/types";

/**
 * Who is listening for chat, and how to reach them: each open live stream (src/app/api/chat/stream)
 * registers here under its workspace and person, and an action that changes a chat publishes to the
 * people it concerns.
 *
 * In this process's memory. That is enough while Deskzo runs as one container (Coolify); a second
 * container would need the messages passed between them — Postgres NOTIFY on a direct connection, or
 * Redis — and nothing else here would change.
 *
 * On `globalThis` rather than in module scope, like the tenancy state (src/lib/tenancy/state.ts): the
 * stream is a route handler and the actions are bundled with the pages, so a module-level Map would
 * be two Maps, and nothing published would reach a listener. Keys start with the workspace's id, so
 * one workspace's events never reach another's listeners.
 */

type Listener = (event: ChatEvent) => void;
type BusState = { listeners: Map<string, Set<Listener>> };

function busState(): BusState {
  const g = globalThis as { [key: symbol]: BusState | undefined };
  const key = Symbol.for("deskzo.chat-bus");
  g[key] ??= { listeners: new Map() };
  return g[key]!;
}

const keyOf = (tenantId: string, userId: string) => `${tenantId}|${userId}`;

/** Registers one open stream. Returns the function that removes it. */
export function subscribe(tenantId: string, userId: string, listener: Listener): () => void {
  const { listeners } = busState();
  const key = keyOf(tenantId, userId);
  const set = listeners.get(key) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Whether this person has chat open anywhere — a tab, the rail. */
export function isListening(tenantId: string, userId: string): boolean {
  return (busState().listeners.get(keyOf(tenantId, userId))?.size ?? 0) > 0;
}

/** The people of this workspace with chat open now. */
export function listeningIn(tenantId: string): string[] {
  const prefix = `${tenantId}|`;
  return [...busState().listeners.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** Sends one event to each of these people's open streams, in the current workspace. Never throws. */
export async function publish(userIds: Iterable<string>, event: ChatEvent | ((userId: string) => ChatEvent)): Promise<void> {
  const tenantId = await tenantKey();
  publishIn(tenantId, userIds, event);
}

/** `publish` for a caller that already knows the workspace — the stream itself. */
export function publishIn(tenantId: string, userIds: Iterable<string>, event: ChatEvent | ((userId: string) => ChatEvent)): void {
  const { listeners } = busState();
  for (const userId of new Set(userIds)) {
    const set = listeners.get(keyOf(tenantId, userId));
    if (!set) continue;
    const payload = typeof event === "function" ? event(userId) : event;
    for (const listener of set) {
      try {
        listener(payload);
      } catch {
        // A stream that closed between the lookup and the write: its own cleanup removes it.
      }
    }
  }
}
