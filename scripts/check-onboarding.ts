/**
 * check:onboarding — a friendlier signup, and the Getting started wizard that must be finished (owner's
 * request, 1 Oct 2026).
 *
 *   A. The steps, without a database (src/lib/help/getting-started.ts): who gets which, required and
 *      skippable, finished = done or skipped, company skips versus a person's own; the company profile's
 *      essentials and the wizard's small forms, each problem in words that say why.
 *   B. The dashboard's tabs and when the wizard opens (src/lib/help/onboarding.ts).
 *   C. Signup: every bad field at once, each with its reason — in the browser's checks and through the
 *      real `startSignup` (the real control plane, read only: every form sent here is refused, so
 *      nothing is created and no mail leaves) — the code stage's messages on one pending signup made
 *      here, and that nothing is said that wasn't before (whether an address owns a workspace).
 *   D. Through the real actions, as probe users in the workspace database: refusals (a required step, a
 *      company step without settings.manage, finishing early, viewing as somebody), skips and their
 *      audit rows, completion set once, the dashboard's tabs before and after, the wizard's open
 *      conditions on real rows (new, finished, backfilled, platform support), and a newly invited user
 *      starting not finished.
 *   E. Renders, saved to $ONBOARDING_RENDERS when it is set: the signup loader and form, the wizard at
 *      its first, a middle and the last step and its end, and Getting Started before and after.
 *
 * Probe users are Zzonb…@zzprobe-onboarding.invalid; everything they make is removed in a `finally`,
 * the organisation's skip list is put back exactly as found, and the pending signup is deleted. No
 * password is typed or set: probes sign in as nobody — the session module is replaced.
 *
 *   npm run check:onboarding
 */
import "dotenv/config";
import Module from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import { allFinished, firstUnfinished, gettingStartedSteps, profileComplete, progressOf, skipScope, type GettingStartedFacts, type GettingStartedStep } from "../src/lib/help/getting-started";
import { autoOpenedKey, dashboardTabKeys, onboardingPending, resolveDashboardTab, wizardAutoOpens, wizardMounted } from "../src/lib/help/onboarding";
import { companyProfileIssues, companyProfileProblem } from "../src/lib/help/company-profile";
import { EMPTY_HELP, EMPTY_ITEM, helpIssues, itemIssues, skuFrom } from "../src/lib/help/onboarding-forms";
import { CODE_ATTEMPTS_USED, CODE_EXPIRED, codeShapeProblem, emailShapeProblem, firstIssue, simpleSignupIssues, wrongCodeMessage } from "../src/lib/signup-fields";

process.env.TRUST_PROXY = "";

