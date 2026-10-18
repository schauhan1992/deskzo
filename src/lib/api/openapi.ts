import { z, type ZodType } from "zod";
import { API_DEFAULT_PAGE_SIZE, API_IDEMPOTENCY_HOURS, API_MAX_BODY_BYTES, API_MAX_PAGE_SIZE, API_RATE_PER_MINUTE, API_SCOPES, type ApiScope } from "@/lib/api/scopes";
import * as S from "@/lib/api/v1/schemas";

/**
 * The public API, described once (owner, 17 Oct 2026): every operation — its address, the scope it
 * needs, what it takes and what it answers. The OpenAPI document, the Postman collection, the
 * developer pages (deskzo.com/developers) and the in-app Settings › Developers & API are all made from
 * this, and the request bodies are the very schemas the endpoints validate with (src/lib/api/v1/
 * schemas.ts). check:public-api sends every example here through the real endpoints and compares
 * what comes back with the example answers, so the documentation can't drift from the code.
 *
 * Plain data and pure functions: nothing here reads a database.
 */

export type ApiTag = "Account" | "Companies" | "Contacts" | "Leads" | "Tasks" | "Tickets" | "Orders" | "Invoices";
export type ApiExampleKey = keyof typeof EXAMPLES;

export type ApiOperation = {
  id: string;
  method: "GET" | "POST" | "PATCH";
  /** Under /api/v1, with `{ref}` or `{id}` for the record. */
  path: string;
  tag: ApiTag;
  scope: ApiScope | null;
  summary: string;
  description?: string;
  query?: { name: string; description: string; values?: readonly string[] }[];
  body?: ZodType;
  bodyExample?: Record<string, unknown>;
  status: 200 | 201;
  list?: boolean;
  example: ApiExampleKey;
};

const company = { id: "cm2k9x0aa0001deskzo0001", ref: "COM-000123", name: "Acme Chemicals India Pvt Ltd" };
const person = { id: "cm2k9x0aa0002deskzo0002", name: "Priya Sharma" };
const at = "2026-10-17T09:30:00.000Z";

