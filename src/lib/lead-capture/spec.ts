import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES } from "@/lib/leads/source";

/**
 * The lead capture API, described once.
 *
 * The settings page renders its documentation from this, and the "Download documentation" button
 * turns the same object into Markdown for a website developer who has no login here. `check:leads`
 * asserts every field listed is one the endpoint's validator actually accepts, and the other way
 * round — documentation that drifts from the code is worse than none, because it is believed.
 */

export const API_PATH = "/api/v1/leads";
export const RATE_LIMIT_PER_MINUTE = 60;
export const MAX_BODY_BYTES = 64 * 1024;

export type FieldSpec = { name: string; type: string; required: boolean | string; description: string; example: string };

export const LEAD_FIELDS: FieldSpec[] = [
  { name: "name", type: "string, up to 120", required: true, description: "The person who enquired.", example: "Priya Sharma" },
  { name: "email", type: "string, email", required: "email or phone", description: "Their email. Matched against the company's existing contacts, so a repeat enquiry does not create a second person.", example: "priya@acme.in" },
  { name: "phone", type: "string, up to 20", required: "email or phone", description: "Their phone number, any format.", example: "+91 98765 43210" },
  { name: "company", type: "string, up to 160", required: false, description: "Their company. Matched to an existing company by name, ignoring case and spacing; created if new. Left out, the email's domain is used — or, for Gmail-style addresses, the person's name.", example: "Acme Chemicals India Pvt Ltd" },
  { name: "designation", type: "string, up to 80", required: false, description: "Their job title as they typed it. Read into the CRM's designations (CEO, CIO, IT head, IT manager…) — this drives lead scoring and designation-based assignment.", example: "IT Manager" },
  { name: "city", type: "string", required: false, description: "Used when the company is new.", example: "Mumbai" },
  { name: "state", type: "string", required: false, description: "Indian state. Used for state-wise assignment, and for the new company's address.", example: "Maharashtra" },
  { name: "pincode", type: "string", required: false, description: "Six digits for India.", example: "400069" },
  { name: "country", type: "string", required: false, description: "Defaults to India.", example: "India" },
  { name: "message", type: "string, up to 5000", required: false, description: "What they wrote. Becomes the lead's requirement details.", example: "Need 25 Microsoft 365 Business Standard licences." },
  { name: "product_interest", type: "string, up to 200", required: false, description: "What they are asking about, in words. Becomes the lead's title.", example: "Microsoft 365" },
  { name: "products", type: "array of SKUs, up to 20", required: false, description: "Catalogue SKUs, if your site knows them. Matched ones become the lead's products (and drive brand-wise assignment); unknown ones are listed in the details.", example: '["M365-BS"]' },
  { name: "quantity", type: "integer", required: false, description: "Seats or units, applied to each product given.", example: "25" },
  { name: "budget", type: "number, rupees", required: false, description: "The lead's estimated value.", example: "150000" },
  { name: "source", type: `one of: ${LEAD_SOURCE_VALUES.map((v) => v.toLowerCase()).join(", ")}`, required: false, description: "Where the enquiry came from. Defaults to website.", example: "website" },
  { name: "page_url", type: "URL, up to 500", required: false, description: "The page the form was on — recorded as the source detail.", example: "https://wroffy.com/microsoft-365" },
  { name: "utm_source", type: "string", required: false, description: "Campaign tracking, recorded with the source.", example: "google" },
  { name: "utm_medium", type: "string", required: false, description: "Campaign tracking.", example: "cpc" },
  { name: "utm_campaign", type: "string", required: false, description: "Campaign tracking.", example: "m365-sept" },
  { name: "external_id", type: "string, up to 100", required: false, description: "Your own id for this enquiry. Send it and a retried request returns the same lead instead of creating a second — use it whenever your site can.", example: "enq-2026-000481" },
];

export const RESPONSES: { status: string; meaning: string }[] = [
  { status: "201 Created", meaning: "The lead was created. The body has its id and reference (LEAD-000123) and whether it was assigned." },
  { status: "200 OK", meaning: "A request with the same external_id was already received — the body names the existing lead, and nothing new was created." },
  { status: "202 Accepted", meaning: "Received, but the company is managed by one of our resellers, so no lead was created here; our team is notified to route it." },
  { status: "400 Bad Request", meaning: "Something is missing or malformed. `error` says what, and `fields` says which." },
  { status: "401 Unauthorized", meaning: "The key ID or secret is wrong, or the key has been revoked. The same answer for each, deliberately." },
  { status: "413 Payload Too Large", meaning: `The body is over ${MAX_BODY_BYTES / 1024} KB.` },
  { status: "415 Unsupported Media Type", meaning: "Send application/json or application/x-www-form-urlencoded." },
  { status: "429 Too Many Requests", meaning: `More than ${RATE_LIMIT_PER_MINUTE} leads a minute from one key. Wait the number of seconds in Retry-After and send again.` },
];

export const EXAMPLE_BODY = {
  name: "Priya Sharma",
  email: "priya@acme.in",
  phone: "+91 98765 43210",
  company: "Acme Chemicals India Pvt Ltd",
  designation: "IT Manager",
  state: "Maharashtra",
  message: "Need 25 Microsoft 365 Business Standard licences.",
  product_interest: "Microsoft 365",
  budget: 150000,
  page_url: "https://wroffy.com/microsoft-365",
  utm_source: "google",
  external_id: "enq-2026-000481",
};

