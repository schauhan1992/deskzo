/**
 * check:ai-credits — Deskzo AI's credits (owner, 17 Oct 2026; src/lib/ai/credits.ts and packs.ts).
 *
 * On a scratch control plane (dropped at the end, pass or fail). The workspaces are stand-ins on it whose
 * own database is the local one, read only: the notices to billing managers are caught, not written, and
 * nothing leaves the machine — `fetch` answers only as a fake Razorpay, and mail is caught.
 *
 *   · the arithmetic: tokens × rates in thousandths, rounded up; cost in paise; credits in words;
 *   · the allowance: a plan's credits times its quantity, a trial's own number, no limit, none; an answer
 *     worked out before credits worked out again;
 *   · a charge: the allowance first, then packs (the one ending first first, never one that has ended),
 *     then overdraft past zero; kept per person, feature and model, with its cost;
 *   · the hard stop: nothing left refuses the next turn, in words; a person's daily cap stops them alone;
 *   · charges finishing together never take more of the allowance than there is;
 *   · the month on the workspace's own clock, and a plan changed mid-month;
 *   · alerts at four fifths and at none left, once each a month, again after a pack;
 *   · a pack bought through Razorpay: the page asked for at the price with GST, granted once on
 *     `payment_link.paid` (read back first), its invoice kept; a refund takes back its share;
 *   · Workspace 360's view of it.
 *
 *   npm run check:ai-credits
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const DAY = 86_400_000;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ─── The notices to billing managers, caught ─────────────────────────────────────────────────────
type Note = { userId: string; type: string; title: string; message?: string; link?: string };
const notes: Note[] = [];
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/notify") return { notifyUser: async (n: Note) => void notes.push(n) };
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

// ─── A fake Razorpay; nothing else answers ───────────────────────────────────────────────────────
const outside: string[] = [];
const razorpay: { links: Map<string, Record<string, unknown>>; created: Record<string, unknown>[] } = { links: new Map(), created: [] };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === "https://api.razorpay.com/v1/payment_links" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    razorpay.created.push(body);
    const id = `plink_zz${razorpay.created.length}`;
    const link = { id, entity: "payment_link", status: "created", amount: body.amount, amount_paid: 0, currency: "INR", short_url: `https://rzp.io/i/${id}`, notes: body.notes };
    razorpay.links.set(id, link);
    return json(link);
  }
  const m = /^https:\/\/api\.razorpay\.com\/v1\/payment_links\/([^/?]+)$/.exec(url);
  if (m && razorpay.links.has(decodeURIComponent(m[1]!))) return json(razorpay.links.get(decodeURIComponent(m[1]!)));
  outside.push(url);
  throw new Error(`check:ai-credits makes no outside calls — ${url}`);
}) as typeof fetch;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_aicredits_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
    const rules = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const catalogue = require("../src/lib/ai/catalogue") as typeof import("../src/lib/ai/catalogue");
    const credits = require("../src/lib/ai/credits") as typeof import("../src/lib/ai/credits");
    const packs = require("../src/lib/ai/packs") as typeof import("../src/lib/ai/packs");
    const aiSettings = require("../src/lib/ai/settings") as typeof import("../src/lib/ai/settings");
    const accounts = require("../src/lib/ai/accounts") as typeof import("../src/lib/ai/accounts");
    const gateway = require("../src/lib/ai/gateway") as typeof import("../src/lib/ai/gateway");
    const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
    const webhooks = require("../src/lib/billing/webhooks") as typeof import("../src/lib/billing/webhooks");
    const sync = require("../src/lib/billing/sync") as typeof import("../src/lib/billing/sync");
    const gst = require("../src/lib/billing/platform-gst") as typeof import("../src/lib/billing/platform-gst");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    /* eslint-enable @typescript-eslint/no-require-imports */
    type Tenant = import("../src/lib/tenancy/state").Tenant;
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();
    const mail: unknown[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));
    copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });
    const MODEL = { key: "zz-sonnet", label: "Zz Sonnet", providerModel: "zz", inputRate: 270, outputRate: 1350, inputCost: 18_000, outputCost: 90_000 };
    accounts.setTestRoute((feature) => ({
      feature,
      model: MODEL,
      account: { id: "zz", name: "Zz", kind: "BEDROCK", residency: "Zzland", noTraining: true },
      connection: () => ({ kind: "BEDROCK", region: "ap-south-1", accessKeyId: null, secret: "zz" }),
    }));

    section("The arithmetic");
    ok("tokens × rates, in thousandths of a credit: 20,000 in and 1,500 out on Sonnet's rates is 7.425 credits", catalogue.chargeFor({ input: 20_000, output: 1_500 }, MODEL) === 7_425);
    ok("  a part of a thousandth is rounded up, never down to free", catalogue.chargeFor({ input: 1, output: 0 }, MODEL) === 1 && catalogue.chargeFor({ input: 0, output: 0 }, MODEL) === 0);
    ok("  negative or fractional tokens never make a credit", catalogue.chargeFor({ input: -50, output: 0.4 }, MODEL) === 0);
    ok("what it cost Deskzo, in paise: 20,000 in and 1,500 out at ₹180 and ₹900 a million is ₹4.95", catalogue.costFor({ input: 20_000, output: 1_500 }, MODEL) === 495 && catalogue.costFor({ input: 5, output: 5 }, { inputCost: null, outputCost: null }) === null);
    ok("credits in words: whole from 100, a tenth below, never below nothing", catalogue.creditsText(123_456) === "123" && catalogue.creditsText(7_425) === "7.4" && catalogue.creditsText(5_000) === "5" && catalogue.creditsText(-10) === "0" && catalogue.creditsText(2_000_000_000) === "20,00,000");
    const india = credits.monthOf({ timezone: "Asia/Kolkata" }, new Date("2027-01-31T19:00:00Z"));
    const newYork = credits.monthOf({ timezone: "America/New_York" }, new Date("2027-01-31T19:00:00Z"));
    ok("the month is the workspace's own: 31 Jan 19:00 UTC is February in India, still January in New York", india.key === "2027-02" && newYork.key === "2027-01" && india.date.toISOString() === "2027-02-01T00:00:00.000Z" && india.from.toISOString() === "2027-01-31T18:30:00.000Z", `${india.key} ${newYork.key}`);

    section("Plans, workspaces, and their allowance");
    const base = { countries: [] as string[], seats: null, copilotTokens: null as number | null, modules: [] as string[] };
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-one", name: "Zz One", modules: ["tasks"], copilotTokens: 100, isDefault: true }, "script:check");
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-none", name: "Zz None", modules: ["tasks"], copilotTokens: 0 }, "script:check");
    await plans.savePlan({ ...base, kind: "ADDON", key: "zz-plus", name: "Zz Plus", copilotTokens: 750 }, "script:check");
    const make = async (slug: string, items: { planKey: string; quantity: number }[] | "trial", extra: { timezone?: string; country?: string } = {}) => {
      const id = randomUUID();
      await control.tenant.create({
        data: { id, slug, name: `Zz ${slug}`, status: "ACTIVE", keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()), country: extra.country ?? "IN", currency: "INR", ownerEmail: `owner@${slug}.example`, timezone: extra.timezone ?? "Asia/Kolkata" },
      });
      if (items === "trial") {
        const one = await control.plan.findUniqueOrThrow({ where: { key: "zz-one" } });
        await control.$transaction((tx) => plans.startOnPlan(tx, id, one.id, new Date(Date.now() + 14 * DAY)));
        await ent.refreshEntitlements(id);
      } else await plans.setWorkspacePlans(id, items, "script:check");
      return id;
    };
    const envTenant = await registry.legacyTenant();
    if (!envTenant) throw new Error("No local workspace to stand the scratch ones on.");
    /** A scratch workspace as a request would find it: its control-plane row now, its database the local one. */
    const standIn = async (id: string): Promise<Tenant> => {
      const row = await control.tenant.findUniqueOrThrow({ where: { id }, select: { slug: true, name: true, timezone: true, country: true, entitlements: true } });
      return { ...envTenant, id, slug: row.slug, name: row.name, timezone: row.timezone, country: row.country, entitlements: rules.parseEntitlements(row.entitlements), source: "control", isDefault: false };
    };
    const T = await make("zzaic-team", [{ planKey: "zz-one", quantity: 3 }, { planKey: "zz-plus", quantity: 1 }]);
    const TRIAL = await make("zzaic-trial", "trial");
    const NONE = await make("zzaic-none", [{ planKey: "zz-none", quantity: 2 }]);
    const INTERNAL = await make("zzaic-internal", [{ planKey: plans.INTERNAL_PLAN_KEY, quantity: 1 }]);
    const std = await credits.creditStanding(await standIn(T));
    ok("a plan's credits times its quantity, and an add-on's on top: 3 × 100 + 750", std.metered && std.allowance === 1_050_000 && std.available === 1_050_000, std.allowance);
    ok("  worked out in credits", (await standIn(T)).entitlements.inCredits === true);
    ok("a free trial has a trial's credits for the workspace: 200, whatever its plan says", (await credits.creditStanding(await standIn(TRIAL))).allowance === catalogue.TRIAL_CREDITS_DEFAULT * 1000);
    await aiSettings.saveTrialAiCredits(350, "script:check");
    await ent.refreshTrialWorkspaces();
    ok("  staff change it, and every trial has the new number at once", (await credits.creditStanding(await standIn(TRIAL))).allowance === 350_000);
    ok("  a number out of range is refused", await aiSettings.saveTrialAiCredits(-1, "script:check").then(() => false, () => true));
    ok("a plan with none has none; an internal plan no limit", (await credits.creditStanding(await standIn(NONE))).available === 0 && (await credits.creditStanding(await standIn(INTERNAL))).available === null);
    // An answer from before credits: a token count, and no marker.
    await control.tenant.update({ where: { id: NONE }, data: { entitlements: { ...(await standIn(NONE)).entitlements, copilotTokens: 1_000_000, inCredits: undefined } } });
    const stale = await standIn(NONE);
    ok("an answer worked out before credits counted tokens…", stale.entitlements.inCredits === undefined && stale.entitlements.copilotTokens === 1_000_000);
    ok("  …and is worked out again before it is relied on — not a million credits", (await credits.creditStanding(stale)).allowance === 0 && (await standIn(NONE)).entitlements.inCredits === true);
    const env = await credits.creditStanding({ ...envTenant, source: "env" });
    ok("a workspace from the environment keeps no ledger and has no limit", !env.metered && env.available === null);

    section("A charge: the allowance, then packs, then overdraft");
    const C = await make("zzaic-charge", [{ planKey: "zz-one", quantity: 1 }]);
    const tC = await standIn(C);
    const rate1 = { ...MODEL, inputRate: 1000, outputRate: 0, inputCost: 100_000, outputCost: null };
    const charge = (tenant: Tenant, userId: string, creditsWanted: number, now = new Date(), feature: "copilot.chat" | "automate.draft" = "copilot.chat") =>
      runAsTenant(tenant, () => credits.chargeTurn({ tenant, userId, feature, route: { model: rate1 }, usage: { input: creditsWanted * 1000, output: 0 }, now }));
    const first = await charge(tC, "zz-user-a", 30);
    ok("30 credits from a 100-credit allowance: all from the allowance, 70 left", first.credits === 30_000 && first.fromAllowance === 30_000 && first.fromPacks === 0 && first.overdraft === 0 && first.left === 70_000, JSON.stringify(first));
    const used = await control.aiUsage.findFirst({ where: { tenantId: C, userId: "zz-user-a" } });
    ok("  kept per person, feature and model, with its tokens and what it cost Deskzo", used?.feature === "copilot.chat" && used.modelKey === "zz-sonnet" && used.inputTokens === 30_000 && used.cost === 3_000 && used.credits === 30_000);
    const later = new Date(Date.now() + 365 * DAY);
    const soon = new Date(Date.now() + 30 * DAY);
    await packs.grantPack({ tenantId: C, source: "STAFF", packKey: null, credits: 20, reason: "zz later", expiresAt: later });
    await packs.grantPack({ tenantId: C, source: "STAFF", packKey: null, credits: 10, reason: "zz soon", expiresAt: soon });
    await packs.grantPack({ tenantId: C, source: "STAFF", packKey: null, credits: 50, reason: "zz ended", expiresAt: new Date(Date.now() - DAY) });
    const s1 = await credits.creditStanding(tC);
    ok("packs are added on top; one that has ended counts for nothing", s1.packsRemaining === 30_000 && s1.available === 100_000, s1.available);
    const second = await charge(tC, "zz-user-b", 80);
    const packRows = await control.aiCreditPack.findMany({ where: { tenantId: C }, orderBy: { expiresAt: "asc" }, select: { reason: true, remaining: true } });
    ok("80 more: the 70 left of the allowance, then the pack ending first, then the next", second.fromAllowance === 70_000 && second.fromPacks === 10_000 && second.overdraft === 0, JSON.stringify(second));
    ok("  the soon pack is spent and the later one untouched; the ended one never", packRows.find((p) => p.reason === "zz soon")?.remaining === 0 && packRows.find((p) => p.reason === "zz later")?.remaining === 20_000 && packRows.find((p) => p.reason === "zz ended")?.remaining === 50_000);
    const third = await charge(tC, "zz-user-b", 25);
    ok("a turn that runs past zero is finished, the rest absorbed as overdraft", third.fromPacks === 20_000 && third.overdraft === 5_000 && third.left === 0, JSON.stringify(third));
    const split = await control.aiUsage.findMany({ where: { tenantId: C } });
    ok("  every charge adds up: allowance + packs + overdraft = what was charged", split.every((u) => u.fromAllowance + u.fromPacks + u.overdraft === u.credits));
    const month = await control.aiCreditMonth.findFirstOrThrow({ where: { tenantId: C } });
    ok("  the month's row: the whole allowance used, 30 from packs, 5 past zero", month.allowanceUsed === 100_000 && month.packsUsed === 30_000 && month.overdraft === 5_000);

    section("The hard stop, and a person's daily cap");
    const stop = await runAsTenant(tC, () => gateway.aiUnavailable("zz-user-a", "copilot.chat"));
    ok("nothing left: the next turn is refused before it starts, saying when it renews and how to buy more", !!stop && /used all its Deskzo AI credits/.test(stop) && /pack/.test(stop), stop);
    const stopNone = await runAsTenant(await standIn(NONE), () => gateway.aiUnavailable("zz-user-a", "copilot.chat"));
    ok("  a plan with none says AI isn't part of it — a pack adds it", !!stopNone && /isn't part of this workspace's plan/.test(stopNone), stopNone);
    const D = await make("zzaic-daily", [{ planKey: "zz-one", quantity: 5 }]);
    const tD = await standIn(D);
    copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: 10 });
    await charge(tD, "zz-heavy", 12);
    const heavy = await runAsTenant(tD, () => gateway.aiUnavailable("zz-heavy", "copilot.chat"));
    const light = await runAsTenant(tD, () => gateway.aiUnavailable("zz-light", "automate.draft"));
    ok("a person past the workspace's daily cap is stopped, every feature together", !!heavy && /today's 10 Deskzo AI credits/.test(heavy), heavy);
    ok("  a colleague isn't", light === null, light);
    ok("  what a person used today is theirs alone", (await credits.usedTodayBy("zz-heavy", tD)) === 12_000 && (await credits.usedTodayBy("zz-light", tD)) === 0);
    copilotSettings.setTestSettings({ enabled: true, draftingEnabled: true, dailyCreditLimit: null });
    ok("with credits left and no cap, it runs", (await runAsTenant(tD, () => gateway.aiUnavailable("zz-heavy", "copilot.chat"))) === null);
    await aiSettings.setAiPaused(true, "script:check");
    ok("paused platform-wide, nobody's runs", /paused/.test((await runAsTenant(tD, () => gateway.aiUnavailable("zz-light", "copilot.chat"))) ?? ""));
    await aiSettings.setAiPaused(false, "script:check");

    section("Charges finishing together");
    const P = await make("zzaic-parallel", [{ planKey: "zz-one", quantity: 1 }]);
    const tP = await standIn(P);
    const together = await Promise.all(Array.from({ length: 8 }, (_, i) => charge(tP, `zz-p${i}`, 20)));
    const pMonth = await control.aiCreditMonth.findFirstOrThrow({ where: { tenantId: P } });
    ok("eight turns of 20 at once against 100: exactly 100 from the allowance, 60 past zero — never more taken than there was", pMonth.allowanceUsed === 100_000 && pMonth.overdraft === 60_000 && together.reduce((n, c) => n + c.fromAllowance, 0) === 100_000, `${pMonth.allowanceUsed} ${pMonth.overdraft}`);

    section("The month, and a plan changed in it");
    const IN = await make("zzaic-india", [{ planKey: "zz-one", quantity: 1 }]);
    const NY = await make("zzaic-newyork", [{ planKey: "zz-one", quantity: 1 }], { timezone: "America/New_York", country: "US" });
    const edge = new Date("2027-01-31T19:00:00Z");
    await charge(await standIn(IN), "zz-m", 40, new Date("2027-01-20T06:00:00Z"));
    await charge(await standIn(IN), "zz-m", 40, edge);
    await charge(await standIn(NY), "zz-m", 40, new Date("2027-01-20T06:00:00Z"));
    await charge(await standIn(NY), "zz-m", 40, edge);
    const inMonths = await control.aiCreditMonth.findMany({ where: { tenantId: IN }, orderBy: { month: "asc" }, select: { month: true, allowanceUsed: true } });
    const nyMonths = await control.aiCreditMonth.findMany({ where: { tenantId: NY }, select: { month: true, allowanceUsed: true } });
    ok("in India the second turn falls in February: a fresh allowance", inMonths.length === 2 && inMonths[1]!.month.toISOString().startsWith("2027-02-01") && inMonths[0]!.allowanceUsed === 40_000 && inMonths[1]!.allowanceUsed === 40_000);
    ok("  in New York it is still January: one month, 80 used", nyMonths.length === 1 && nyMonths[0]!.allowanceUsed === 80_000);
    await plans.setWorkspacePlans(IN, [{ planKey: "zz-one", quantity: 2 }], "script:check");
    const grown = await charge(await standIn(IN), "zz-m", 10, new Date("2027-02-03T06:00:00Z"));
    ok("a plan grown mid-month: the month's allowance grows with it", grown.left === 200_000 - 50_000 && (await control.aiCreditMonth.findFirstOrThrow({ where: { tenantId: IN, month: new Date("2027-02-01T00:00:00Z") } })).allowance === 200_000, grown.left);

    section("Alerts to billing managers");
    const managers = await runAsTenant(tC, () => credits.billingManagers());
    const A = await make("zzaic-alerts", [{ planKey: "zz-one", quantity: 1 }]);
    const tA = await standIn(A);
    notes.length = 0;
    await charge(tA, "zz-x", 70);
    const a1 = await control.aiCreditMonth.findFirstOrThrow({ where: { tenantId: A } });
    ok("70 of 100: no alert yet", a1.alert80At === null && notes.length === 0);
    await charge(tA, "zz-x", 15);
    await charge(tA, "zz-x", 2);
    const a2 = await control.aiCreditMonth.findFirstOrThrow({ where: { tenantId: A } });
    ok("past four fifths: told once, however many turns follow", a2.alert80At !== null && a2.alert100At === null && notes.length === managers.length && notes.every((n) => n.type === "AI_CREDITS" && /running low/.test(n.title)), `${notes.length} for ${managers.length} managers`);
    await charge(tA, "zz-x", 20);
    const a3 = await control.aiCreditMonth.findFirstOrThrow({ where: { tenantId: A } });
    ok("none left: told once more, that AI has stopped", a3.alert100At !== null && notes.length === 2 * managers.length && notes.slice(managers.length).every((n) => /used up/.test(n.title) && n.link === "/settings/billing#ai-credits"));
    await packs.grantPack({ tenantId: A, source: "STAFF", packKey: null, credits: 100, reason: "zz top-up" });
    ok("a pack clears the month's alerts, so running low again is said again", (await control.aiCreditMonth.findFirstOrThrow({ where: { tenantId: A } })).alert80At === null);
    ok("  and the next turn runs again", (await runAsTenant(tA, () => gateway.aiUnavailable("zz-x", "copilot.chat"))) === null);
    ok("a pack is a whole number of credits", await packs.grantPack({ tenantId: A, source: "STAFF", packKey: null, credits: 1.5 }).then(() => false, () => true));

    section("A pack bought through Razorpay");
    const B = await make("zzaic-buyer", [{ planKey: "zz-one", quantity: 1 }]);
    const ABROAD = await make("zzaic-abroad", [{ planKey: "zz-one", quantity: 1 }], { country: "US", timezone: "America/New_York" });
    const closed = await packs.packOffer({ country: "IN" });
    ok("without Razorpay's keys, packs aren't on sale online, and it says so", !closed.open && /isn't open yet/.test(closed.reason ?? "") && closed.packs.length === 3);
    await settings.setSecret("razorpay.keyId", "rzp_test_zzaicredits", "script:check");
    await settings.setSecret("razorpay.keySecret", "zz-secret", "script:check");
    const offer = await packs.packOffer({ country: "IN" });
    ok("in India: the owner's three packs, with 18% GST on top", offer.open && offer.packs.map((p) => `${p.credits}:${p.amount}:${p.total}`).join() === "500:49900:58882,2000:179900:212282,10000:799900:943882", offer.packs.map((p) => `${p.credits}:${p.amount}:${p.total}`).join());
    ok("  abroad there is no price yet: staff add credits", !(await packs.packOffer({ country: "US" })).open);
    ok("  a workspace abroad can't start one", await packs.startPackCheckout(ABROAD, "ai-500", "https://x.example/").then(() => false, (err) => err instanceof packs.PackRefused));
    const page = await packs.startPackCheckout(B, "ai-2000", "https://zzaic-buyer.example/settings/billing?credits=done");
    const asked = razorpay.created.at(-1)!;
    ok("the page Razorpay is asked for: the price with GST, our notes, back to the billing page", page.url.startsWith("https://rzp.io/i/") && asked.amount === gst.withPlatformGst(179_900) && (asked.notes as Record<string, string>).tenantId === B && (asked.notes as Record<string, string>).credits === "2000" && asked.callback_url === "https://zzaic-buyer.example/settings/billing?credits=done");
    ok("  a pack that isn't on sale is refused", await packs.startPackCheckout(B, "ai-7", "https://x.example/").then(() => false, (err) => err instanceof packs.PackRefused));
    const linkId = page.url.split("/").at(-1)!;
    const event = (status: string) => ({
      entity: "event" as const,
      event: "payment_link.paid",
      payload: {
        payment_link: { entity: { ...(razorpay.links.get(linkId) as object), status } as never },
        payment: { entity: { id: "pay_zzaic1", entity: "payment" as const, amount: gst.withPlatformGst(179_900), currency: "INR", status: "captured", created_at: Math.floor(Date.now() / 1000) } },
      },
    });
    // What the webhook says is not trusted: Razorpay still says "created".
    const early = await webhooks.dispatchRazorpayEvent(event("paid")).then(() => "granted", (err) => String(err));
    ok("an event claiming it paid, while Razorpay says it isn't, grants nothing", /not granting/.test(early) && (await control.aiCreditPack.count({ where: { tenantId: B } })) === 0, early);
    razorpay.links.set(linkId, { ...razorpay.links.get(linkId)!, status: "paid", amount_paid: gst.withPlatformGst(179_900) });
    const granted = await webhooks.dispatchRazorpayEvent(event("paid"));
    await webhooks.dispatchRazorpayEvent(event("paid"));
    const bought = await control.aiCreditPack.findMany({ where: { tenantId: B } });
    ok("paid: 2,000 credits granted once, however often it is said", granted === B && bought.length === 1 && bought[0]!.credits === 2_000_000 && bought[0]!.source === "RAZORPAY" && bought[0]!.packKey === "ai-2000");
    ok("  for twelve months", Math.abs(bought[0]!.expiresAt.getTime() - Date.now() - 365 * DAY) < 3 * DAY);
    const invoice = await control.invoice.findUniqueOrThrow({ where: { gateway_externalId: { gateway: "RAZORPAY", externalId: "pay_zzaic1" } } });
    ok("  its invoice: paid, the GST inside the charge, a line in its own words", invoice.status === "PAID" && invoice.total === 212_282 && invoice.tax === gst.platformGstIn(212_282) && JSON.stringify(invoice.planLines).includes("2,000 Deskzo AI credits") && bought[0]!.invoiceId === invoice.id);
    ok("  and the credits are there to use", (await credits.creditStanding(await standIn(B))).packsRemaining === 2_000_000);
    await charge(await standIn(B), "zz-b", 100 + 500); // the allowance, then 500 of the pack
    await sync.applyRazorpayRefund({ id: "pay_zzaic1", entity: "payment", amount: 212_282, currency: "INR", status: "refunded", created_at: 0, amount_refunded: 106_141 });
    const afterRefund = await control.aiCreditPack.findFirstOrThrow({ where: { tenantId: B } });
    ok("half refunded: the pack keeps half, less what was already used (1,000 − 500 = 500 left)", afterRefund.remaining === 500_000, afterRefund.remaining);
    await sync.applyRazorpayRefund({ id: "pay_zzaic1", entity: "payment", amount: 212_282, currency: "INR", status: "refunded", created_at: 0, amount_refunded: 212_282 });
    ok("  all of it refunded: nothing left of it", (await control.aiCreditPack.findFirstOrThrow({ where: { tenantId: B } })).remaining === 0);

    section("Workspace 360's view, and the breakdown");
    const view = await credits.consoleCreditView(C);
    ok("the console sees the month, packs given and lapsed, and use by feature and model", !!view && view.allowanceUsed === 100_000 && view.overdraft === 5_000 && view.packs.length === 3 && view.byModel[0]!.modelKey === "zz-sonnet" && view.byModel[0]!.credits === 135_000 && view.byModel[0]!.cost === 13_500);
    const window = credits.monthOf(tC);
    const rows = await credits.usageBreakdown(C, window.from, window.to);
    ok("  the breakdown by person: B used 105, A 30", rows.find((r) => r.userId === "zz-user-b")?.credits === 105_000 && rows.find((r) => r.userId === "zz-user-a")?.credits === 30_000);
    ok("  and the daily snapshot counts whole credits used this month", (await credits.creditsUsedThisMonth(tC)) === 135);
  } finally {
    try {
      const req = Module.createRequire(__filename);
      (req("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
      (req("../src/lib/ai/accounts") as typeof import("../src/lib/ai/accounts")).setTestRoute(null);
      (req("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings")).setTestSettings(null);
    } catch {
      // Never loaded.
    }
    if (cleanup) await cleanup().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${controlName}`;
    ok("the scratch control plane is dropped", Number(left[0]!.n) === 0);
    ok("and not one request left the machine", outside.length === 0, outside.join(", "));
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} AI credit checks passed.` : `\n${failures} check(s) FAILED (${passes} passed).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
