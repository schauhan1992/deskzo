/**
 * Activity's shapes, apart from the database so the feed can read them in the browser
 * (src/lib/activity/timeline.ts builds them).
 */

/**
 * One field an edit changed — "Phone: 98100… → 99110…" on the Activity tab. `withheld`: a field some can't
 * see (a contact's email or phone) — that it changed is said, never what to.
 */
export type FieldChange = { field: string; label: string; from: string | null; to: string | null; withheld?: boolean };

export type ActivityGroupKey =
  | "company"
  | "contacts"
  | "leads"
  | "orders"
  | "documents"
  | "payments"
  | "tickets"
  | "tasks"
  | "meetings"
  | "visits"
  | "calls"
  | "notes"
  | "emails"
  | "projects"
  | "expenses"
  | "purchase"
  | "feedback"
  | "portal"
  | "signins"
  | "other";

export const ACTIVITY_GROUPS: { key: ActivityGroupKey; label: string }[] = [
  { key: "company", label: "Company" },
  { key: "contacts", label: "Contacts" },
  { key: "leads", label: "Leads" },
  { key: "notes", label: "Notes & meetings" },
  { key: "calls", label: "Calls" },
  { key: "emails", label: "Emails" },
  { key: "orders", label: "Orders" },
  { key: "documents", label: "Documents" },
  { key: "payments", label: "Payments" },
  { key: "purchase", label: "Purchase" },
  { key: "tickets", label: "Tickets" },
  { key: "tasks", label: "Tasks" },
  { key: "meetings", label: "Calendar" },
  { key: "visits", label: "Visits" },
  { key: "projects", label: "Projects" },
  { key: "expenses", label: "Expenses" },
  { key: "feedback", label: "Feedback" },
  { key: "portal", label: "Portal" },
  { key: "signins", label: "Sign-ins" },
  { key: "other", label: "Other" },
];

export type ActivityItem = {
  id: string;
  /** ISO time. */
  at: string;
  who: { id: string; name: string } | null;
  /** An admin viewing as `who` who really did it. */
  asBy: string | null;
  group: ActivityGroupKey;
  /** For a change: created, changed or removed. */
  action: "CREATE" | "UPDATE" | "DELETE" | null;
  title: string;
  detail: string | null;
  changes: FieldChange[];
};

export type ActivityPage = { items: ActivityItem[]; more: boolean; before: string | null };