/** An answer of each kind, as the endpoints give it. Keys only in a single record's answer: `DETAIL_ONLY`. */
export const EXAMPLES = {
  me: { key: { id: "dzk_0123456789abcdef0123", name: "Zapier", scopes: ["leads:read", "leads:write"] }, person: { id: person.id, name: person.name, email: "priya@acme.example", role: "SALES" } },
  company: {
    ...company,
    relationship_type: "CLIENT",
    stage: "CUSTOMER",
    website: "https://acme.example",
    linkedin_url: null,
    industry: { id: "cm2k9x0aa0003deskzo0003", name: "Chemicals" },
    tags: ["key-account"],
    source: "REFERRAL",
    payment_terms: "NET_30",
    employee_count: 250,
    owner: person,
    account_manager: person,
    address: { label: "Head Office", line: "Plot 12, MIDC", city: "Mumbai", state: "Maharashtra", pincode: "400093", country: "India", gstin: "27AAACA1234A1Z5" },
    custom_fields: { region: "west" },
    contacts: [] as unknown[],
    created_at: at,
    updated_at: at,
  },
  contact: {
    id: "cm2k9x0aa0004deskzo0004",
    ref: "CON-000456",
    name: "Rahul Mehta",
    designation: "IT_MANAGER",
    designation_name: "IT Manager",
    email: "rahul@acme.example",
    phone: "+91 98765 43210",
    linkedin_url: null,
    is_primary: true,
    receives_documents: true,
    left_at: null,
    company,
    custom_fields: {},
    created_at: at,
    updated_at: at,
  },
  lead: {
    id: "cm2k9x0aa0005deskzo0005",
    ref: "LEAD-000789",
    title: "Microsoft 365 for 25 people",
    description: "Renewal plus five more seats.",
    status: "QUALIFYING",
    stage: { id: "cm2k9x0aa0006deskzo0006", key: "qualifying", name: "Qualifying" },
    pipeline: { id: "lpip_sales", key: "sales", name: "Sales" },
    value: 150000,
    expected_close_date: "2026-11-15",
    source: "WEBSITE",
    source_detail: "API",
    score: 72,
    lost_reason: null,
    company,
    contact: { id: "cm2k9x0aa0004deskzo0004", ref: "CON-000456", name: "Rahul Mehta", email: "rahul@acme.example", phone: "+91 98765 43210" },
    owner: person,
    custom_fields: {},
    created_at: at,
    updated_at: at,
  },
  lead_note: { id: "cm2k9x0aa0007deskzo0007", lead: "LEAD-000789", type: "CALL", notes: "Spoke to Rahul — wants the quote by Friday." },
  task: {
    id: "cm2k9x0aa0008deskzo0008",
    title: "Send the renewal quote",
    description: null,
    status: "TODO",
    priority: "HIGH",
    done: false,
    done_at: null,
    due_date: "2026-10-20",
    start_date: null,
    estimate_minutes: 30,
    assignee: person,
    set_by: person,
    team: null,
    about: { company: { ...company, name: company.name }, lead: null, ticket: null },
    checklist: [{ id: "cm2k9x0aa0009deskzo0009", title: "Check the seat count", done: true }],
    created_at: at,
    updated_at: at,
  },
  ticket: {
    id: "cm2k9x0aa0010deskzo0010",
    ref: "TCK-000321",
    title: "Can't sign in to Outlook",
    description: "Since this morning, for three people.",
    status: "OPEN",
    priority: "HIGH",
    type: "PRODUCT_SUPPORT",
    company,
    contact: { id: "cm2k9x0aa0004deskzo0004", ref: "CON-000456", name: "Rahul Mehta" },
    order: null,
    assignee: person,
    opened_by: person,
    comments: [{ id: "cm2k9x0aa0011deskzo0011", body: "Looking into it now.", by: person, created_at: at }],
    resolved_at: null,
    created_at: at,
    updated_at: at,
  },
  ticket_comment: { id: "cm2k9x0aa0011deskzo0011", ticket: "TCK-000321", body: "Looking into it now." },
  order: {
    id: "cm2k9x0aa0012deskzo0012",
    ref: "ORD-000654",
    status: "APPROVED",
    business_type: "RENEWAL",
    company,
    end_customer: null,
    item: { id: "cm2k9x0aa0013deskzo0013", name: "Microsoft 365 Business Standard", sku: "M365-BS" },
    quantity: 25,
    unit_price: 9900,
    po_number: "PO-2026-118",
    start_date: "2026-11-01",
    end_date: "2027-10-31",
    booked_at: at,
    fulfilled_at: null,
    created_at: at,
  },
  invoice: {
    id: "cm2k9x0aa0014deskzo0014",
    number: "INV/2026-27/0042",
    status: "ISSUED",
    issue_date: "2026-10-17",
    due_date: "2026-11-16",
    currency: "INR",
    company,
    salesperson: person,
    reference: "PO-2026-118",
    irn: null,
    einvoice_status: null,
    subtotal: 247500,
    taxable_value: 247500,
    cgst: 0,
    sgst: 0,
    igst: 44550,
    round_off: 0,
    total: 292050,
    lines: [
      { name: "Microsoft 365 Business Standard", description: null, hsn_sac: "997331", quantity: 25, unit: "Nos", unit_price: 9900, discount: 0, tax_rate_percent: 18, taxable_value: 247500, service_period: { from: "2026-11-01", to: "2027-10-31" } },
    ],
    created_at: at,
  },
} as const;

/** Keys a single record's answer has that a list's rows don't. */
export const DETAIL_ONLY: Partial<Record<ApiExampleKey, readonly string[]>> = {
  company: ["contacts"],
  task: ["checklist"],
  ticket: ["opened_by", "comments"],
  invoice: ["subtotal", "taxable_value", "cgst", "sgst", "igst", "round_off", "lines"],
};

const PAGE_QUERY = [
  { name: "page", description: "Which page, from 1." },
  { name: "page_size", description: `Rows a page, 1–${API_MAX_PAGE_SIZE}; ${API_DEFAULT_PAGE_SIZE} when left out.` },
] as const;
const search = { name: "search", description: "Words to look for, as the list's search box finds them." };

