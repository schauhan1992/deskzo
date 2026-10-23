/**
 * What Deskzo answers on the sales screens (src/lib/app/sales.ts on the server) — the public API's own shapes
 * (src/lib/api/v1), so a field the workspace hides from the person comes back as the web shows it, masked.
 */

export type Named = { id: string; name: string };
export type RefTo = { id: string; ref: string | null; name: string };

export type StageColor = string;

export type Stage = { id: string; key: string; name: string; status: string; color: StageColor; required_fields: string[] };

export type Pipeline = { id: string; key: string; name: string; sales: boolean; stages: Stage[] };

export type Pipelines = {
  pipelines: Pipeline[];
  sources: { value: string; label: string }[];
  activity_types: { value: "CALL" | "MEETING" | "EMAIL" | "NOTE"; label: string }[];
};

export type Lead = {
  id: string;
  ref: string;
  title: string;
  description: string | null;
  status: string;
  stage: { id: string; key: string; name: string } | null;
  pipeline: { id: string; key: string; name: string } | null;
  /** A number, or the masked text the workspace shows in its place. */
  value: number | string | null;
  expected_close_date: string | null;
  source: string | null;
  company: RefTo | null;
  contact: (RefTo & { email?: string | null; phone?: string | null }) | null;
  owner: Named | null;
  created_at: string;
  updated_at: string;
};

export type Activity = {
  id: string;
  type: "CALL" | "MEETING" | "EMAIL" | "NOTE" | "STAGE_CHANGE" | string;
  notes: string;
  occurred_at: string;
  by: Named | null;
  lead?: { id: string; title: string };
};

export type LeadDetail = Lead & { activities: Activity[]; stages: Stage[] };

export type Contact = {
  id: string;
  ref: string;
  name: string;
  designation: string | null;
  designation_name: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
  company: RefTo | null;
};

export type Company = {
  id: string;
  ref: string;
  name: string;
  relationship_type: string;
  stage: string | null;
  website: string | null;
  industry: Named | null;
  owner: Named | null;
  account_manager: Named | null;
  address: { label: string | null; line: string | null; city: string | null; state: string | null; pincode: string | null; country: string | null; gstin: string | null } | null;
};

export type CompanyDetail = Company & { contacts: Contact[]; open_leads: Lead[]; activities: Activity[] };

export type SearchResult = { kind: "lead" | "company" | "contact"; id: string; title: string; subtitle: string | null };