export function curlExample(baseUrl: string): string {
  return [
    `curl -X POST ${baseUrl}${API_PATH} \\`,
    `  -u "$KEY_ID:$SECRET" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(EXAMPLE_BODY)}'`,
  ].join("\n");
}

export function phpExample(baseUrl: string): string {
  return [
    "<?php",
    "// Server side only — never put the secret in the page's JavaScript.",
    `$ch = curl_init("${baseUrl}${API_PATH}");`,
    "curl_setopt_array($ch, [",
    "  CURLOPT_POST => true,",
    "  CURLOPT_USERPWD => getenv('WROFFY_KEY_ID') . ':' . getenv('WROFFY_SECRET'),",
    "  CURLOPT_HTTPHEADER => ['Content-Type: application/json'],",
    "  CURLOPT_POSTFIELDS => json_encode([",
    "    'name' => $_POST['name'],",
    "    'email' => $_POST['email'],",
    "    'phone' => $_POST['phone'],",
    "    'company' => $_POST['company'],",
    "    'message' => $_POST['message'],",
    "    'page_url' => $_SERVER['HTTP_REFERER'] ?? null,",
    "  ]),",
    "  CURLOPT_RETURNTRANSFER => true,",
    "  CURLOPT_TIMEOUT => 10,",
    "]);",
    "$response = curl_exec($ch);",
    "$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);",
    "curl_close($ch);",
  ].join("\n");
}

export function nodeExample(baseUrl: string): string {
  return [
    "// Server side only (Node 18+) — never put the secret in browser code.",
    "const auth = Buffer.from(`${process.env.WROFFY_KEY_ID}:${process.env.WROFFY_SECRET}`).toString(\"base64\");",
    `const res = await fetch("${baseUrl}${API_PATH}", {`,
    '  method: "POST",',
    '  headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },',
    "  body: JSON.stringify({ name, email, phone, company, message, external_id: enquiryId }),",
    "});",
    "const result = await res.json(); // { ok: true, lead: { id, reference }, duplicate: false }",
  ].join("\n");
}

const SOURCE_LIST = LEAD_SOURCE_VALUES.map((v) => `\`${v.toLowerCase()}\` (${LEAD_SOURCE_LABELS[v]})`).join(", ");

/** The whole documentation as Markdown — what the download button saves. */
export function renderMarkdown(baseUrl: string): string {
  const req = (r: FieldSpec["required"]) => (r === true ? "Yes" : r === false ? "No" : r);
  return [
    "# Deskzo One — Lead capture API",
    "",
    "Send enquiries from your websites straight into the CRM as leads. Each lead records which website sent it, is scored, and is assigned by the CRM's lead assignment rules.",
    "",
    "## Endpoint",
    "",
    `\`POST ${baseUrl}${API_PATH}\``,
    "",
    "## Authentication",
    "",
    "HTTP Basic: the **key ID** is the username and the **secret** is the password. Each website gets its own key from *Settings → Lead capture API* in the CRM; the secret is shown once when the key is created.",
    "",
    "**Call this from your website's server, never from browser JavaScript.** Anything in a page's script can be read by every visitor, and with the secret anyone could post leads as your website. The API sends no CORS headers, so a browser will refuse the call anyway.",
    "",
    `To check a key works without creating anything: \`GET ${baseUrl}${API_PATH}\` with the same credentials answers \`{ "ok": true, "key": "<its name>" }\`.`,
    "",
    "## Request",
    "",
    "`Content-Type: application/json` (or `application/x-www-form-urlencoded`, with `products` as a comma-separated list).",
    "",
    "| Field | Type | Required | What it does |",
    "|---|---|---|---|",
    ...LEAD_FIELDS.map((f) => `| \`${f.name}\` | ${f.type} | ${req(f.required)} | ${f.description} |`),
    "",
    `Sources: ${SOURCE_LIST}.`,
    "",
    "### Example",
    "",
    "```json",
    JSON.stringify(EXAMPLE_BODY, null, 2),
    "```",
    "",
    "## Responses",
    "",
    "| Status | Meaning |",
    "|---|---|",
    ...RESPONSES.map((r) => `| ${r.status} | ${r.meaning} |`),
    "",
    "A created lead:",
    "",
    "```json",
    JSON.stringify({ ok: true, lead: { id: "cm…", reference: "LEAD-000481" }, duplicate: false, assigned: true }, null, 2),
    "```",
    "",
    "## Examples",
    "",
    "### curl",
    "",
    "```bash",
    curlExample(baseUrl),
    "```",
    "",
    "### PHP",
    "",
    "```php",
    phpExample(baseUrl),
    "```",
    "",
    "### Node.js",
    "",
    "```js",
    nodeExample(baseUrl),
    "```",
    "",
    "## Good practice",
    "",
    "- One key per website or form, so each can be revoked on its own and every lead says where it came from.",
    "- Send `external_id` so a retry after a timeout cannot create a duplicate lead.",
    "- Keep the secret in your server's environment, not in your code repository.",
    "- If a key may have leaked, revoke it in the CRM and create a new one — revoking takes effect immediately.",
    "",
  ].join("\n");
}
