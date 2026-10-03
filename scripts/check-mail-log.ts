/**
 * The mail log — every email the ERP sent a customer, per customer and across them.
 *
 *   · The vocabulary: what a message came from, who sent it, and the preview that loads nothing and
 *     follows no link (a look in the log must never count as the customer opening it).
 *   · A renewal notice sent through the real sender records who sent it, about which order, and
 *     which notice — with the send step itself replaced, so nothing reaches a real provider.
 *   · The log through the real actions: filters, the per-customer summary, one message in full, and
 *     who may see any of it (`emails.view`, and the account scope).
 *   · The Emails tab, the Mail log page, and a message page.
 *
 * Everything is named ZZPROBE_MAIL and removed in a finally, found by probe owner as well as name.
 *
 *   npm run check:mail-log
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import { MAIL_STATUS_GROUPS, mailPreviewDocument, mailSender, mailSource } from "../src/lib/mail-log";
import { MODULE_REGISTRY } from "../src/lib/modules";
import { renderHtml } from "./lib/render-html";

let actorId = "";
let sendAttempts = 0;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "PROFILE", name: "Zzprobe Mail", email: `x${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user() };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/mail-log",
    };
  }
  // The real pipeline, except that sending does nothing: this database has live providers enabled,
  // and a check must never put mail on the wire — nor flush anybody else's queue while it runs.
  if (request === "@/lib/marketing/pipeline") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      sendQueued: async () => {
        sendAttempts += 1;
        return { claimed: 0, sent: 0, failed: 0 };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_MAIL";
const MAIL = "@zzprobe-mail.invalid";
const DAY = 86_400_000;
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { ownerUserId: { in: userIds } }, { createdById: { in: userIds } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  await db.marketingMessage.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { sentByUserId: { in: userIds } }] } });
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  section("The vocabulary");

  const base = { noticeKind: null, messageClass: "MARKETING" as const, campaign: null, enrolment: null, sentBy: null, companyProduct: null };
  const order = (n: number) => `ORD-${String(n).padStart(6, "0")}`;
  ok("a campaign message says which campaign", mailSource({ ...base, campaign: { reference: "CMP-7", name: "Q4 renewals" } }, order) === "Campaign CMP-7 — Q4 renewals");
  ok("a journey message says which journey", mailSource({ ...base, enrolment: { journey: { name: "Onboarding" } } }, order) === "Journey — Onboarding");
  ok(
    "a notice says which, and about which order",
    mailSource({ ...base, messageClass: "TRANSACTIONAL", noticeKind: "RENEWAL", companyProduct: { orderSeq: 42 } }, order) === "Renewal reminder for ORD-000042",
  );
  ok("the sender is the person, or the campaign's author, or automatic", mailSender({ ...base, sentBy: { name: "Asha" } }) === "Asha" && mailSender({ ...base, campaign: { reference: "C", name: "n", createdBy: { name: "Ravi" } } }) === "Ravi (campaign)" && mailSender({ ...base, enrolment: { journey: { name: "j" } } }) === "Automatic");
  ok("  and an older message says it wasn't recorded rather than guessing", mailSender(base) === "Not recorded");
  ok("delivered includes opened and clicked; problems are bounces, spam and failures", MAIL_STATUS_GROUPS.delivered.statuses.includes("OPENED") && [...MAIL_STATUS_GROUPS.problem.statuses].sort().join() === "BOUNCED,COMPLAINED,FAILED");

  const text = mailPreviewDocument("Dear Asha,\nSeats: 5 < 10 & counting");
  ok("a plain-text body is escaped, keeping its line breaks", text.includes("5 &lt; 10 &amp; counting") && text.includes("white-space:pre-wrap"));
  const scripted = mailPreviewDocument("<p>Hi</p><script>alert(1)</script>");
  ok(
    "a script in an HTML body cannot run — the policy allows no script source at all",
    scripted.includes("default-src 'none'") && !/script-src/.test(scripted),
  );
  const html = mailPreviewDocument('<p>Hi</p><img src="https://tracker.example/o.gif"><a href="https://example.com">x</a>');
  ok("an HTML body is shown as sent", html.includes("<p>Hi</p>") && html.includes("tracker.example"));
  ok("  in a document that may load nothing from anywhere — no pixel can fire", html.includes("default-src 'none'") && html.includes("img-src data:"));
  ok("  and whose links open nowhere, and would name no referrer if they did", html.includes('<base target="_blank">') && html.includes('name="referrer" content="no-referrer"'));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const mailActions = require("../src/actions/mail-log") as typeof import("../src/actions/mail-log");
  const { queueCustomerNotice } = require("../src/lib/marketing/order-notice") as typeof import("../src/lib/marketing/order-notice");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");
  const LogPage = (require("../src/app/(dashboard)/mail-log/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
  const MessagePage = (require("../src/app/(dashboard)/mail-log/[id]/page") as { default: (p: unknown) => Promise<ReactElement> }).default;

  await cleanup();
  try {
    const make = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzprobe ${name}`,
          email: `${name}${MAIL}`,
          role: "PROFILE",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const agent = await make("agent", { "companies.viewAll": false });
    const outsider = await make("outsider", { "companies.viewAll": false });
    const blind = await make("blind", { "companies.viewAll": true, "emails.view": false });

    const customer = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: agent.id, ownerUserId: agent.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const email = "asha@zzprobe-mail.invalid";
    const contact = await db.contact.create({
      data: { companyId: customer.id, name: "Asha Probe", email, isPrimary: true, emailStatus: "VALID", emailCheckedValue: email, emailCheckedAt: new Date(), emailCheckMethod: "CONFIRMED" },
    });
    const location = await db.companyLocation.create({ data: { companyId: customer.id, label: "Head Office", isPrimary: true } });
    const item = await db.item.create({ data: { name: `${TAG} 365`, sku: `${TAG}-1`, type: "SUBSCRIPTION", sellingPrice: 1000, createdById: agent.id } });
    const subscription = await db.companyProduct.create({
      data: { companyId: customer.id, locationId: location.id, itemId: item.id, addedByUserId: agent.id, orderStatus: "FULFILLED", endDate: new Date(Date.now() + 20 * DAY) },
    });

    section("A renewal notice records who sent it, and about what");

    actorId = agent.id;
    const notice = await queueCustomerNotice({ companyProductId: subscription.id, contactIds: [contact.id], kind: "RENEWAL", origin: "https://erp.example", sentByUserId: agent.id });
    const queued = await db.marketingMessage.findFirst({ where: { companyId: customer.id, noticeKind: "RENEWAL" } });
    ok("the notice is queued through the real sender", notice.ok && !!queued, notice.ok ? "" : notice.error);
    ok("  with who sent it, the order, and the kind of notice", queued?.sentByUserId === agent.id && queued.companyProductId === subscription.id && queued.messageClass === "TRANSACTIONAL");
    ok("  and nothing was put on the wire", sendAttempts === 1 && queued?.status === "QUEUED");

    // The rest of the history, written directly: delivered-and-opened, bounced, held back, WhatsApp.
    const msg = (data: Record<string, unknown>) =>
      db.marketingMessage.create({
        data: { token: `${TAG}-${Math.random().toString(36).slice(2)}`, companyId: customer.id, contactId: contact.id, toEmail: email, scheduledFor: new Date(), body: "Hello", ...data } as never,
      });
    const opened = await msg({ subject: `${TAG} Welcome aboard`, body: "<p>Welcome</p>", status: "OPENED", sentAt: new Date(Date.now() - 3 * DAY), createdAt: new Date(Date.now() - 3 * DAY) });
    await db.messageEvent.createMany({
      data: [
        { messageId: opened.id, type: "DELIVERED", occurredAt: new Date(Date.now() - 3 * DAY + 60_000) },
        { messageId: opened.id, type: "OPEN", occurredAt: new Date(Date.now() - 2 * DAY) },
      ],
    });
    await msg({ subject: `${TAG} Price update`, status: "BOUNCED", sentAt: new Date(Date.now() - 40 * DAY), createdAt: new Date(Date.now() - 40 * DAY), error: "550 mailbox unavailable" });
    await msg({ subject: `${TAG} Offer`, status: "SUPPRESSED", suppressedReason: "Unsubscribed from offers", createdAt: new Date(Date.now() - 10 * DAY) });
    await msg({ subject: `${TAG} WhatsApp hello`, channel: "WHATSAPP", toEmail: null, toPhone: "+919800000099", status: "SENT", sentAt: new Date(), createdAt: new Date() });

    section("The log, through the real actions");

    const all = await mailActions.listMailLog({ companyId: customer.id, page: 1, pageSize: 50 });
    ok("the customer's emails are all there, WhatsApp left out by default", all.total === 4 && !all.rows.some((r) => r.channel === "WHATSAPP"), all.total);
    const noticeRow = all.rows.find((r) => r.noticeKind === "RENEWAL");
    ok("  the notice reads as what it was and who sent it", !!noticeRow?.source.startsWith("Renewal reminder for ORD-") && noticeRow.sender === "Zzprobe agent", `${noticeRow?.source} / ${noticeRow?.sender}`);
    ok("  the opened one shows when it was opened", !!all.rows.find((r) => r.id === opened.id)?.openedAt);
    const problems = await mailActions.listMailLog({ companyId: customer.id, status: "problem", page: 1, pageSize: 50 });
    ok("the problems filter finds the bounce, with its reason", problems.total === 1 && problems.rows[0]?.error === "550 mailbox unavailable");
    ok("the held-back filter finds the suppressed one", (await mailActions.listMailLog({ companyId: customer.id, status: "held", page: 1, pageSize: 50 })).rows[0]?.suppressedReason === "Unsubscribed from offers");
    ok("notices can be told from marketing", (await mailActions.listMailLog({ companyId: customer.id, kind: "TRANSACTIONAL", page: 1, pageSize: 50 })).total === 1);
    ok("search finds a subject", (await mailActions.listMailLog({ q: `${TAG} Welcome`, page: 1, pageSize: 50 })).total === 1);
    ok("WhatsApp is there when asked for", (await mailActions.listMailLog({ companyId: customer.id, channel: "ALL", page: 1, pageSize: 50 })).total === 5);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - 20 * DAY));
    ok("a date range keeps the last three weeks and drops the older bounce", (await mailActions.listMailLog({ companyId: customer.id, from: today, page: 1, pageSize: 50 })).total === 3);

    const summary = await mailActions.companyMailSummary(customer.id);
    ok("the summary counts them", summary?.total === 4 && summary.delivered === 1 && summary.opened === 1 && summary.problem === 1 && summary.held === 1, JSON.stringify(summary));
    const full = await mailActions.getMailMessage(opened.id);
    ok("one message in full has its body and what happened to it", full?.body === "<p>Welcome</p>" && full.events.map((e) => e.type).join() === "DELIVERED,OPEN");

    section("Who may see it");

    actorId = outsider.id;
    ok("another account's emails are not in someone else's log", (await mailActions.listMailLog({ q: TAG, page: 1, pageSize: 50 })).total === 0);
    ok("  nor readable by id", (await mailActions.getMailMessage(opened.id)) === null && (await mailActions.companyMailSummary(customer.id)) === null);
    actorId = blind.id;
    ok("without the emails view there is no log at all", (await mailActions.listMailLog({ q: TAG, page: 1, pageSize: 50 })).total === 0 && (await mailActions.getMailMessage(opened.id)) === null);

    section("The screens");

    actorId = agent.id;
    const tab = await renderHtml(CompanyDetail({ id: customer.id, tab: "emails" }));
    ok("the customer page has an Emails tab listing what was sent", tab.includes(">Emails</a>") && tab.includes("Emails sent") && tab.includes(`${TAG} Welcome aboard`));
    ok("  with the reason beside what didn't arrive", tab.includes("550 mailbox unavailable") && tab.includes("Unsubscribed from offers"));
    actorId = blind.id;
    const blindTab = await renderHtml(CompanyDetail({ id: customer.id, tab: "emails" }));
    ok("  and no Emails tab without the view", !blindTab.includes(">Emails</a>"));
    actorId = agent.id;
    const log = await renderHtml(LogPage({ searchParams: Promise.resolve({ companyId: customer.id }) }));
    ok("the Mail log page, narrowed to the customer", log.includes(`${TAG} Customer`) && log.includes("show every customer") && log.includes(`${TAG} Price update`));
    const page = await renderHtml(MessagePage({ params: Promise.resolve({ id: opened.id }) }));
    ok("a message page shows it in a frame that allows nothing", page.includes('sandbox=""') && page.includes("default-src") && page.includes("Opened"));
    ok("the Mail log is in the sidebar, behind the emails view", MODULE_REGISTRY.flatMap((m) => m.navItems).find((n) => n.href === "/mail-log")?.permission === "emails.view");
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll mail-log checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
