/**
 * Which leads have had a quotation sent (owner, 19 Oct 2026 — src/lib/leads/quotes.ts, quote-status.ts,
 * src/actions/document-lead.ts, the stage rule in src/lib/pipeline/rules.ts and stage-move.ts):
 *
 *   · A quotation sent is a proposal, proforma or invoice linked to the lead and issued — not a draft,
 *     not cancelled; a rejected or expired proposal still went out. A lead shows the furthest: an
 *     invoice over a proforma over a proposal, an accepted proposal over an open one, then the newest.
 *   · "No quote" only on a deal at Proposal sent or past it; the Quotation filter finds sent, not sent,
 *     and missing — and is ignored for somebody who can't see sales documents.
 *   · A stage may ask for an issued quotation; where the workspace can't raise one, the rule is dropped.
 *   · The proposal form's leads are the customer's that this person may see; "Link to lead" links a
 *     proposal, and what was made from it follows, refusing another company's lead, other documents and
 *     cancelled ones.
 *
 * Everything is named ZZPROBE_LQ / ZZLQ- and removed in a finally.
 *
 *   npm run check:lead-quotes
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zzprobe Lq", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_LQ";
const MAIL = "@zzprobe-lq.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const DAY = 86_400_000;

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.tradeDocument.updateMany({ where: { docNumber: { startsWith: "ZZLQ-" } }, data: { sourceDocumentId: null } });
  await db.tradeDocument.deleteMany({ where: { docNumber: { startsWith: "ZZLQ-" } } });
  if (companies.length) {
    await db.activity.deleteMany({ where: { lead: { companyId: { in: companies } } } });
    await db.lead.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
  }
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (users.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: users } } });
    await db.userPermission.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
}

async function main() {
  // Required here, after the session stub: a top-of-file import is hoisted above it and loads the real one.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const quotes = require("../src/lib/leads/quotes") as typeof import("../src/lib/leads/quotes");
  const rules = require("../src/lib/pipeline/rules") as typeof import("../src/lib/pipeline/rules");
  const status = require("../src/lib/leads/quote-status") as typeof import("../src/lib/leads/quote-status");
  const { ruleStops } = require("../src/lib/leads/stage-move") as typeof import("../src/lib/leads/stage-move");
  const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const linking = require("../src/actions/document-lead") as typeof import("../src/actions/document-lead");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("The furthest quotation, and what a lead shows");

  const at = (days: number) => new Date(Date.UTC(2026, 9, 1) + days * DAY);
  const row = (docType: string, s: string, days: number, n = days) => ({ id: `d${n}${docType}`, docNumber: `N${n}`, docType, status: s as never, total: 100 * (n + 1), currency: "INR", issueDate: at(days), createdAt: at(days) });
  const pick = (rows: ReturnType<typeof row>[]) => quotes.leadQuoteOf(rows);
  const furthest = pick([row("PROPOSAL", "ISSUED", 5), row("PROFORMA", "ISSUED", 1), row("PROPOSAL", "REJECTED", 0, 9)]);
  ok("a proforma goes further than a newer proposal; a rejected proposal still went out", furthest?.docType === "PROFORMA" && furthest.sent === 3, JSON.stringify(furthest));
  ok("an invoice goes furthest", pick([row("PROFORMA", "ISSUED", 9), row("INVOICE", "PAID", 1)])?.docType === "INVOICE");
  ok("an accepted proposal over a newer open one", pick([row("PROPOSAL", "ACCEPTED", 1), row("PROPOSAL", "ISSUED", 8)])?.status === "ACCEPTED");
  ok("an issued proposal over a newer draft invoice", pick([row("PROPOSAL", "ISSUED", 1), row("INVOICE", "DRAFT", 8)])?.docType === "PROPOSAL");
  const draft = pick([row("PROPOSAL", "DRAFT", 2)]);
  ok("only a draft: shown as one, none sent", draft?.status === "DRAFT" && draft.sent === 0);
  ok("only cancelled ones, or a credit note: nothing", pick([row("PROPOSAL", "CANCELLED", 1), row("CREDIT_NOTE", "ISSUED", 2)]) === null);
  const badge = (q: ReturnType<typeof pick>, s: string) => quotes.quoteBadge(q, s as never)?.label ?? null;
  ok(
    "the badge: no quote only where one was due, then draft, quoted, accepted, proforma, invoiced, paid",
    badge(null, "NEGOTIATION") === "No quote" &&
      badge(null, "WON") === "No quote" &&
      badge(null, "QUALIFYING") === null &&
      badge(draft, "PROPOSAL_SENT") === "Quote in draft" &&
      badge(pick([row("PROPOSAL", "ISSUED", 1)]), "NEW") === "Quoted" &&
      badge(pick([row("PROPOSAL", "ACCEPTED", 1)]), "NEW") === "Quote accepted" &&
      badge(furthest, "NEW") === "Proforma sent" &&
      badge(pick([row("INVOICE", "ISSUED", 1)]), "WON") === "Invoiced" &&
      badge(pick([row("INVOICE", "PAID", 1)]), "WON") === "Paid",
  );

  section("A stage that asks for an issued quotation");

  const bare = { estimatedValue: null, expectedCloseDate: null, contactId: null, ownerUserId: null, description: null, customFields: {} };
  ok("'quotation' is a rule a stage may name", rules.isRuleField(rules.QUOTE_RULE) && rules.ruleFieldLabel(rules.QUOTE_RULE) === "An issued quotation");
  ok("  missing until it has had one", rules.missingForStage({ requiredFields: ["quotation"] }, bare).join() === "quotation" && rules.missingForStage({ requiredFields: ["quotation"] }, { ...bare, quoted: true }).length === 0);
  ok(
    "  the refusal says to issue one, and what else to fill in",
    rules.ruleRefusal("Proposal sent", [], true) === "Before Proposal sent, issue a quotation for it." &&
      rules.ruleRefusal("Proposal sent", ["Value"], true) === "Before Proposal sent, issue a quotation for it and fill in Value." &&
      rules.ruleRefusal("Proposal sent", ["Value"]) === "Before Proposal sent, fill in Value.",
  );

  await cleanup();
  const moduleRow = await db.systemModule.findUnique({ where: { key: "sales_documents" } });
  try {
    const admin = await db.user.create({ data: { name: `${TAG} admin`, email: `admin${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60) } });
    roles.set(admin.id, "ADMIN");
    // Sees leads, and the accounts they're on — not sales documents.
    const viewer = await db.user.create({ data: { name: `${TAG} viewer`, email: `viewer${MAIL}`, role: "PROFILE", passwordHash: "x".repeat(60) } });
    await db.userPermission.createMany({
      data: [
        { userId: viewer.id, permission: "leads.view", allowed: true, reason: TAG },
        { userId: viewer.id, permission: "documents.view", allowed: false, reason: TAG },
        { userId: viewer.id, permission: "documents.issue", allowed: false, reason: TAG },
      ],
    });
    // Inserted naming its columns, so the suite runs whatever columns other work has added to companies
    // and not migrated yet (a create returns the whole row).
    const company = async (name: string) => {
      const id = `zzlq_${name.toLowerCase()}_${Date.now()}`;
      await db.$executeRaw`INSERT INTO "companies" ("id", "name", "normalizedName", "relationshipType", "createdById", "ownerUserId", "updatedAt") VALUES (${id}, ${`${TAG} ${name}`}, ${`${TAG} ${name}`.toLowerCase()}, 'CLIENT', ${admin.id}, ${viewer.id}, now())`;
      return { id };
    };
    const acme = await company("Acme");
    const other = await company("Other");
    const lead = (title: string, s: string, companyId = acme.id, value: number | null = 1000) =>
      db.lead.create({ data: { companyId, title: `${TAG} ${title}`, status: s as never, estimatedValue: value, ownerUserId: admin.id } });
    const quoted = await lead("Quoted", "PROPOSAL_SENT");
    const gap = await lead("Gap", "NEGOTIATION", acme.id, null);
    const early = await lead("Early", "QUALIFYING");
    const drafted = await lead("Drafted", "PROPOSAL_SENT");
    const invoiced = await lead("Invoiced", "WON");
    const elsewhere = await lead("Elsewhere", "QUALIFYING", other.id);
    let n = 0;
    const doc = (docType: string, s: string, leadId: string | null, extra: Record<string, unknown> = {}) =>
      db.tradeDocument.create({
        data: { docType, direction: "SALES", status: s, companyId: acme.id, leadId, docNumber: `ZZLQ-${++n}`, taxableValue: 1000 * n, total: 1180 * n, createdById: admin.id, issueDate: at(n), ...extra } as never,
      });
    await doc("PROPOSAL", "REJECTED", quoted.id);
    await doc("PROPOSAL", "ISSUED", quoted.id);
    const proforma = await doc("PROFORMA", "ISSUED", quoted.id);
    await doc("PROPOSAL", "DRAFT", drafted.id);
    await doc("INVOICE", "PAID", invoiced.id);
    const cancelled = await doc("PROPOSAL", "CANCELLED", gap.id);
    const loose = await doc("PROPOSAL", "ISSUED", null);
    const made = await doc("PROFORMA", "ISSUED", null, { sourceDocumentId: loose.id });
    const madeAgain = await doc("INVOICE", "ISSUED", null, { sourceDocumentId: made.id });

    section("Sent or not, for the stage rule and the list");

    ok("a lead with issued documents has had one; one with only a draft or a cancelled one hasn't", (await status.hasQuoteSent(quoted.id)) && !(await status.hasQuoteSent(drafted.id)) && !(await status.hasQuoteSent(gap.id)));
    const rule = { label: "Proposal sent", requiredFields: ["quotation"] };
    const gapStop = await ruleStops(rule, gap);
    ok("a stage that asks for one stops a lead without it", gapStop === "Before Proposal sent, issue a quotation for it.", gapStop);
    const both = await ruleStops({ label: "Proposal sent", requiredFields: ["quotation", "estimatedValue"] }, gap);
    ok("  and says what else it lacks", both === "Before Proposal sent, issue a quotation for it and fill in Value.", both);
    ok("  and lets one with it through", (await ruleStops(rule, quoted)) === null);
    await db.systemModule.upsert({ where: { key: "sales_documents" }, update: { enabled: false }, create: { key: "sales_documents", enabled: false } });
    ok("where Sales Documents is switched off, the rule can't be met, so it is dropped", (await ruleStops(rule, gap)) === null && (await ruleStops({ label: "Won", requiredFields: ["quotation", "estimatedValue"] }, gap))?.endsWith("fill in Value.") === true);
    if (moduleRow) await db.systemModule.update({ where: { key: "sales_documents" }, data: { enabled: moduleRow.enabled } });
    else await db.systemModule.delete({ where: { key: "sales_documents" } });

    const ours = [quoted, gap, early, drafted, invoiced].map((l) => l.id);
    const shown = await status.leadQuotes(admin.id, ours);
    ok(
      "each lead's furthest: the proforma, nothing, nothing, the draft, the invoice",
      shown[quoted.id]?.docNumber === proforma.docNumber && shown[quoted.id]?.sent === 3 && shown[gap.id] === null && shown[early.id] === null && shown[drafted.id]?.status === "DRAFT" && shown[invoiced.id]?.docType === "INVOICE",
      JSON.stringify(Object.values(shown).map((q) => q && `${q.docNumber}:${q.status}`)),
    );

    actorId = admin.id;
    const names = async (quote: "sent" | "none" | "missing") =>
      (await leadActions.listLeads({ search: TAG, quote })).map((l) => l.title.replace(`${TAG} `, "")).sort().join();
    ok("Quotation: sent", (await names("sent")) === "Invoiced,Quoted", await names("sent"));
    ok("Quotation: not sent", (await names("none")) === "Drafted,Early,Elsewhere,Gap", await names("none"));
    ok("Quotation: missing, at Proposal sent or past it", (await names("missing")) === "Drafted,Gap", await names("missing"));

    actorId = viewer.id;
    ok("somebody who can't see sales documents doesn't see quotations", !(await status.seesLeadQuotes(viewer.id)) && (await status.seesLeadQuotes(admin.id)));
    const unfiltered = (await leadActions.listLeads({ search: TAG, quote: "missing" })).length;
    ok("  and the filter narrows nothing for them", unfiltered === 6, unfiltered);
    ok("  and the proposal form offers them no leads", (await linking.listPartyLeads(acme.id)).length === 0);
    const theirs = await linking.linkDocumentToLead({ documentId: loose.id, leadId: early.id });
    ok("  nor may they link one", !theirs.ok, JSON.stringify(theirs));

    section("The proposal form's leads, and Link to lead");

    actorId = admin.id;
    const offered = await linking.listPartyLeads(acme.id);
    ok("the customer's leads, open ones first, each with its stage", offered.length === 5 && offered.at(-1)?.id === invoiced.id && !offered.at(-1)!.open && offered.slice(0, 4).every((l) => l.open && l.stage) && !offered.some((l) => l.id === elsewhere.id), JSON.stringify(offered.map((l) => [l.title, l.stage, l.open])));
    const leadOf = async (id: string) => (await db.tradeDocument.findUnique({ where: { id }, select: { leadId: true } }))?.leadId ?? null;
    const linked = await linking.linkDocumentToLead({ documentId: loose.id, leadId: early.id });
    ok("a proposal linked, and what was made from it follows", linked.ok && (await leadOf(loose.id)) === early.id && (await leadOf(made.id)) === early.id && (await leadOf(madeAgain.id)) === early.id, JSON.stringify(linked));
    ok("  so its lead has had a quotation sent now", (await status.hasQuoteSent(early.id)) && (await status.leadQuotes(admin.id, [early.id]))[early.id]?.docType === "INVOICE");
    await linking.linkDocumentToLead({ documentId: loose.id, leadId: gap.id });
    ok("linked to another, they all move", (await leadOf(loose.id)) === gap.id && (await leadOf(madeAgain.id)) === gap.id);
    await linking.linkDocumentToLead({ documentId: loose.id, leadId: null });
    ok("unlinked, they all let go", (await leadOf(loose.id)) === null && (await leadOf(made.id)) === null);
    const audit = await db.auditLog.findFirst({ where: { userId: admin.id, entityId: loose.id }, orderBy: { createdAt: "desc" } });
    ok("  and the audit says so", audit?.entityLabel === `${loose.docNumber} — no longer linked to a lead`, audit?.entityLabel);
    const foreign = await linking.linkDocumentToLead({ documentId: loose.id, leadId: elsewhere.id });
    ok("another company's lead is refused", !foreign.ok && foreign.error.includes("different company"));
    const notProposal = await linking.linkDocumentToLead({ documentId: proforma.id, leadId: early.id });
    ok("a proforma isn't linked by hand — it follows its proposal", !notProposal.ok && notProposal.error.startsWith("Only a proposal"));
    const off = await linking.linkDocumentToLead({ documentId: cancelled.id, leadId: early.id });
    ok("a cancelled proposal stays as it is", !off.ok && off.error.includes("cancelled"));
  } finally {
    actorId = "";
    const now = await db.systemModule.findUnique({ where: { key: "sales_documents" } });
    if (moduleRow && now?.enabled !== moduleRow.enabled) await db.systemModule.update({ where: { key: "sales_documents" }, data: { enabled: moduleRow.enabled } });
    if (!moduleRow && now) await db.systemModule.delete({ where: { key: "sales_documents" } });
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll lead quotation checks passed." : `\n${failures} lead quotation check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