const db = directClient();
const MAIL = "@zzprobe-onboarding.invalid";
const TAG = "Zzonb";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const json = (v: unknown) => JSON.stringify(v);

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : json(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
async function part(title: string, work: () => Promise<void>) {
  section(title);
  try {
    await work();
  } catch (err) {
    ok("the section ran to its end", false, err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 6).join("\n")}` : String(err));
  }
}

const RENDERS = process.env.ONBOARDING_RENDERS?.trim() || "";
function saveRender(name: string, html: string) {
  if (!RENDERS) return;
  mkdirSync(RENDERS, { recursive: true });
  writeFileSync(path.join(RENDERS, name), `<!doctype html><meta charset="utf-8"><title>${name}</title>\n${html}`);
}

// ─── Who is asking, and the request around them ──────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
let viewingAs = false;
const VIEW_AS = "You're viewing as someone else. Switch back to yourself to change account security.";
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "www.localhost:3000", "user-agent": "check:onboarding" });

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const realLoad = internals._load;
const lazy = new Map<string, () => unknown>([
  [
    load.resolve("../src/lib/session"),
    () => ({
      requireUser: async () => {
        if (!actor) throw new Error("The check called an action without saying who was calling it.");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => (viewingAs && actor ? { user: actor, actor } : null),
      refuseWhileViewingAs: async () => (viewingAs ? VIEW_AS : null),
    }),
  ],
  [load.resolve("next/cache"), () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn })],
  [
    load.resolve("next/navigation"),
    () => ({
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/dashboard",
    }),
  ],
  [
    load.resolve("next/headers"),
    () => ({
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    }),
  ],
  // Linking a new account to the platform's index is the control plane's business, not this check's.
  [load.resolve("../src/lib/platform/account-hooks"), () => ({ accountsChanged: async () => {}, workspaceAccountsReset: async () => {} })],
  // A dialog portals to <body>; rendered to a string, it stays where it is.
  [load.resolve("react-dom"), () => ({ ...(realLoad.call(internals, "react-dom", module, false) as object), createPortal: (node: unknown) => node })],
]);
const made = new Map<string, unknown>();
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && lazy.has(resolved)) {
    if (!made.has(resolved)) made.set(resolved, lazy.get(resolved)!());
    return made.get(resolved);
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const facts = (over: Partial<GettingStartedFacts> = {}): GettingStartedFacts => ({
  admin: false,
  helpManager: false,
  itemsModule: true,
  organisationReady: false,
  hasLogo: false,
  activeUsers: 1,
  itemCount: 0,
  helplineSet: false,
  hasPhoto: false,
  hasTwoFactor: false,
  ...over,
});
const byKey = (steps: GettingStartedStep[]) => Object.fromEntries(steps.map((s) => [s.key, s])) as Record<string, GettingStartedStep>;
const keysOf = (steps: { key: string }[]) => steps.map((s) => s.key).join(",");

// ─── Cleanup: by the probes' addresses and ids, never by trusting a name ────────────────────────

let orgBefore: { exists: boolean; skipped: string[] } | null = null;
let pendingSignupId: string | null = null;

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
    await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  if (orgBefore) {
    if (orgBefore.exists) await db.organisationSettings.update({ where: { id: "global" }, data: { onboardingSkipped: orgBefore.skipped } });
    else await db.organisationSettings.deleteMany({ where: { id: "global" } });
  }
}

async function main() {
  // ─── A ─────────────────────────────────────────────────────────────────────────────────────────
  await part("A. The steps", async () => {
    const owner = gettingStartedSteps(facts({ admin: true, helpManager: true }));
    ok("the owner gets the company's steps and their own, in order", keysOf(owner) === "organisation,logo,team,items,helpline,photo,two-factor", keysOf(owner));
    ok("everybody else gets their own: photo, two-factor", keysOf(gettingStartedSteps(facts())) === "photo,two-factor");
    ok("help.manage alone adds no company step; settings.manage without it leaves the help step out", keysOf(gettingStartedSteps(facts({ helpManager: true }))) === "photo,two-factor" && !gettingStartedSteps(facts({ admin: true })).some((s) => s.key === "helpline"));
    ok("Items switched off: no 'add what you sell'", !gettingStartedSteps(facts({ admin: true, itemsModule: false })).some((s) => s.key === "items"));
    ok("required: the company profile and two-factor, and only those", owner.filter((s) => s.required).map((s) => s.key).join(",") === "organisation,two-factor");
    ok("  required steps can't be skipped; every other step can", owner.every((s) => s.skippable === !s.required));
    ok("company skips: logo, team, items, help; a person's own: photo", ["logo", "team", "items", "helpline"].every((k) => skipScope(k as never) === "company") && skipScope("photo") === "personal" && skipScope("organisation") === null && skipScope("two-factor") === null);

    const skipped = byKey(gettingStartedSteps(facts({ admin: true, helpManager: true, companySkipped: ["logo", "organisation"], personalSkipped: ["photo", "two-factor"] })));
    ok("a skipped optional step is finished — skipped, not done", skipped.logo!.skipped && skipped.logo!.finished && !skipped.logo!.done);
    ok("a skip of a required step counts for nothing", !skipped.organisation!.finished && !skipped["two-factor"]!.finished && !skipped.organisation!.skipped);
    ok("a person's own skip finishes their photo", skipped.photo!.skipped && skipped.photo!.finished);
    const crossed = byKey(gettingStartedSteps(facts({ admin: true, companySkipped: ["photo"], personalSkipped: ["logo", "team"] })));
    ok("company and personal skips don't cross: 'photo' on the company's list, 'logo' on a person's", !crossed.photo!.finished && !crossed.logo!.finished && !crossed.team!.finished);
    const doneAfter = byKey(gettingStartedSteps(facts({ admin: true, hasLogo: true, companySkipped: ["logo"] })));
    ok("done wins over a skip: a logo added after skipping is done, not skipped", doneAfter.logo!.done && !doneAfter.logo!.skipped && doneAfter.logo!.finished);
    const half = progressOf(gettingStartedSteps(facts({ personalSkipped: ["photo"] })));
    ok("progress counts what is finished", half.done === 1 && half.total === 2 && half.percent === 50, json(half));
    const everything = gettingStartedSteps(facts({ admin: true, helpManager: true, organisationReady: true, activeUsers: 3, itemCount: 1, helplineSet: true, hasTwoFactor: true, companySkipped: ["logo"], personalSkipped: ["photo"] }));
    ok("everything done or skipped is all finished; the first unfinished is null", allFinished(everything) && firstUnfinished(everything) === null);
    ok("  otherwise the first unfinished is the first in order", firstUnfinished(owner)?.key === "organisation" && firstUnfinished(gettingStartedSteps(facts({ hasPhoto: true })))?.key === "two-factor");

    section("  the company profile's essentials");
    const india = { legalName: "Acme Technologies Pvt Ltd", gstin: "", addressLine1: "12 MG Road", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" };
    ok("complete in India with name, address, city, state and PIN — no GSTIN needed", profileComplete({ ...india }) && profileComplete({ ...india, country: "" }));
    ok("  without the state or the PIN, not", !profileComplete({ ...india, state: "" }) && !profileComplete({ ...india, pincode: null }));
    ok("  abroad, the state and PIN aren't needed", profileComplete({ ...india, country: "United Arab Emirates", state: "", pincode: "" }));
    const issues = companyProfileIssues({ legalName: "", gstin: "27AAB", addressLine1: "", city: "", state: "", pincode: "41100", country: "India" });
    ok("every field's problem at once, each saying why", json(Object.keys(issues).sort()) === json(["addressLine1", "city", "gstin", "legalName", "pincode", "state"]), json(issues));
    ok("  a short GSTIN: 'A GSTIN is 15 characters — this one has 5.'", issues.gstin === "A GSTIN is 15 characters — this one has 5.", issues.gstin);
    ok("  a short PIN: 'A PIN code is 6 digits — this one has 5.'", issues.pincode === "A PIN code is 6 digits — this one has 5.", issues.pincode);
    ok("  a GSTIN with a wrong last character is caught, the right one passes", /doesn't check out/.test(companyProfileProblem("gstin", { ...india, gstin: "27AAPFU0939F1ZW" }) ?? "") && companyProfileProblem("gstin", { ...india, gstin: "27AAPFU0939F1ZV" }) === null);
    ok("  abroad, a GSTIN is never asked about", companyProfileProblem("gstin", { ...india, country: "Singapore", gstin: "nonsense" }) === null);

    section("  the wizard's small forms");
    ok("a SKU is made from the name", skuFrom("Annual support plan") === "ANNUAL-SUPPORT-PLAN" && skuFrom("  ms 365 / basic ") === "MS-365-BASIC");
    const item = itemIssues({ ...EMPTY_ITEM, name: "A", price: "₹500" });
    ok("an item: the name, the SKU and the price, each with its reason", item.name === "A name needs at least 2 characters." && /SKU/.test(item.sku ?? "") && /no currency sign/.test(item.price ?? ""), json(item));
    ok("  a good one has none", json(itemIssues({ ...EMPTY_ITEM, name: "Annual support", sku: "ANNUAL-SUPPORT", price: "4999", tax: "18" })) === "{}");
    const help = helpIssues({ ...EMPTY_HELP, title: "", url: "http://example.com/guide" });
    ok("a help link: a title, and https only", /title/.test(help.title ?? "") && help.url === "Only https:// links are allowed.", json(help));
  });

  // ─── B ─────────────────────────────────────────────────────────────────────────────────────────
  await part("B. The dashboard's tabs, and when the wizard opens", async () => {
    ok("while being onboarded: Getting Started · Dashboard · Recent Updates", json(dashboardTabKeys(true)) === json(["getting-started", "overview", "updates"]));
    ok("after: Dashboard · Recent Updates — Getting Started gone", json(dashboardTabKeys(false)) === json(["overview", "updates"]));
    ok("/dashboard with no ?tab opens Getting Started while it is there", resolveDashboardTab(undefined, dashboardTabKeys(true)) === "getting-started" && resolveDashboardTab("overview", dashboardTabKeys(true)) === "overview");
    ok("?tab=getting-started afterwards falls back to the dashboard; nonsense to the first tab", resolveDashboardTab("getting-started", dashboardTabKeys(false)) === "overview" && resolveDashboardTab("../etc", dashboardTabKeys(true)) === "getting-started");
    const fresh = { kind: "MEMBER", onboardingCompletedAt: null };
    const done = { kind: "MEMBER", onboardingCompletedAt: new Date() };
    ok("pending: a person (MEMBER) not yet finished — never platform support or the Automation account", onboardingPending(fresh) && !onboardingPending(done) && !onboardingPending({ kind: "SUPPORT", onboardingCompletedAt: null }) && !onboardingPending({ kind: "AUTOMATION", onboardingCompletedAt: null }) && !onboardingPending(null));
    ok("the wizard is there, and opens by itself, for a new person signed in as themselves", wizardMounted({ person: fresh, viewingAs: false, forcedSetup: false }) && wizardAutoOpens({ person: fresh, viewingAs: false, forcedSetup: false }));
    ok("  never for somebody finished", !wizardMounted({ person: done, viewingAs: false, forcedSetup: false }));
    ok("  never while viewing as somebody", !wizardMounted({ person: fresh, viewingAs: true, forcedSetup: false }));
    ok("  never for SUPPORT or AUTOMATION", !wizardMounted({ person: { kind: "SUPPORT", onboardingCompletedAt: null }, viewingAs: false, forcedSetup: false }) && !wizardMounted({ person: { kind: "AUTOMATION", onboardingCompletedAt: null }, viewingAs: false, forcedSetup: false }));
    ok("  over a forced password or two-factor form: there for 'Continue setup', but not opening by itself", wizardMounted({ person: fresh, viewingAs: false, forcedSetup: true }) && !wizardAutoOpens({ person: fresh, viewingAs: false, forcedSetup: true }));
    ok("once per sign-in: the browser remembers by a key for that sign-in", autoOpenedKey("abc123") === "onboarding.autoOpened.abc123");
    const layout = readFileSync(path.join(process.cwd(), "src", "app", "(dashboard)", "layout.tsx"), "utf8");
    ok("the workspace layout mounts it by those rules, keyed by a hash of the sign-in", /wizardMounted\(onboardingGate\)/.test(layout) && /wizardAutoOpens\(onboardingGate\)/.test(layout) && /viewingAs: !!viewAs/.test(layout) && /createHash\("sha256"\)/.test(layout) && /<OnboardingWizard /.test(layout));
    const wizard = readFileSync(path.join(process.cwd(), "src", "components", "onboarding", "onboarding-wizard.tsx"), "utf8");
    ok("  the wizard asks sessionStorage before opening by itself, and listens for 'Continue setup'", /sessionStorage\.getItem\(key\)/.test(wizard) && /addEventListener\(OPEN_ONBOARDING_EVENT/.test(wizard));
  });

  // ─── C ─────────────────────────────────────────────────────────────────────────────────────────
  await part("C. Signup: every problem at once, each saying why", async () => {
    const bad = { companyName: "", slug: "", ownerName: "A", email: "asha.acme.com", password: "short123", country: "", invite: "" };
    const local = simpleSignupIssues(bad, { inviteRequired: true, countryKnown: (c) => c === "IN" });
    ok("the browser's own checks: seven bad fields, seven messages", json(Object.keys(local).sort()) === json(["companyName", "country", "email", "invite", "ownerName", "password", "slug"]), json(local));
    ok("  the password says how short: 'At least 10 characters — this one has 8.'", local.password === "At least 10 characters — this one has 8.", local.password);
    ok("  the email says what's missing: an @", local.email === "An email address needs an @ — like name@yourcompany.com.", local.email);
    ok("  the first to fix is the business name", firstIssue(local) === "companyName");
    ok("email shapes, each its own reason", emailShapeProblem("asha@acme") === '"acme" is missing its ending, like .com or .in.' && /spaces/.test(emailShapeProblem("asha @acme.com") ?? "") && /just one @/.test(emailShapeProblem("a@@acme.com") ?? "") && /before the @/.test(emailShapeProblem("@acme.com") ?? "") && /after the @/.test(emailShapeProblem("asha@") ?? "") && emailShapeProblem("asha@acme.com") === null);
    ok("code shapes", codeShapeProblem("12") === "The code is 6 digits — this one has 2." && /digits only/.test(codeShapeProblem("12ab56") ?? "") && codeShapeProblem("123 456") === null);
    ok("a wrong code counts down, then says it was the last", /4 tries left/.test(wrongCodeMessage(4)) && /1 try left/.test(wrongCodeMessage(1)) && /last try/.test(wrongCodeMessage(0)));

    const { controlConfigured, controlDb } = load("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    if (!controlConfigured()) {
      ok("the control plane is configured, for signup's own checks", false);
      return;
    }
    const control = controlDb();
    const signup = load("../src/actions/platform/signup") as typeof import("../src/actions/platform/signup");
    const settings = load("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const mailer = load("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const { resetLockouts } = load("../src/lib/security/lockout") as typeof import("../src/lib/security/lockout");
    const { NAME_RESERVED } = load("../src/lib/workspace-names") as typeof import("../src/lib/workspace-names");
    const mail: { to: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));
    const open = await settings.signupOpen();
    const pendingBefore = await control.pendingSignup.count({ where: { email: { contains: "zzonb" } } });

    resetLockouts();
    const many = await signup.startSignup({ companyName: "", slug: "admin", ownerName: "Z", email: "zzonb@mailinator.com", password: "12345678", country: "XX", invite: "zzonb-not-a-code", referral: "zzonb-no-such-partner" });
    const issues = many.ok ? {} : (many.issues ?? {});
    ok("startSignup names every bad field at once", !many.ok && json(Object.keys(issues).sort()) === json(["companyName", "country", "email", "invite", "ownerName", "password", "referral", "slug"]), json(many));
    ok("  a throwaway address, by name: 'throwaway addresses like mailinator.com can't own a workspace'", issues.email === "Use your work address — throwaway addresses like mailinator.com can't own a workspace.", issues.email);
    ok("  the password's length: 'this one has 8'", issues.password === "At least 10 characters — this one has 8.", issues.password);
    ok("  the address in the name rules' own words", issues.slug === NAME_RESERVED, issues.slug);
    ok("  the invitation and partner codes in the words they always had", /That invitation code isn't valid/.test(issues.invite ?? "") && issues.referral === "That partner code isn't valid — clear it to sign up without one.", json([issues.invite, issues.referral]));
    ok("  `error` is still the first problem, for anything that reads one line", !many.ok && many.error === issues.companyName && !many.formError);

    resetLockouts();
    const noInvite = await signup.startSignup({ companyName: "Zzonb Trading Pvt Ltd", slug: "zzonbtrading", ownerName: "Zz Onb", email: "zzonb-noinvite@zzonb.example", password: "1234", country: "IN", invite: "" });
    ok(
      open ? "signup is open: no code needed, so only the password is wrong" : "by invitation only, with no code: said for the whole form, not as one field's",
      !noInvite.ok && (open ? !noInvite.formError && json(Object.keys(noInvite.issues ?? {})) === json(["password"]) : /by invitation/.test(noInvite.formError ?? "") && noInvite.error === noInvite.formError),
      json(noInvite),
    );

    // Nothing new is given away: an address that owns a workspace reads exactly as one that doesn't.
    const owned = await control.tenant.findFirst({ where: { ownerEmail: { not: null } }, select: { ownerEmail: true } });
    if (owned?.ownerEmail) {
      const form = (email: string) => ({ companyName: "", slug: "", ownerName: "", email, password: "x", country: "IN", invite: "zzonb-not-a-code" });
      resetLockouts();
      const a = await signup.startSignup(form(owned.ownerEmail));
      resetLockouts();
      const b = await signup.startSignup(form("zzonb-nobody@zzonb.example"));
      const strip = (r: typeof a) => json(r.ok ? r : { ...r, issues: { ...r.issues, email: undefined } });
      ok("an address that owns a workspace gets the same answer as one that doesn't", strip(a) === strip(b) && !(a.ok ? null : a.issues?.email) && !(b.ok ? null : b.issues?.email), `${strip(a)} / ${strip(b)}`);
      ok("  and the answer carries nothing but the messages", !a.ok && Object.keys(a).every((k) => ["ok", "error", "issues", "formError"].includes(k)));
    } else {
      ok("(no workspace has an owner's address on record — the comparison is skipped)", true);
    }
    ok("refused forms leave nothing behind: no pending signup, no mail", (await control.pendingSignup.count({ where: { email: { contains: "zzonb" } } })) === pendingBefore && mail.length === 0, `${mail.length} mail`);

    section("  the code");
    const secret = randomBytes(18).toString("base64url");
    const code = "135790";
    const row = await control.pendingSignup.create({
      data: {
        email: "zzonb-code@zzonb.example",
        ownerName: "Zz Onb",
        companyName: "Zzonb Code Check Ltd",
        slug: "zzonbcodecheck",
        country: "IN",
        passwordHash: "",
        codeHash: sha256(code),
        codeExpiresAt: new Date(Date.now() + 15 * 60_000),
        browserSecretHash: sha256(secret),
      },
      select: { id: true },
    });
    pendingSignupId = row.id;
    jar.set("deskzo.signup", `${row.id}.${secret}`);
    const attempts = async () => (await control.pendingSignup.findUniqueOrThrow({ where: { id: row.id } })).attempts;
    const short = await signup.verifySignup("12");
    ok("two digits: said at the code field, and it costs no try", !short.ok && short.issues?.code === "The code is 6 digits — this one has 2." && (await attempts()) === 0, json(short));
    const wrong = await signup.verifySignup("246801");
    ok("a wrong code: said at the code field, with the tries left", !wrong.ok && wrong.issues?.code === wrongCodeMessage(4) && (await attempts()) === 1, json(wrong));
    await control.pendingSignup.update({ where: { id: row.id }, data: { attempts: 4 } });
    const last = await signup.verifySignup("246801");
    ok("  the fifth: 'it was the last try'", !last.ok && /last try/.test(last.issues?.code ?? "") && (await attempts()) === 5, json(last));
    const after = await signup.verifySignup(code);
    ok("  then even the right code no longer works, and the field says so", !after.ok && after.issues?.code === CODE_ATTEMPTS_USED, json(after));
    await control.pendingSignup.update({ where: { id: row.id }, data: { attempts: 0, codeExpiresAt: new Date(Date.now() - 60_000) } });
    const expired = await signup.verifySignup(code);
    ok("an expired code: 'codes work for 15 minutes', at the field", !expired.ok && expired.issues?.code === CODE_EXPIRED && /15 minutes/.test(CODE_EXPIRED), json(expired));
    jar.clear();
    const gone = await signup.verifySignup(code);
    ok("another browser: the signup has expired, for the whole form", !gone.ok && /start again/.test(gone.formError ?? "") && !gone.issues?.code, json(gone));
    ok("nothing was verified or provisioned", !(await control.pendingSignup.findUniqueOrThrow({ where: { id: row.id } })).verifiedAt && (await control.tenant.count({ where: { slug: "zzonbcodecheck" } })) === 0);
    await control.pendingSignup.delete({ where: { id: row.id } });
    pendingSignupId = null;
    mailer.setTestPlatformMailer(null);
  });

  // ─── D ─────────────────────────────────────────────────────────────────────────────────────────
  await cleanup();
  const orgRow = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { onboardingSkipped: true } });
  orgBefore = { exists: !!orgRow, skipped: orgRow?.onboardingSkipped ?? [] };
  const mk = (name: string, data: Record<string, unknown> = {}) =>
    db.user.create({ data: { name: `${TAG} ${name}`, email: `zzonb-${name.toLowerCase()}${MAIL}`, role: "SALES", passwordHash: "x".repeat(60), ...data }, select: { id: true, name: true, email: true, role: true } });
  const as = (u: Actor) => {
    actor = { id: u.id, name: u.name, email: u.email, role: u.role };
    viewingAs = false;
  };

  const onb = load("../src/actions/onboarding") as typeof import("../src/actions/onboarding");
  const { gettingStartedFor } = load("../src/lib/help/onboarding-facts") as typeof import("../src/lib/help/onboarding-facts");
  const React = load("react") as typeof import("react");
  const { renderToStaticMarkup } = load("react-dom/server") as typeof import("react-dom/server");
  const render = (el: unknown) => renderToStaticMarkup(el as ReactElement);
  type Page = (p: { searchParams: Promise<{ tab?: string }> }) => Promise<unknown>;
  const Dashboard = (load("../src/app/(dashboard)/dashboard/page") as { default: Page }).default;
  const navOf = (html: string) => html.match(/<nav aria-label="Dashboard"[\s\S]*?<\/nav>/)?.[0] ?? "";
  const current = (html: string) => navOf(html).match(/aria-current="page"[^>]*>([^<]+)/)?.[1] ?? "";

  try {
    const owner = await mk("Owner", { role: "ADMIN" });
    const member = await mk("Member");
    const newcomer = await mk("Newcomer");
    const finished = await mk("Finished", { onboardingCompletedAt: new Date() });
    const support = await mk("Support", { kind: "SUPPORT" });

    await part("D1. Refusals, skips and completion", async () => {
      as(member);
      const required = await onb.skipStep("organisation");
      ok("skipping the company profile is refused, saying why", !required.ok && required.error === "The company profile can't be skipped — every quote and invoice prints it.", json(required));
      const twoFactor = await onb.skipStep("two-factor");
      ok("skipping two-factor is refused, saying why", !twoFactor.ok && /can't be skipped/.test(twoFactor.error), json(twoFactor));
      const company = await onb.skipStep("logo");
      ok("a company step without settings.manage is refused", !company.ok && company.error === "Only somebody who can change the company's settings can skip a company step.", json(company));
      ok("a step that doesn't exist is refused", !(await onb.skipStep("everything")).ok);
      const early = await onb.completeOnboarding();
      ok("finishing early is refused, naming what is left", !early.ok && early.error === "Not finished yet: Add your photo; Turn on two-factor sign-in.", json(early));
      ok("  and nothing is marked", !(await db.user.findUniqueOrThrow({ where: { id: member.id } })).onboardingCompletedAt);

      const skipped = await onb.skipStep("photo");
      const mine = await db.user.findUniqueOrThrow({ where: { id: member.id }, select: { onboardingSkipped: true } });
      ok("skipping their photo: remembered on their account, and it counts as finished", skipped.ok && json(mine.onboardingSkipped) === json(["photo"]) && !!skipped.data.steps.find((s) => s.key === "photo" && s.skipped && s.finished));
      const audits = () => db.auditLog.count({ where: { userId: member.id, entityLabel: { startsWith: "Getting started" } } });
      ok("  audited", (await audits()) === 1);
      await onb.skipStep("photo");
      ok("  skipping it again changes nothing", json((await db.user.findUniqueOrThrow({ where: { id: member.id } })).onboardingSkipped) === json(["photo"]) && (await audits()) === 1);
      const undone = await onb.unskipStep("photo");
      ok("'do it now' puts it back to do, audited", undone.ok && !!undone.data.steps.find((s) => s.key === "photo" && !s.finished) && (await audits()) === 2);
      await onb.skipStep("photo");
      ok("still refused with two-factor not done", !(await onb.completeOnboarding()).ok);

      await db.user.update({ where: { id: member.id }, data: { twoFactorEnabledAt: new Date() } });
      const done = await onb.completeOnboarding();
      const marked = (await db.user.findUniqueOrThrow({ where: { id: member.id } })).onboardingCompletedAt;
      ok("with every step finished, completion sets the flag", done.ok && !!marked && done.data.completedAt === marked.toISOString(), json(done));
      const again = await onb.completeOnboarding();
      const still = (await db.user.findUniqueOrThrow({ where: { id: member.id } })).onboardingCompletedAt;
      ok("  once: a second call changes nothing", again.ok && still?.getTime() === marked?.getTime() && (await db.auditLog.count({ where: { userId: member.id, entityLabel: "Getting started finished" } })) === 1);
      ok("  and a skip afterwards is refused", !(await onb.skipStep("photo")).ok);

      as(owner);
      const ownerFacts = await gettingStartedFor(owner.id);
      const logoBefore = ownerFacts.steps.find((s) => s.key === "logo")!;
      const companySkip = await onb.skipStep("logo");
      const orgSkips = (await db.organisationSettings.findUnique({ where: { id: "global" }, select: { onboardingSkipped: true } }))?.onboardingSkipped ?? [];
      ok("the owner may skip a company step; it counts as finished", companySkip.ok && !!companySkip.data.steps.find((s) => s.key === "logo" && s.finished));
      ok(
        logoBefore.done ? "  (the logo was already there, so there was nothing to skip)" : "  remembered for the company, and audited as the company's",
        logoBefore.done || (orgSkips.includes("logo") && (await db.auditLog.count({ where: { userId: owner.id, entityType: "OrganisationSettings", entityLabel: { contains: "for the company" } } })) === 1),
        json(orgSkips),
      );
      const second = await mk("Second-admin", { role: "ADMIN" });
      ok("  for everybody: another admin's logo step is finished without them skipping it", !!(await gettingStartedFor(second.id)).steps.find((s) => s.key === "logo" && s.finished));
      const left = ownerFacts.steps.filter((s) => !s.finished && s.key !== "logo");
      const ownerEarly = await onb.completeOnboarding();
      ok("the owner can't finish with steps left", !ownerEarly.ok && left.every((s) => ownerEarly.error.includes(s.title)), json([ownerEarly, left.map((s) => s.key)]));
      const profile = await onb.saveCompanyProfile({ legalName: "", gstin: "27AAB", addressLine1: "", city: "", state: "", pincode: "4110", country: "India" });
      ok("the profile step refuses bad fields one by one, before anything is saved", !profile.ok && json(Object.keys(profile.issues ?? {}).sort()) === json(["addressLine1", "city", "gstin", "legalName", "pincode", "state"]), json(profile));
      as(newcomer);
      ok("  and somebody without settings.manage can't use it at all", (await onb.saveCompanyProfile({ legalName: "x", gstin: "", addressLine1: "x", city: "x", state: "Goa", pincode: "403001", country: "India" })).ok === false);

      viewingAs = true;
      ok("viewing as somebody: no wizard state, and every change refused", (await onb.onboardingState()) === null && (await onb.skipStep("photo")).ok === false && (await onb.completeOnboarding()).ok === false);
      viewingAs = false;
      as(support);
      ok("platform support has no onboarding: no state, no completion", (await onb.onboardingState()) === null && !(await onb.completeOnboarding()).ok);
      as(newcomer);
      const state = await onb.onboardingState();
      ok("a new member's wizard: pending, their own two steps, nothing of the company's", !!state?.pending && keysOf(state.steps) === "photo,two-factor" && state.profile === null && state.team === null, json(state?.steps.map((s) => s.key)));
    });

    await part("D2. The dashboard's tabs, before and after", async () => {
      as(newcomer);
      const before = render(await Dashboard({ searchParams: Promise.resolve({}) }));
      const nav = navOf(before);
      ok("before: Getting Started is the first tab and opens by default", current(before) === "Getting Started" && nav.indexOf("Getting Started") < nav.indexOf(">Dashboard<") && nav.indexOf(">Dashboard<") < nav.indexOf("Recent Updates"), nav.slice(0, 300));
      ok("  it links from /dashboard itself; Dashboard moves to ?tab=overview", /href="\/dashboard"[^>]*>Getting Started/.test(nav) && nav.includes('href="/dashboard?tab=overview"'));
      ok("  with 'Continue setup' beside the list", before.includes("Continue setup") && before.includes('role="progressbar"'));
      saveRender("getting-started-before.html", before);
      await onb.skipStep("photo");
      const skippedHtml = render(await Dashboard({ searchParams: Promise.resolve({ tab: "getting-started" }) }));
      ok("a skipped step says so, with where to do it", skippedHtml.includes("Skipped — do it any time from") && /href="\/profile"[^>]*>My profile/.test(skippedHtml));
      saveRender("getting-started-skipped.html", skippedHtml);
      viewingAs = true;
      ok("  viewing as them: their tab, but no 'Continue setup' — there is no wizard", !render(await Dashboard({ searchParams: Promise.resolve({}) })).includes("Continue setup"));
      viewingAs = false;

      as(finished);
      const after = render(await Dashboard({ searchParams: Promise.resolve({}) }));
      ok("after: Dashboard first, Getting Started gone", current(after) === "Dashboard" && !navOf(after).includes("Getting Started"), navOf(after).slice(0, 300));
      const stale = render(await Dashboard({ searchParams: Promise.resolve({ tab: "getting-started" }) }));
      ok("  ?tab=getting-started falls back to the dashboard", current(stale) === "Dashboard" && !stale.includes("Continue setup"));
      saveRender("getting-started-after.html", after);
    });

    await part("D3. When the wizard opens, on real rows", async () => {
      const row = (id: string) => db.user.findUniqueOrThrow({ where: { id }, select: { kind: true, onboardingCompletedAt: true } });
      const gate = async (id: string, extra: { viewingAs?: boolean; forcedSetup?: boolean } = {}) => ({ person: await row(id), viewingAs: !!extra.viewingAs, forcedSetup: !!extra.forcedSetup });
      ok("a new user: the wizard opens by itself", wizardAutoOpens(await gate(newcomer.id)));
      ok("a finished user: no wizard", !wizardMounted(await gate(finished.id)) && !wizardMounted(await gate(member.id)));
      ok("viewing as a new user: no wizard", !wizardMounted(await gate(newcomer.id, { viewingAs: true })));
      ok("platform support: no wizard", !wizardMounted(await gate(support.id)));
      const automation = await db.user.findFirst({ where: { kind: "AUTOMATION" }, select: { id: true } });
      ok(automation ? "the Automation account: no wizard" : "(no Automation account here — covered by B)", !automation || !wizardMounted(await gate(automation.id)));
      const [migration] = await db.$queryRaw<{ finished_at: Date | null }[]>`SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = '20261001100000_onboarding_wizard'`;
      ok("the onboarding migration is applied here", !!migration?.finished_at);
      if (migration?.finished_at) {
        const [{ n, total }] = await db.$queryRaw<{ n: number; total: number }[]>`
          SELECT count(*) FILTER (WHERE "onboardingCompletedAt" IS NULL)::int AS n, count(*)::int AS total
          FROM "users" WHERE "kind" = 'MEMBER' AND "createdAt" < ${migration.finished_at}`;
        ok(`everybody here before it (${total}) was marked finished by its backfill — no wizard for them`, n === 0, `${n} of ${total} not marked`);
      }
    });

    await part("D4. A newly invited user starts not finished", async () => {
      as(owner);
      const mailer = load("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
      const sent: { to: string }[] = [];
      mailer.setTestPlatformMailer(async (m) => void sent.push(m));
      const users = load("../src/actions/user") as typeof import("../src/actions/user");
      const invitedEmail = `zzonb-invited${MAIL}`;
      const created = await users.createUser({ name: `${TAG} Invited`, email: invitedEmail, role: "SALES", departmentId: "" });
      mailer.setTestPlatformMailer(null);
      const invited = await db.user.findUnique({ where: { email: invitedEmail }, select: { id: true, name: true, email: true, role: true, onboardingCompletedAt: true, onboardingSkipped: true } });
      ok("the invite (createUser) makes the account, and sends the setup link — no password set here", created.ok && !!invited && sent.some((m) => m.to === invitedEmail), json(created));
      ok("  and it starts not finished: onboardingCompletedAt null, nothing skipped", !!invited && invited.onboardingCompletedAt === null && invited.onboardingSkipped.length === 0);
      if (invited) {
        as(invited);
        const state = await onb.onboardingState();
        ok("  so their own short wizard waits for them", !!state?.pending && keysOf(state.steps) === "photo,two-factor");
      }
      const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
      const creators = ["src/actions/user.ts", "src/actions/candidate.ts", "src/lib/platform/bootstrap-owner.ts", "src/lib/platform/support.ts", "src/lib/portability/importers/users.ts", "src/lib/automation-user.ts", "prisma/seed.ts"];
      const setting = creators.filter((f) => /onboardingCompletedAt/.test(src(f)));
      ok("no path that makes an account sets it — invite, candidate, owner, support, import, automation, seed", setting.length === 0, setting.join(", "));
    });

    // ─── E ───────────────────────────────────────────────────────────────────────────────────────
    await part("E. Renders", async () => {
      const { SignupFlow, SignupLoader } = load("../src/components/platform/signup-flow") as typeof import("../src/components/platform/signup-flow");
      const countries = [{ code: "IN", name: "India" }, { code: "AE", name: "United Arab Emirates" }];
      const form = render(React.createElement(SignupFlow, { suffix: ".localhost:3000", countries, inviteRequired: true, brandName: "Deskzo One" }));
      ok("the signup form: every field labelled, with room for its own error", ["company", "slug", "owner", "email", "password", "country", "invite"].every((id) => form.includes(`for="${id}"`) && form.includes(`id="${id}"`)) && /novalidate=""/i.test(form));
      saveRender("signup-form.html", form);
      const loading = render(React.createElement(SignupLoader, { brandName: "Deskzo One", status: "Preparing your database…", large: true }, React.createElement("p", null, "Setting up your workspace")));
      ok("the loading stage: the brand's mark floating, its shadow breathing, a polite status line", loading.includes("animate-float") && loading.includes("animate-float-shadow") && />D<\/span>/.test(loading) && /role="status" aria-live="polite"[^>]*>Preparing your database…/.test(loading));
      saveRender("signup-loading.html", loading);
      const css = readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
      ok("  @keyframes float: ~7px over 2.4s, ease-in-out, forever — and still with reduced motion", /@keyframes float \{[\s\S]*?translateY\(-7px\)/.test(css) && /\.animate-float \{\s*animation: float 2\.4s ease-in-out infinite;/.test(css) && /prefers-reduced-motion: reduce\)[\s\S]*?\.animate-float,\s*\.animate-float-shadow \{\s*animation: none !important;/.test(css));

      // The wizard, as a new owner would see it: real state from the server, opened at a step.
      const fresh = await mk("Fresh-owner", { role: "ADMIN" });
      as(fresh);
      const state = await onb.onboardingState();
      if (!state) {
        ok("the wizard's state loads for a new owner", false);
        return;
      }
      const { OnboardingWizard } = load("../src/components/onboarding/onboarding-wizard") as typeof import("../src/components/onboarding/onboarding-wizard");
      // The dialog names <body> as where it portals to; the portal itself is replaced above.
      const g = globalThis as { document?: unknown };
      const wizardAt = (place: (typeof state.steps)[number]["key"] | "done") => {
        g.document = { body: null };
        try {
          return render(React.createElement(OnboardingWizard, { autoOpen: false, signInKey: "check", preview: { state, place } }));
        } finally {
          delete g.document;
        }
      };
      const firstKey = state.steps[0]!.key;
      const middle = state.steps[Math.floor(state.steps.length / 2)]!.key;
      const lastKey = state.steps[state.steps.length - 1]!.key;
      const first = wizardAt(firstKey);
      ok("the wizard opens as a dialog titled Getting started, with every step listed", first.includes('role="dialog"') && first.includes(">Getting started<") && state.steps.every((s) => first.includes(`id="onb-step-${s.key}"`)));
      ok("  the current step is marked aria-current=step, the others hidden", /<li aria-current="step"[^>]*>/.test(first) && (first.match(/<section hidden=""/g) ?? []).length === state.steps.length);
      ok("  the first step is the company profile, required — with its form embedded", firstKey === "organisation" && first.includes(state.steps[0]!.done ? ">Done<" : ">Required<") && first.includes('id="onb-legalName"') && first.includes('id="onb-gstin"'));
      ok("  Back, Finish later and Save and continue — no Skip on a required step", first.includes(">Finish later<") && first.includes(">Save and continue<") && !first.includes(">Skip for now<"));
      ok("  'Step 1 of N' for phones", first.includes(`Step 1 of ${state.steps.length}`));
      saveRender("wizard-first.html", first);
      const mid = wizardAt(middle);
      ok(`a middle step (${middle}) is optional: Skip for now is offered`, (mid.includes(">Optional<") && mid.includes(">Skip for now<")) || state.steps.find((s) => s.key === middle)!.finished, middle);
      saveRender("wizard-middle.html", mid);
      const lastHtml = wizardAt(lastKey);
      ok("the last step is two-factor: required, with the existing enrolment", lastKey === "two-factor" && lastHtml.includes(">Set up two-factor<") && !lastHtml.includes(">Skip for now<"));
      saveRender("wizard-last.html", lastHtml);
      const end = wizardAt("done");
      ok("the end: You're all set", end.includes("You&#x27;re all set") || end.includes("You're all set"));
      saveRender("wizard-done.html", end);
      for (const key of ["logo", "team", "items", "helpline", "photo"] as const) {
        if (state.steps.some((s) => s.key === key)) saveRender(`wizard-step-${key}.html`, wizardAt(key));
      }
    });
  } finally {
    actor = null;
    viewingAs = false;
    await cleanup().catch((err) => ok("cleanup", false, String(err)));
    if (pendingSignupId) {
      const { controlDb } = load("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
      await controlDb().pendingSignup.deleteMany({ where: { id: pendingSignupId } }).catch(() => {});
    }
    const leftOver = await db.user.count({ where: { email: { endsWith: MAIL } } });
    const orgAfter = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { onboardingSkipped: true } });
    ok("cleanup: no probe left, and the organisation's skips are as they were found", leftOver === 0 && (orgBefore?.exists ? json(orgAfter?.onboardingSkipped) === json(orgBefore.skipped) : orgAfter === null), json({ leftOver, orgAfter, orgBefore }));
  }

  const { closeControlDb } = load("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
  await closeControlDb().catch(() => {});
  console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed.` : `\nAll ${passes} onboarding checks passed.`);
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
