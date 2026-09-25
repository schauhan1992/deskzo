/**
 * A company's portal state, and how it reads in a table cell — the part of src/lib/portal/state.ts
 * the browser needs, kept apart from the queries so a client component can import it without
 * pulling the database into its bundle.
 */

export type PortalState =
  /** Has access and at least one link that works today. */
  | { kind: "on"; links: number }
  /** Allowed, but nobody has been sent a link — so nobody can actually get in. */
  | { kind: "granted"; links: 0 }
  /** Not allowed, for whatever reason. */
  | { kind: "off"; links: number };

/** How each state reads in a table cell. */
export const PORTAL_STATE_LABEL: Record<PortalState["kind"], { label: string; tone: "green" | "amber" | "default"; hint: string }> = {
  on: { label: "On", tone: "green", hint: "This customer has a working portal link." },
  granted: { label: "No link", tone: "amber", hint: "Allowed a portal, but nobody has been sent a link — so nobody can get in." },
  off: { label: "Off", tone: "default", hint: "No portal access." },
};
