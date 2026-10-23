/** What Deskzo answers on the field-work screens (src/lib/app/field.ts on the server). */

export type VisitRow = {
  id: string;
  ref: string;
  status: "PLANNED" | "CHECKED_IN" | "COMPLETED" | "CANCELLED" | "NO_SHOW" | string;
  status_label: string;
  purpose: string;
  purpose_label: string;
  agenda: string | null;
  scheduled_for: string;
  check_in_at: string | null;
  check_out_at: string | null;
  outcome: string | null;
  company: { id: string; ref: string | null; name: string } | null;
  contact: { id: string; name: string; phone?: string | null; email?: string | null } | null;
  lead: { id: string; title: string } | null;
  by: { id: string; name: string } | null;
};

export type VisitPlace = { kind: "IN" | "OUT"; at: string; latitude: number; longitude: number; accuracy_m: number | null; mocked: boolean | null };

export type VisitDetail = VisitRow & {
  address: string | null;
  distance_km: number | null;
  places: VisitPlace[];
  expenses: { id: string; ref: string; category: string; amount: number | null; status: string }[];
};

export type VisitOptions = { purposes: { value: string; label: string }[]; contacts: { id: string; name: string }[]; leads: { id: string; title: string }[] };

export type Expense = {
  id: string;
  ref: string;
  category: string;
  category_label: string;
  amount: number | null;
  spent_on: string | null;
  description: string;
  payment_mode: string;
  payment_mode_label: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "REIMBURSED" | string;
  status_label: string;
  decision_note: string | null;
  has_receipt: boolean;
  visit: { id: string; ref: string | null } | null;
  company: { id: string; name: string } | null;
};

export type ExpenseOptions = {
  categories: { value: string; label: string }[];
  payment_modes: { value: string; label: string }[];
  /** Over this many rupees a claim needs its receipt to be submitted; null — never. */
  receipt_required_above: number | null;
  receipt_max_bytes: number;
};

export type CalendarItem = {
  id: string;
  kind: "meeting" | string;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  location: string | null;
  join_url: string | null;
  organizer: boolean;
};