export const API_OPERATIONS: readonly ApiOperation[] = [
  { id: "me", method: "GET", path: "/me", tag: "Account", scope: null, summary: "Who the key acts as", description: "The key's name and scopes, and the person it acts as. A good first call: a key works when this answers.", status: 200, example: "me" },

  { id: "listCompanies", method: "GET", path: "/companies", tag: "Companies", scope: "companies:read", summary: "List companies", description: "The companies the key's person reaches, newest first.", query: [...PAGE_QUERY, search, { name: "relationship_type", description: "Only companies of this kind.", values: ["CLIENT", "RESELLER", "VENDOR", "OEM", "DISTRIBUTOR", "PARTNER", "COMMISSION_PARTY", "OTHER"] }], status: 200, list: true, example: "company" },
  { id: "getCompany", method: "GET", path: "/companies/{ref}", tag: "Companies", scope: "companies:read", summary: "Get a company", description: "With its contacts — those the key's person may see.", status: 200, example: "company" },
  {
    id: "createCompany",
    method: "POST",
    path: "/companies",
    tag: "Companies",
    scope: "companies:write",
    summary: "Add a company",
    description: "Its name must be new to the workspace. The key's person becomes its owner.",
    body: S.companyCreateSchema,
    bodyExample: { name: "Zenith Pharma Pvt Ltd", relationship_type: "CLIENT", website: "zenith.example", source: "REFERRAL", payment_terms: "ADVANCE", address: { city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" }, contacts: [{ name: "Anita Rao", designation: "CIO", email: "anita@zenith.example", is_primary: true }] },
    status: 201,
    example: "company",
  },
  { id: "updateCompany", method: "PATCH", path: "/companies/{ref}", tag: "Companies", scope: "companies:write", summary: "Change a company", description: "Only the fields sent change.", body: S.companyPatchSchema, bodyExample: { website: "https://zenith.example", tags: ["pharma"] }, status: 200, example: "company" },

  { id: "listContacts", method: "GET", path: "/contacts", tag: "Contacts", scope: "contacts:read", summary: "List contacts", query: [...PAGE_QUERY, search], status: 200, list: true, example: "contact" },
  { id: "getContact", method: "GET", path: "/contacts/{ref}", tag: "Contacts", scope: "contacts:read", summary: "Get a contact", status: 200, example: "contact" },
  { id: "createContact", method: "POST", path: "/contacts", tag: "Contacts", scope: "contacts:write", summary: "Add a contact to a company", body: S.contactCreateSchema, bodyExample: { company: "COM-000123", name: "Vikram Singh", designation: "IT_HEAD", email: "vikram@acme.example", phone: "+91 90000 11111" }, status: 201, example: "contact" },
  { id: "updateContact", method: "PATCH", path: "/contacts/{ref}", tag: "Contacts", scope: "contacts:write", summary: "Change a contact", description: "Only the fields sent change. A detail hidden from the key's person is kept as it is.", body: S.contactPatchSchema, bodyExample: { phone: "+91 90000 22222" }, status: 200, example: "contact" },

  { id: "listLeads", method: "GET", path: "/leads", tag: "Leads", scope: "leads:read", summary: "List leads", description: "Every pipeline's, unless one is named. Values a field-access rule hides from the key's person come back hidden.", query: [...PAGE_QUERY, search, { name: "status", description: "Only leads whose stage means this." }, { name: "stage", description: "Only leads at this stage (its key)." }, { name: "pipeline", description: "One team pipeline (its key); all when left out." }, { name: "owner", description: "A person's id or email, or `unassigned`." }], status: 200, list: true, example: "lead" },
  { id: "getLead", method: "GET", path: "/leads/{ref}", tag: "Leads", scope: "leads:read", summary: "Get a lead", status: 200, example: "lead" },
  {
    id: "createLead",
    method: "POST",
    path: "/leads",
    tag: "Leads",
    scope: "leads:write",
    summary: "Add a lead",
    description: "On an existing company. Left without an owner, the workspace's assignment rules choose one. For enquiries from a website form, the lead capture API (Settings › Lead capture API) creates the company and contact too.",
    body: S.leadCreateSchema,
    bodyExample: { company: "COM-000123", contact: "CON-000456", title: "Microsoft 365 for 25 people", value: 150000, expected_close_date: "2026-11-15", source: "WEBSITE" },
    status: 201,
    example: "lead",
  },
  { id: "updateLead", method: "PATCH", path: "/leads/{ref}", tag: "Leads", scope: "leads:write", summary: "Change a lead", description: "Its title, description, value, close date or contact. Only the fields sent change; its stage moves with POST …/stage.", body: S.leadPatchSchema, bodyExample: { value: 175000, expected_close_date: "2026-11-30" }, status: 200, example: "lead" },
  { id: "moveLead", method: "POST", path: "/leads/{ref}/stage", tag: "Leads", scope: "leads:write", summary: "Move a lead to another stage", description: "The stage's own rules apply — a stage that asks for a value refuses a lead without one.", body: S.leadStageSchema, bodyExample: { status: "PROPOSAL_SENT" }, status: 200, example: "lead" },
  { id: "noteLead", method: "POST", path: "/leads/{ref}/notes", tag: "Leads", scope: "leads:write", summary: "Log a note, call, email or meeting on a lead", body: S.leadNoteSchema, bodyExample: { type: "CALL", notes: "Spoke to Rahul — wants the quote by Friday." }, status: 201, example: "lead_note" },

  { id: "listTasks", method: "GET", path: "/tasks", tag: "Tasks", scope: "tasks:read", summary: "List tasks", query: [...PAGE_QUERY, search, { name: "status", description: "Only these.", values: ["upcoming", "todo", "in_progress", "done", "cancelled", "open"] }, { name: "assignee", description: "A person's id or email." }, { name: "due_from", description: "Due on or after this day, yyyy-mm-dd." }, { name: "due_to", description: "Due on or before this day, yyyy-mm-dd." }], status: 200, list: true, example: "task" },
  { id: "getTask", method: "GET", path: "/tasks/{id}", tag: "Tasks", scope: "tasks:read", summary: "Get a task", description: "With its checklist.", status: 200, example: "task" },
  { id: "createTask", method: "POST", path: "/tasks", tag: "Tasks", scope: "tasks:write", summary: "Add a task", description: "Given to the key's person unless someone else is named.", body: S.taskCreateSchema, bodyExample: { title: "Send the renewal quote", due_date: "2026-10-20", priority: "HIGH", company: "COM-000123", checklist: ["Check the seat count", "Attach the PO"] }, status: 201, example: "task" },
  { id: "updateTask", method: "PATCH", path: "/tasks/{id}", tag: "Tasks", scope: "tasks:write", summary: "Change a task", description: "Moving its status is for whoever it is given to; the rest, for whoever may change it.", body: S.taskPatchSchema, bodyExample: { status: "IN_PROGRESS" }, status: 200, example: "task" },

  { id: "listTickets", method: "GET", path: "/tickets", tag: "Tickets", scope: "tickets:read", summary: "List tickets", query: [...PAGE_QUERY, search, { name: "status", description: "Only these.", values: ["OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED", "CLOSED"] }, { name: "priority", description: "Only these.", values: ["LOW", "MEDIUM", "HIGH", "URGENT"] }, { name: "company", description: "One company's, by its ref or id." }, { name: "assignee", description: "A person's id or email." }], status: 200, list: true, example: "ticket" },
  { id: "getTicket", method: "GET", path: "/tickets/{ref}", tag: "Tickets", scope: "tickets:read", summary: "Get a ticket", description: "With its comments.", status: 200, example: "ticket" },
  { id: "createTicket", method: "POST", path: "/tickets", tag: "Tickets", scope: "tickets:write", summary: "Open a ticket", body: S.ticketCreateSchema, bodyExample: { company: "COM-000123", contact: "CON-000456", title: "Can't sign in to Outlook", description: "Since this morning, for three people.", priority: "HIGH" }, status: 201, example: "ticket" },
  { id: "updateTicket", method: "PATCH", path: "/tickets/{ref}", tag: "Tickets", scope: "tickets:write", summary: "Change a ticket's status, priority or assignee", body: S.ticketPatchSchema, bodyExample: { status: "IN_PROGRESS", priority: "URGENT" }, status: 200, example: "ticket" },
  { id: "commentTicket", method: "POST", path: "/tickets/{ref}/comments", tag: "Tickets", scope: "tickets:write", summary: "Comment on a ticket", body: S.ticketCommentSchema, bodyExample: { body: "Looking into it now." }, status: 201, example: "ticket_comment" },

  { id: "listOrders", method: "GET", path: "/orders", tag: "Orders", scope: "orders:read", summary: "List orders", description: "Read only. What we pay a vendor is never in it.", query: [...PAGE_QUERY, search, { name: "status", description: "Only these." }, { name: "company", description: "One company's, by its ref or id." }], status: 200, list: true, example: "order" },
  { id: "getOrder", method: "GET", path: "/orders/{ref}", tag: "Orders", scope: "orders:read", summary: "Get an order", status: 200, example: "order" },

  { id: "listInvoices", method: "GET", path: "/invoices", tag: "Invoices", scope: "invoices:read", summary: "List tax invoices", description: "Read only.", query: [...PAGE_QUERY, search, { name: "status", description: "Only these.", values: ["DRAFT", "ISSUED", "ACCEPTED", "REJECTED", "PARTIALLY_PAID", "PAID", "CANCELLED", "EXPIRED"] }, { name: "from", description: "Issued on or after this day, yyyy-mm-dd." }, { name: "to", description: "Issued on or before this day, yyyy-mm-dd." }], status: 200, list: true, example: "invoice" },
  { id: "getInvoice", method: "GET", path: "/invoices/{id}", tag: "Invoices", scope: "invoices:read", summary: "Get a tax invoice", description: "With its lines and tax.", status: 200, example: "invoice" },
];

/** An example answer as a list row: without what only a single record carries. */
export function listRowExample(key: ApiExampleKey): Record<string, unknown> {
  const drop = new Set(DETAIL_ONLY[key] ?? []);
  return Object.fromEntries(Object.entries(EXAMPLES[key]).filter(([k]) => !drop.has(k)));
}

/** A request body's JSON Schema, as a client would send it. */
export function bodySchema(schema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export const API_INTRO = {
  title: "Deskzo API",
  summary: "Your workspace's companies, contacts, leads, tasks, tickets, orders and invoices — for Zapier, Make and your own systems.",
  auth: "Every call carries an API key, made in Settings › Developers & API: `Authorization: Bearer dzk_….dzs_…`. A key acts as the person who made it and never as more — it sees and changes only what they may, through the same rules as the screens — and only within the scopes it was given. The secret is shown once; keep it on a server, never in a browser or an app.",
  base: "https://<your-workspace>.deskzo.com/api/v1 — the address you sign in at, with /api/v1 after it.",
  refs: "Records are named by their reference — COM-000123, CON-…, LEAD-…, TCK-…, ORD-… — or by their id. Tasks and invoices, by id.",
  pages: `Lists come a page at a time: \`?page=1&page_size=${API_DEFAULT_PAGE_SIZE}\` (at most ${API_MAX_PAGE_SIZE}). The answer is \`{ "data": [...], "page": { "page", "page_size", "total", "has_more" } }\`; a single record, \`{ "data": {...} }\`.`,
  retries: `Send \`Idempotency-Key: <a unique string>\` with a create or change: the same request sent again within ${API_IDEMPOTENCY_HOURS} hours — a retry after a timeout — gets the first answer back instead of doing it twice.`,
  limits: `${API_RATE_PER_MINUTE} calls a minute per key (429 with Retry-After past it; the X-RateLimit-Remaining header says how many are left). Request bodies up to ${API_MAX_BODY_BYTES / 1024} KB, as JSON.`,
  errors: "A refusal is `{ \"error\": { \"code\", \"message\", \"fields\"? } }`: 400 invalid_request (fields says which), 401 unauthorized (the same for a wrong, expired or revoked key), 403 insufficient_scope / module_unavailable / person_not_allowed / forbidden, 404 not_found (the same for a record that isn't there and one the key's person can't see), 409 in_progress, 413 too_large, 415 unsupported_media_type, 422 refused (the app's own rules said no, in its own words), 429 rate_limited, 503 maintenance.",
};

const ERROR_SCHEMA = {
  type: "object",
  properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, fields: { type: "object", additionalProperties: { type: "string" } } }, required: ["code", "message"] } },
  required: ["error"],
};
const PAGE_SCHEMA = { type: "object", properties: { page: { type: "integer" }, page_size: { type: "integer" }, total: { type: "integer" }, has_more: { type: "boolean" } } };

