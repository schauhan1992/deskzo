import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who a public API call acts as — the person whose key it is — for the length of that one call
 * (owner, 17 Oct 2026).
 *
 * The app decides who is acting in one place: `auth()` and `requireUser()` (src/lib/auth.ts,
 * src/lib/session.ts). Inside a call made with a key that src/lib/api/handler.ts has checked — the
 * key, its scopes, the person active and allowed in from where they are — those answer with the
 * key's person, so every action the API calls runs through exactly the checks the screens do: the
 * permissions, what records reach them, the masking. Nothing the API does needs a second copy of a
 * rule, and so nothing can drift from the screens.
 *
 * Only `apiRoute` (src/lib/api/handler.ts) enters it, after the key is checked; check:public-api
 * holds that. A browser can never reach it: it lives in this call's async context and nowhere else.
 */
export type ApiActor = {
  userId: string;
  name: string;
  email: string;
  role: string;
  /** The key's public half and name — named in the audit log of everything the call changes. */
  keyId: string;
  keyName: string;
  scopes: readonly string[];
  /**
   * "app": the Deskzo app on the person's phone (src/lib/app/handler.ts, owner 18 Oct 2026) — the same
   * acting-as, entered there once the phone's secret and its device are checked; keyId and keyName are
   * the phone's.
   */
  channel?: "app";
};

// One store for the process, whichever bundle loads this module.
const STORE = Symbol.for("deskzo.api-actor");
type Holder = { [STORE]?: AsyncLocalStorage<ApiActor> };
const holder = globalThis as Holder;
const store: AsyncLocalStorage<ApiActor> = (holder[STORE] ??= new AsyncLocalStorage<ApiActor>());

/** The key's person, inside a checked API call; null everywhere else. */
export function apiActor(): ApiActor | null {
  return store.getStore() ?? null;
}

/**
 * Runs `work` as the key's person. Only for src/lib/api/handler.ts, once the key is checked, and
 * src/lib/app/handler.ts, once the phone is.
 */
export function runAsApiActor<T>(actor: ApiActor, work: () => Promise<T>): Promise<T> {
  return store.run(actor, work);
}
