import type { ActivityKind, ActivitySeverity } from "@prisma/client";

/**
 * The registry of activity kinds — what each one is called, how serious it is, and which group it
 * filters under.
 *
 * Shaped like `PERMISSION_REGISTRY` and the marketing trigger registry: one list, so the filter
 * dropdown, the severity of a written row and the label in the table cannot drift apart. Adding a
 * kind to the Prisma enum without adding it here is a type error, which is the point.
 */

export type ActivityGroup = "SESSION" | "ACCESS" | "DATA" | "DLP" | "PERIMETER" | "ADMIN";

export type ActivityKindDefinition = {
  key: ActivityKind;
  label: string;
  group: ActivityGroup;
  /** Used when the call site does not override it. */
  severity: ActivitySeverity;
  description: string;
};

export const ACTIVITY_GROUPS: { key: ActivityGroup; label: string; description: string }[] = [
  { key: "SESSION", label: "Sessions", description: "Signing in and out, password and two-factor changes, view-as." },
  { key: "ACCESS", label: "Where and on what", description: "New devices and networks, approvals, people held at the door, sessions ended, journeys too fast to be real." },
  { key: "DATA", label: "Data access", description: "Viewing, searching, exporting and printing records." },
  { key: "DLP", label: "Data loss prevention", description: "Copy, paste, screenshot and print attempts the policy refused." },
  { key: "PERIMETER", label: "Perimeter", description: "Blocked crawlers, refused permissions, rate limits." },
  { key: "ADMIN", label: "Administration", description: "Changes to the security policy itself." },
];

