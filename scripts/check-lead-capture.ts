/**
 * The lead capture API — POST /api/v1/leads — through its real route handlers.
 *
 * Every request here is a real `Request` handed to the exported GET and POST, so what is checked is
 * what a website gets: the status, the body, and what ends up in the database. What matters most:
 *
 *   · **Refusals look alike.** No key, a wrong secret, a revoked key: the same 401, so the endpoint
 *     cannot be used to find out which key IDs exist.
 *   · **A retry is not a second lead.** The same external_id twice — even twice at once — is one lead.
 *   · **A reseller's customer is not ours.** Their enquiry creates no contact and no lead.
 *   · **The secret is not kept.** Only its digest is.
 *   · **The documentation is the validator.** Every field documented is accepted, and every field
 *     accepted is documented.
 *
 * Against the development database, with ZZPROBE_CAPTURE fixtures removed in a finally.
 *
 *   npm run check:lead-capture
 */
import "dotenv/config";
import Module from "node:module";
import { PrismaClient } from "@prisma/client";
import { LEAD_FIELDS, RATE_LIMIT_PER_MINUTE, renderMarkdown } from "../src/lib/lead-capture/spec";
import { ACCEPTED_FIELDS, companyNameFor, designationFromTitle } from "../src/lib/lead-capture/intake";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => ({ id: actorId, role: "ADMIN" }), currentUser: async () => ({ id: actorId, role: "ADMIN" }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = new PrismaClient();
const TAG = "ZZPROBE_CAPTURE";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const keys = await db.leadCaptureKey.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const keyIds = keys.map((k) => k.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const leads = await db.lead.findMany({ where: { OR: [{ captureKeyId: { in: keyIds } }, { companyId: { in: companies.map((c) => c.id) } }] }, select: { id: true } });
  await db.notification.deleteMany({ where: { OR: [{ link: { in: leads.map((l) => `/leads/${l.id}`) } }, { title: { contains: TAG } }] } });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { entityType: "Lead", entityId: { in: leads.map((l) => l.id) } },
        { entityType: "LeadCaptureKey", entityId: { in: keyIds } },
      ],
    },
  });
  await db.lead.deleteMany({ where: { id: { in: leads.map((l) => l.id) } } });
  await db.company.deleteMany({ where: { id: { in: companies.map((c) => c.id) } } });
  await db.leadCaptureKey.deleteMany({ where: { id: { in: keyIds } } });
}