/** The OpenAPI 3.1 document — for one workspace's address, or for any (`{workspace}`). */
export function openApiDocument(workspaceOrigin: string | null): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of API_OPERATIONS) {
    const pathParams = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" }, description: m[1] === "ref" ? "Its reference (like COM-000123) or its id." : "Its id." }));
    const query = (op.query ?? []).map((q) => ({ name: q.name, in: "query", required: false, description: q.description, schema: q.values ? { type: "string", enum: q.values } : { type: "string" } }));
    const idempotency = op.method === "GET" ? [] : [{ name: "Idempotency-Key", in: "header", required: false, description: "Makes a retry safe: the same key again gets the first answer.", schema: { type: "string", minLength: 8, maxLength: 100 } }];
    const example = op.list ? { data: [listRowExample(op.example)], page: { page: 1, page_size: API_DEFAULT_PAGE_SIZE, total: 1, has_more: false } } : { data: EXAMPLES[op.example] };
    const errors = Object.fromEntries(
      [
        ["400", "The request isn't valid"],
        ["401", "No key, or a wrong, expired or revoked one"],
        ["403", "Outside the key's scopes, its person's access, or the plan"],
        ...(op.list ? [] : [["404", "Not there, or not one the key's person can see"]]),
        ...(op.method === "GET" ? [] : [["422", "Refused by the app's own rules"]]),
        ["429", "Too many calls — wait"],
      ].map(([code, description]) => [code, { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }]),
    );
    paths[op.path] ??= {};
    paths[op.path]![op.method.toLowerCase()] = {
      operationId: op.id,
      tags: [op.tag],
      summary: op.summary,
      description: [op.description, op.scope ? `Needs the \`${op.scope}\` scope.` : "Any live key."].filter(Boolean).join("\n\n"),
      "x-deskzo-scope": op.scope,
      parameters: [...pathParams, ...query, ...idempotency],
      ...(op.body
        ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${op.id}Body` }, ...(op.bodyExample ? { example: op.bodyExample } : {}) } } } }
        : {}),
      responses: {
        [String(op.status)]: {
          description: op.status === 201 ? "Created" : "OK",
          content: { "application/json": { schema: op.list ? { type: "object", properties: { data: { type: "array", items: { type: "object" } }, page: { $ref: "#/components/schemas/Page" } } } : { type: "object", properties: { data: { type: "object" } } }, example } },
        },
        ...errors,
      },
    };
  }
  const bodies = Object.fromEntries(API_OPERATIONS.filter((op) => op.body).map((op) => [`${op.id}Body`, bodySchema(op.body!)]));
  return {
    openapi: "3.1.0",
    info: {
      title: API_INTRO.title,
      version: "1.0.0",
      summary: API_INTRO.summary,
      description: [API_INTRO.auth, API_INTRO.refs, API_INTRO.pages, API_INTRO.retries, API_INTRO.limits, API_INTRO.errors].join("\n\n"),
    },
    servers: workspaceOrigin
      ? [{ url: `${workspaceOrigin}/api/v1` }]
      : [{ url: "https://{workspace}.deskzo.com/api/v1", variables: { workspace: { default: "your-workspace", description: "The name in the address you sign in at." } } }],
    security: [{ apiKey: [] }],
    tags: [...new Set(API_OPERATIONS.map((o) => o.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", bearerFormat: "dzk_….dzs_…", description: API_INTRO.auth } },
      schemas: { Error: ERROR_SCHEMA, Page: PAGE_SCHEMA, ...bodies },
    },
    "x-deskzo-scopes": API_SCOPES,
  };
}

/** The same as a Postman collection (v2.1), a folder an area: the address and the key as variables, the key left empty. */
export function postmanFromOperations(workspaceOrigin: string | null): Record<string, unknown> {
  const folders = [...new Set(API_OPERATIONS.map((o) => o.tag))].map((tag) => ({
    name: tag,
    item: API_OPERATIONS.filter((o) => o.tag === tag).map((op) => {
      const segments = op.path.split("/").filter(Boolean).map((s) => s.replace(/^\{(\w+)\}$/, ":$1"));
      const variables = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ key: m[1], value: m[1] === "ref" ? (op.tag === "Companies" ? "COM-000123" : op.tag === "Contacts" ? "CON-000456" : op.tag === "Leads" ? "LEAD-000789" : op.tag === "Tickets" ? "TCK-000321" : "ORD-000654") : "" }));
      const query = (op.query ?? []).map((q) => ({ key: q.name, value: "", disabled: true, description: q.description }));
      return {
        name: op.summary,
        request: {
          method: op.method,
          header: [...(op.body ? [{ key: "Content-Type", value: "application/json" }] : []), ...(op.method === "GET" ? [] : [{ key: "Idempotency-Key", value: "{{$guid}}" }])],
          url: { raw: `{{baseUrl}}/${segments.join("/")}`, host: ["{{baseUrl}}"], path: segments, ...(variables.length ? { variable: variables } : {}), ...(query.length ? { query } : {}) },
          ...(op.bodyExample ? { body: { mode: "raw", raw: JSON.stringify(op.bodyExample, null, 2), options: { raw: { language: "json" } } } } : {}),
          description: [op.description, op.scope ? `Needs the ${op.scope} scope.` : null].filter(Boolean).join("\n\n"),
        },
      };
    }),
  }));
  return {
    info: { name: API_INTRO.title, description: [API_INTRO.summary, API_INTRO.auth].join("\n\n"), schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{apiKey}}", type: "string" }] },
    variable: [
      { key: "baseUrl", value: workspaceOrigin ? `${workspaceOrigin}/api/v1` : "https://your-workspace.deskzo.com/api/v1", type: "string" },
      { key: "apiKey", value: "", type: "string" },
    ],
    item: folders,
  };
}