export const ACTIVITY_KINDS: ActivityKindDefinition[] = [
  // --- Sessions ---
  { key: "LOGIN", label: "Signed in", group: "SESSION", severity: "INFO", description: "A successful sign-in." },
  {
    key: "LOGIN_FAILED",
    label: "Sign-in failed",
    group: "SESSION",
    severity: "WARNING",
    // Written with no userId when the address is not an account at all, which is itself the signal.
    description: "A rejected sign-in attempt — wrong password, wrong code, or an address with no account.",
  },
  { key: "LOGOUT", label: "Signed out", group: "SESSION", severity: "INFO", description: "A sign-out." },
  { key: "PASSWORD_CHANGED", label: "Password changed", group: "SESSION", severity: "NOTICE", description: "An account password was changed." },
  { key: "TWO_FACTOR_ENABLED", label: "Two-factor set up", group: "SESSION", severity: "NOTICE", description: "An authenticator app was registered." },
  {
    key: "IMPERSONATION_STARTED",
    label: "Started viewing as",
    group: "SESSION",
    severity: "WARNING",
    description: "An admin began using the app as another user. Always worth seeing.",
  },
  { key: "IMPERSONATION_ENDED", label: "Stopped viewing as", group: "SESSION", severity: "NOTICE", description: "An admin returned to their own account." },

  // --- Where and on what: src/lib/access ---
  { key: "NEW_DEVICE", label: "New device", group: "ACCESS", severity: "INFO", description: "A browser this account had not used before — waiting for approval when the role requires it." },
  { key: "DEVICE_APPROVED", label: "Device approved", group: "ACCESS", severity: "NOTICE", description: "An administrator approved a device." },
  { key: "DEVICE_BLOCKED", label: "Device blocked", group: "ACCESS", severity: "WARNING", description: "A device rejected before use, or revoked after — it no longer gets in." },
  { key: "NEW_NETWORK", label: "New network", group: "ACCESS", severity: "NOTICE", description: "Somebody arrived from an address no allow rule covers, on a role that asks to be told or to hold them." },
  { key: "ACCESS_HELD", label: "Held at the door", group: "ACCESS", severity: "WARNING", description: "A signed-in request turned away or held by the access rules." },
  { key: "IMPOSSIBLE_TRAVEL", label: "Impossible travel", group: "ACCESS", severity: "WARNING", description: "Two sign-ins further apart than anybody could have travelled in the time between them." },
  { key: "SESSION_ENDED", label: "Session ended", group: "ACCESS", severity: "NOTICE", description: "An administrator ended somebody's session." },

  // --- Data access ---
  { key: "VIEW", label: "Viewed a record", group: "DATA", severity: "INFO", description: "Opened a record that holds customer data." },
  { key: "SEARCH", label: "Searched", group: "DATA", severity: "INFO", description: "Ran a search. The term is kept with the row." },
  {
    key: "EXPORT",
    label: "Exported data",
    group: "DATA",
    severity: "NOTICE",
    description: "Downloaded records as a file. The most ordinary way data leaves a business.",
  },
  { key: "PRINT", label: "Printed", group: "DATA", severity: "NOTICE", description: "Sent a document to print." },
  {
    key: "BULK_READ",
    label: "Unusual read volume",
    group: "DATA",
    severity: "CRITICAL",
    description:
      "Read far more records in a short window than working through them would need. The one scraping signal the browser cannot hide.",
  },

  // --- DLP ---
  {
    key: "SCREENSHOT",
    label: "Screenshot taken",
    group: "DLP",
    severity: "NOTICE",
    description: "A screenshot attempt within the daily allowance.",
  },
  {
    key: "SCREENSHOT_BLOCKED",
    label: "Screenshot refused",
    group: "DLP",
    severity: "WARNING",
    description: "An attempt past the daily allowance. The picture may still have been taken — see the policy note.",
  },
  { key: "COPY_BLOCKED", label: "Copy refused", group: "DLP", severity: "NOTICE", description: "A copy the policy prevented." },
  { key: "CUT_BLOCKED", label: "Cut refused", group: "DLP", severity: "NOTICE", description: "A cut the policy prevented." },
  { key: "PASTE_BLOCKED", label: "Paste refused", group: "DLP", severity: "INFO", description: "A paste the policy prevented." },
  { key: "CONTEXT_MENU_BLOCKED", label: "Right-click refused", group: "DLP", severity: "INFO", description: "The context menu was suppressed." },
  { key: "PRINT_BLOCKED", label: "Print refused", group: "DLP", severity: "NOTICE", description: "A print the policy prevented." },
  {
    key: "DEVTOOLS_OPENED",
    label: "Developer tools opened",
    group: "DLP",
    severity: "WARNING",
    description:
      "The browser's developer tools appeared to open. Detection is a guess and gives false positives on a docked window resize.",
  },

  // --- Perimeter ---
  {
    key: "BOT_BLOCKED",
    label: "Crawler blocked",
    group: "PERIMETER",
    severity: "NOTICE",
    description: "A request whose user agent identified it as a crawler, scraper or AI collector.",
  },
  {
    key: "PERMISSION_DENIED",
    label: "Permission refused",
    group: "PERIMETER",
    severity: "WARNING",
    description: "Somebody tried to do something their role does not allow. Repeats are worth a conversation.",
  },
  { key: "RATE_LIMITED", label: "Rate limited", group: "PERIMETER", severity: "WARNING", description: "Requests refused for coming too fast." },

  // --- Administration ---
  {
    key: "SECURITY_POLICY_CHANGED",
    label: "Security policy changed",
    group: "ADMIN",
    severity: "CRITICAL",
    description: "The DLP policy itself was edited. Always critical — this is the row that explains why other rows stopped appearing.",
  },
];

const BY_KEY = new Map(ACTIVITY_KINDS.map((k) => [k.key, k]));

export function activityKind(key: ActivityKind): ActivityKindDefinition {
  const found = BY_KEY.get(key);
  // Unreachable while the registry covers the enum, but a missing entry must not blank the table.
  return found ?? { key, label: key, group: "DATA", severity: "INFO", description: "" };
}

export function kindsInGroup(group: ActivityGroup): ActivityKind[] {
  return ACTIVITY_KINDS.filter((k) => k.group === group).map((k) => k.key);
}

export const SEVERITY_ORDER: ActivitySeverity[] = ["INFO", "NOTICE", "WARNING", "CRITICAL"];

/** Severities at or above the given one — how the "minimum severity" filter is expressed. */
export function severitiesAtLeast(min: ActivitySeverity): ActivitySeverity[] {
  return SEVERITY_ORDER.slice(SEVERITY_ORDER.indexOf(min));
}

/** Matches the `Badge` tones in src/components/ui/card.tsx. */
export const SEVERITY_TONE: Record<ActivitySeverity, "default" | "blue" | "amber" | "red"> = {
  INFO: "default",
  NOTICE: "blue",
  WARNING: "amber",
  CRITICAL: "red",
};