async function main() {
  section("The documentation is the validator");

  const documented = LEAD_FIELDS.map((f) => f.name).sort();
  const accepted = [...ACCEPTED_FIELDS].sort();
  ok(
    "every documented field is accepted, and every accepted field documented",
    JSON.stringify(documented) === JSON.stringify(accepted),
    documented.filter((f) => !accepted.includes(f)).concat(accepted.filter((f) => !documented.includes(f))).join(", ") || `${accepted.length} fields`,
  );
  const md = renderMarkdown("https://crm.example.com");
  ok("the downloadable docs name the endpoint and warn against browser use", md.includes("POST https://crm.example.com/api/v1/leads") && /never from browser JavaScript/.test(md));

  section("Reading what a website sends");

  const TITLES: [string, string][] = [
    ["IT Manager", "IT_MANAGER"],
    ["Head - IT Infrastructure", "IT_HEAD"],
    ["IT Head", "IT_HEAD"],
    ["Chief Information Officer", "CIO"],
    ["Managing Director", "CEO"],
    ["Founder & CEO", "CEO"],
    ["VP Sales", "DIRECTOR"],
    ["Procurement Lead", "PURCHASE_MANAGER"],
    ["HR Executive", "HR"],
    ["Accountant", "OTHER"],
  ];
  const wrongTitles = TITLES.filter(([t, want]) => designationFromTitle(t) !== want);
  ok("job titles become designations", wrongTitles.length === 0, wrongTitles.map(([t]) => `${t} → ${designationFromTitle(t)}`).join("; ") || `${TITLES.length} titles`);
  ok(
    "a Gmail address is a person, not a company",
    companyNameFor({ name: "Ravi", email: "ravi@gmail.com" }) === "Ravi (individual)" && companyNameFor({ name: "Ravi", email: "ravi@acme.in" }) === "acme.in",
  );

  section("Through the real endpoint");

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("needs a super admin");
  actorId = admin.id;

  /* eslint-disable @typescript-eslint/no-require-imports */
  const keys = require("../src/actions/lead-capture") as typeof import("../src/actions/lead-capture");
  const route = require("../src/app/api/v1/leads/route") as typeof import("../src/app/api/v1/leads/route");
  const URL_ = "http://localhost:3000/api/v1/leads";
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  const post = (auth: string | null, body: string, type = "application/json") =>
    route.POST(new Request(URL_, { method: "POST", headers: { ...(auth ? { authorization: auth } : {}), "content-type": type }, body }));

  await cleanup();
  try {
    const made = await keys.createCaptureKey({ name: `${TAG} site`, sourceLabel: "zzprobe.example" });
    if (!made.ok) throw new Error(made.error);
    const { keyId, secret } = made.data;
    const auth = basic(keyId, secret);

    const stored = await db.leadCaptureKey.findUnique({ where: { keyId } });
    ok("the secret is not stored, only its digest", !!stored && stored.secretDigest !== secret && !stored.secretDigest.includes(secret.slice(4, 20)));

    // ── authentication ──
    const noAuth = await route.GET(new Request(URL_));
    const wrongSecret = await route.GET(new Request(URL_, { headers: { authorization: basic(keyId, "lcs_wrong-secret-entirely") } }));
    const noSuchKey = await route.GET(new Request(URL_, { headers: { authorization: basic("lck_00000000000000000000", secret) } }));
    const bodies = await Promise.all([noAuth, wrongSecret, noSuchKey].map((r) => r.text()));
    ok(
      "no key, a wrong secret and an unknown key are refused identically",
      [noAuth, wrongSecret, noSuchKey].every((r) => r.status === 401) && new Set(bodies).size === 1,
      "the endpoint cannot be used to find out which key IDs exist",
    );
    const check = await route.GET(new Request(URL_, { headers: { authorization: auth } }));
    ok("the right key can check itself without creating anything", check.status === 200 && (await check.json()).key === `${TAG} site`);

    // ── a lead ──
    const payload = {
      name: "Zzprobe Priya",
      email: "Priya@ZZProbe-Acme.example",
      phone: "+91 90000 00001",
      company: `${TAG} Acme`,
      designation: "IT Manager",
      state: "Maharashtra",
      city: "Mumbai",
      pincode: "400069",
      message: "Need 25 licences.",
      product_interest: "Microsoft 365",
      products: ["ZZ-NO-SUCH-SKU"],
      budget: 150000,
      page_url: "https://zzprobe.example/m365",
      utm_source: "google",
      external_id: "zz-enq-1",
    };
    const res = await post(auth, JSON.stringify(payload));
    const body = await res.json();
    ok("a valid enquiry creates a lead", res.status === 201 && body.ok && /^LEAD-\d{6}$/.test(body.lead?.reference ?? ""), `${res.status} ${JSON.stringify(body).slice(0, 120)}`);

    const lead = body.lead?.id
      ? await db.lead.findUnique({
          where: { id: body.lead.id },
          include: { contact: true, company: { include: { locations: true } } },
        })
      : null;
    ok("  marked as from the website, with the site, page and campaign", lead?.source === "WEBSITE" && /zzprobe\.example/.test(lead.sourceDetail ?? "") && /\/m365/.test(lead.sourceDetail ?? "") && /utm google/.test(lead.sourceDetail ?? ""), lead?.sourceDetail);
    ok("  with the person, their email lowercased and their title read", lead?.contact?.email === "priya@zzprobe-acme.example" && lead.contact.designation === "IT_MANAGER");
    ok("  a new company with its address", lead?.company.locations[0]?.state === "Maharashtra" && lead.company.locations[0]?.pincode === "400069");
    ok("  the budget as its value, the message as its details", Number(lead?.estimatedValue) === 150000 && /Need 25 licences/.test(lead?.description ?? ""));
    ok("  an unknown SKU noted rather than lost", /ZZ-NO-SUCH-SKU/.test(lead?.description ?? ""));
    ok("  and scored straight away", lead?.score !== null && lead?.score !== undefined, `score ${lead?.score}`);

    // ── retries ──
    const again = await post(auth, JSON.stringify(payload));
    const againBody = await again.json();
    ok("the same external_id again returns the same lead", again.status === 200 && againBody.duplicate === true && againBody.lead.id === body.lead.id);
    const raced = await Promise.all([1, 2, 3].map(() => post(auth, JSON.stringify({ ...payload, external_id: "zz-enq-race" }))));
    const racedIds = new Set(await Promise.all(raced.map(async (r) => (await r.json()).lead?.id)));
    ok(
      "  even three copies at once make one lead",
      racedIds.size === 1 && (await db.lead.count({ where: { captureKeyId: stored!.id, externalId: "zz-enq-race" } })) === 1,
      raced.map((r) => r.status).join(", "),
    );
    const sameContact = await post(auth, JSON.stringify({ ...payload, external_id: "zz-enq-2", message: "Also need Defender." }));
    const second = await db.lead.findUnique({ where: { id: (await sameContact.json()).lead.id }, select: { contactId: true, companyId: true } });
    ok("a second enquiry from the same person reuses the company and the contact", second?.contactId === lead?.contactId && second?.companyId === lead?.companyId);

    // ── refusals ──
    const bad = await post(auth, JSON.stringify({ name: "Nobody" }));
    const badBody = await bad.json();
    ok("no email and no phone is a 400 naming the field", bad.status === 400 && !!badBody.fields?.email, JSON.stringify(badBody.fields));
    const wrongPin = await post(auth, JSON.stringify({ ...payload, external_id: "zz-pin", pincode: "12345" }));
    ok("  an Indian address with a bad PIN too", wrongPin.status === 400 && !!(await wrongPin.json()).fields?.pincode);
    ok("plain text is a 415", (await post(auth, "hello", "text/plain")).status === 415);
    ok("broken JSON is a 400", (await post(auth, "{not json")).status === 400);
    ok("a body over 64 KB is a 413", (await post(auth, JSON.stringify({ ...payload, message: "x".repeat(70_000) }))).status === 413);

    const form = await post(
      auth,
      new URLSearchParams({ name: "Zzprobe Form", email: "form@zzprobe-acme.example", company: `${TAG} Acme`, products: "ZZ-A, ZZ-B", external_id: "zz-form" }).toString(),
      "application/x-www-form-urlencoded",
    );
    ok("a plain HTML form post works too", form.status === 201, form.status);

    // ── a reseller's customer ──
    const reseller = await db.company.create({
      data: { name: `${TAG} Reseller`, normalizedName: `${TAG} reseller`.toLowerCase(), relationshipType: "RESELLER", createdById: admin.id, ownerUserId: admin.id },
    });
    await db.company.create({
      data: { name: `${TAG} EndCustomer`, normalizedName: `${TAG} endcustomer`.toLowerCase(), createdById: admin.id, managedByResellerId: reseller.id },
    });
    const leadsBefore = await db.lead.count();
    const routed = await post(auth, JSON.stringify({ ...payload, company: `${TAG} EndCustomer`, external_id: "zz-reseller" }));
    ok(
      "an enquiry for a reseller's customer is accepted but creates no lead",
      routed.status === 202 && (await db.lead.count()) === leadsBefore && (await db.contact.count({ where: { company: { name: `${TAG} EndCustomer` } } })) === 0,
      "no direct contact with a company we reach through a reseller",
    );

    // ── rate limit ──
    const company = await db.company.findFirst({ where: { name: `${TAG} Acme` }, select: { id: true } });
    await db.lead.createMany({
      data: Array.from({ length: RATE_LIMIT_PER_MINUTE }, (_, i) => ({ companyId: company!.id, title: `${TAG} flood ${i}`, captureKeyId: stored!.id })),
    });
    const limited = await post(auth, JSON.stringify({ ...payload, external_id: "zz-flood" }));
    ok(`more than ${RATE_LIMIT_PER_MINUTE} a minute from one key is a 429 with Retry-After`, limited.status === 429 && limited.headers.get("retry-after") === "60");

    // ── revoked ──
    await keys.revokeCaptureKey(stored!.id);
    const afterRevoke = await post(auth, JSON.stringify({ ...payload, external_id: "zz-revoked" }));
    ok("a revoked key is refused at once, like any other bad key", afterRevoke.status === 401);
  } finally {
    await cleanup();
  }
  ok("the fixture is gone", (await db.leadCaptureKey.count({ where: { name: { startsWith: TAG } } })) === 0 && (await db.company.count({ where: { name: { startsWith: TAG } } })) === 0);
  await db.$disconnect();
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll lead capture checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => {});
    await db.$disconnect();
    process.exit(1);
  });
