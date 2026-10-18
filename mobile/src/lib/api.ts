import { calls } from "@/lib/native";

/** Deskzo's /api/app (src/lib/app/handler.ts on the server): `{ data }`, or `{ error: { code, message, fields } }`. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

type Listener = () => void;
const signedOutListeners = new Set<Listener>();

/** Told when Deskzo says this phone is no longer signed in. */
export function onSignedOut(listener: Listener): () => void {
  signedOutListeners.add(listener);
  return () => void signedOutListeners.delete(listener);
}

export async function request<T>(
  where: { baseUrl: string; host: string | null; token?: string | null },
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (where.token) headers.authorization = `Bearer ${where.token}`;
  if (where.host) headers.host = where.host;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${where.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "offline", "Can't reach Deskzo. Check the phone's internet connection.");
  }
  const text = await res.text();
  let json: { data?: T; error?: { code: string; message: string; fields?: Record<string, string> } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Not Deskzo answering — a captive portal, a proxy.
  }
  if (!res.ok) {
    const err = json.error ?? { code: `http_${res.status}`, message: "Deskzo didn't answer as expected. Try again in a moment." };
    if (res.status === 401 && err.code === "signed_out") signedOutListeners.forEach((l) => l());
    throw new ApiError(res.status, err.code, err.message, err.fields);
  }
  return json.data as T;
}

/** As this phone's person. */
export function api<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const session = calls.getSession();
  if (!session) return Promise.reject(new ApiError(401, "signed_out", "This phone isn't paired."));
  return request<T>(session, method, path, body);
}

// What the server answers (src/lib/app/calls.ts).

export type Me = {
  person: { id: string; name: string; email: string };
  workspace: { name: string | null };
  phone: { id: string; name: string; platform: string; call_sync: boolean };
  /** Older servers answer only calls; the rest count as open there. */
  can: { calls: boolean; attendance?: boolean; tasks?: boolean };
  /** The workspace's screen rules for this person (src/lib/app/dlp.ts); none from an older server. */
  screen?: ScreenRulesFromServer;
};

export type ScreenRulesFromServer = {
  screenshots: { limit: number; used: number } | null;
  watermark: { label: string; opacity: number; scope: "CUSTOMER_DATA" | "EVERY_PAGE" } | null;
};

export type Outcome = "CONNECTED" | "NO_ANSWER" | "BUSY" | "SWITCHED_OFF" | "WRONG_NUMBER" | "LEFT_VOICEMAIL" | "CALLBACK_REQUESTED" | "NOT_INTERESTED";

export const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: "CONNECTED", label: "Connected" },
  { value: "CALLBACK_REQUESTED", label: "Callback requested" },
  { value: "NOT_INTERESTED", label: "Not interested" },
  { value: "NO_ANSWER", label: "No answer" },
  { value: "BUSY", label: "Busy" },
  { value: "SWITCHED_OFF", label: "Switched off" },
  { value: "LEFT_VOICEMAIL", label: "Left voicemail" },
  { value: "WRONG_NUMBER", label: "Wrong number" },
];

export type ReviewCall = {
  id: string;
  number: string;
  direction: "in" | "out";
  outcome: Outcome;
  started_at: string;
  duration: number;
  contact: string | null;
  company: string;
  lead_id: string | null;
  open_leads: { id: string; ref: string | null; title: string; stage: string }[];
};

export type Callback = { id: string; due_at: string; number: string; contact: string | null; company: string; notes: string | null };

export type Ring = { id: string; number: string; label: string; asked_at: string };

// The everyday screens (src/lib/app/daily.ts).

export type Attendance = { status: string | null; check_in_at: string | null; check_out_at: string | null; worked_minutes: number | null };

export type Task = { id: string; title: string; due: string | null; status: string; priority: string | null; company: string | null; can_work: boolean };

export type Today = {
  date: string;
  attendance: Attendance | null;
  tasks: { due_today: Task[]; open: number; overdue: number } | null;
  approvals_waiting: number;
  leave: {
    balances: { type_id: string; code: string; name: string; available: number; pending: number }[];
    upcoming: { id: string; type: string; from: string; to: string; days: number; status: string }[];
  } | null;
};

export type ApprovalKind = "leave" | "correction" | "expense" | "workflow" | "order" | "device";

export type Approval = { kind: ApprovalKind; id: string; title: string; detail: string | null; from: string | null; asked_at: string | null; reason_to_reject: boolean };

export type LeaveRequest = {
  id: string;
  type: string;
  from: string;
  to: string;
  from_half_day: boolean;
  to_half_day: boolean;
  days: number;
  reason: string;
  status: string;
  note: string | null;
  decided_by: string | null;
  asked_at: string | null;
};

export type Leave = {
  types: { id: string; code: string; name: string; paid: boolean }[];
  balances: { type_id: string; name: string; paid: boolean; available: number; pending: number; used: number }[];
  requests: LeaveRequest[];
};
