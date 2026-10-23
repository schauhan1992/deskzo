/**
 * What the web processes tell each other (owner, 23 Oct 2026). With DESKZO_WEB_PROCESSES above one,
 * deploy/start.mjs runs that many copies of the app on the one port, and passes on whatever one of them
 * broadcasts to the rest — so state held in a process's memory stays one state:
 *
 *   · a cache cleared in one (an IP rule saved, maintenance switched on) is cleared in all — `shared`;
 *   · a sign-in failure, or a once-a-window allowance taken, counts in all (src/lib/security/lockout.ts,
 *     throttle.ts);
 *   · a chat message reaches a person whose stream is held by another (src/lib/chat/bus.ts).
 *
 * One process — every development server, script and check, and production until the setting is
 * raised — has nobody to tell: `broadcast` does nothing and every handler stays unused.
 *
 * On `globalThis`, like the chat bus: route handlers and pages are bundled apart, and each copy of a
 * module that registers a handler must hear the broadcast.
 */

type Envelope = { deskzo: "hub"; topic: string; payload: unknown; from: number };
type HubState = { handlers: Map<string, Set<(payload: unknown) => void>>; listening: boolean };

function hubState(): HubState {
  const g = globalThis as { [key: symbol]: HubState | undefined };
  const key = Symbol.for("deskzo.cluster-hub");
  g[key] ??= { handlers: new Map(), listening: false };
  return g[key]!;
}

/** Whether there are other processes to tell: a worker of deploy/start.mjs's cluster. */
export function clustered(): boolean {
  return typeof process.send === "function" && (process.env.DESKZO_WEB_WORKER ?? "") === "1";
}

function listen(state: HubState) {
  if (state.listening || !clustered()) return;
  state.listening = true;
  process.on("message", (message: unknown) => {
    const m = message as Partial<Envelope> | null;
    if (!m || m.deskzo !== "hub" || typeof m.topic !== "string" || m.from === process.pid) return;
    for (const handler of state.handlers.get(m.topic) ?? []) {
      try {
        handler(m.payload);
      } catch (err) {
        console.error(`[hub] ${m.topic}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

/** Has every other process hear this. Nothing at all with one process. Never throws. */
export function broadcast(topic: string, payload: unknown): void {
  if (!clustered()) return;
  try {
    process.send!({ deskzo: "hub", topic, payload, from: process.pid } satisfies Envelope);
  } catch {
    // The supervisor going away — the container is stopping with it.
  }
}

/** What to do when another process broadcasts on `topic`. Returns the function that stops it. */
export function onBroadcast(topic: string, handler: (payload: unknown) => void): () => void {
  const state = hubState();
  listen(state);
  const set = state.handlers.get(topic) ?? new Set();
  set.add(handler);
  state.handlers.set(topic, set);
  return () => set.delete(handler);
}

/**
 * A cache's clear, run in every process: here at once, and in the others as they hear of it. The clear
 * takes no argument, or one string — whatever it names must mean the same in every process.
 */
export function shared<A extends [] | [string]>(name: string, clear: (...args: A) => void): (...args: A) => void {
  onBroadcast(`clear:${name}`, (payload) => clear(...((Array.isArray(payload) ? payload : []) as A)));
  return (...args: A) => {
    clear(...args);
    broadcast(`clear:${name}`, args);
  };
}
