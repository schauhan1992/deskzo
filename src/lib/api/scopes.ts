/**
 * What a public API key may touch (owner, 17 Oct 2026) — chosen when the key is made, one read and
 * one write scope per area. A scope only opens the door: inside it, the key's person's own
 * permissions and the records that reach them decide what is seen and changed (src/lib/api/actor.ts).
 *
 * Plain data, so the settings form, the handler and the documentation read the same list.
 */

export const API_SCOPES = [
  { key: "companies:read", area: "Companies", label: "Read companies" },
  { key: "companies:write", area: "Companies", label: "Add and change companies" },
  { key: "contacts:read", area: "Contacts", label: "Read contacts" },
  { key: "contacts:write", area: "Contacts", label: "Add and change contacts" },
  { key: "leads:read", area: "Leads", label: "Read leads" },
  { key: "leads:write", area: "Leads", label: "Add leads, change them, move their stage, add notes" },
  { key: "tasks:read", area: "Tasks", label: "Read tasks" },
  { key: "tasks:write", area: "Tasks", label: "Add and change tasks" },
  { key: "tickets:read", area: "Tickets", label: "Read tickets" },
  { key: "tickets:write", area: "Tickets", label: "Open tickets, change them, add comments" },
  { key: "orders:read", area: "Orders", label: "Read orders" },
  { key: "invoices:read", area: "Invoices", label: "Read invoices" },
] as const;

export type ApiScope = (typeof API_SCOPES)[number]["key"];

export const API_SCOPE_KEYS: readonly ApiScope[] = API_SCOPES.map((s) => s.key);

export const isApiScope = (value: unknown): value is ApiScope => typeof value === "string" && (API_SCOPE_KEYS as readonly string[]).includes(value);

/** Calls a key may make in a minute — enough for a sync, not for scraping the book. */
export const API_RATE_PER_MINUTE = 120;
/** The most rows one list call returns. */
export const API_MAX_PAGE_SIZE = 100;
export const API_DEFAULT_PAGE_SIZE = 50;
/** The largest request body taken, in bytes. */
export const API_MAX_BODY_BYTES = 256 * 1024;
/** How long an Idempotency-Key's answer is kept. */
export const API_IDEMPOTENCY_HOURS = 24;
