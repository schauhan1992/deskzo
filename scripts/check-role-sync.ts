/**
 * A role changed while somebody is signed in shows, and counts, on their next page — no sign-out.
 *
 * The session token is written at sign-in, so the role in it is the one somebody had then. Vishal was
 * moved from Sales to HR head: his profile said HR_HEAD, the header under his name still said Sales,
 * and every check written against the session's role went on treating him as Sales. `auth()` now reads
 * the person from this workspace's database on each request; this suite holds a token that still says
 * SALES and checks what the app makes of it.
 *
 * NextAuth itself is replaced by a stub that returns that stale token, so the real `auth()`,
 * `requireUser()`, profile page and dashboard layout are what is under test. The request is on the
 * installation's own address (TENANCY_LEGACY_HOSTS), like every other suite here.
 *
 *   npm run check:role-sync
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

const MAIL = "@zzprobe-rolesync.invalid";
/** What the stubbed NextAuth hands back: the token as written at sign-in. */
let token: { id: string; name: string; email: string; role: string; tid?: string } | null = null;

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next-auth") {
    const NextAuth = () => ({ handlers: {}, signIn: async () => {}, signOut: async () => {}, auth: async () => (token ? { user: { ...token }, expires: "2099-01-01" } : null) });
    return { __esModule: true, default: NextAuth };
  }
  if (request === "next/headers") {
    return {
      headers: async () => new Headers({ host: "localhost:3000" }),
      cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [], has: () => false }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
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
      usePathname: () => "/dashboard",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await db.signIn.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { auth } = require("../src/lib/auth") as typeof import("../src/lib/auth");
  const { requireUser } = require("../src/lib/session") as typeof import("../src/lib/session");
  const { currentTenantOrNull } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { accessContextFor } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const { default: ProfilePage } = require("../src/app/(dashboard)/profile/page") as { default: (p: unknown) => Promise<unknown> };
  const { default: DashboardLayout } = require("../src/app/(dashboard)/layout") as { default: (p: { children: unknown }) => Promise<unknown> };
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tenant = await currentTenantOrNull();
  if (!tenant) throw new Error("No workspace on localhost:3000 — this suite runs on the installation's own address.");

  await cleanup();
  try {
    section("The fixture");
    const vishal = await db.user.create({ data: { name: "Zzprobe Vishal", email: `vishal${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    // Signed in as Sales: the token says SALES, and keeps saying it.
    token = { id: vishal.id, name: "Zzprobe Vishal", email: vishal.email, role: "SALES", tid: tenant.id };
    ok("Vishal signs in as Sales", (await auth())?.user.role === "SALES");

    section("Moved to HR head while signed in");
    await db.user.update({ where: { id: vishal.id }, data: { role: "HR_HEAD", name: "Zzprobe Vishal Kumar" } });
    const session = await auth();
    ok("the session now says HR_HEAD, though the token still says SALES", session?.user.role === "HR_HEAD" && token.role === "SALES", session?.user.role);
    ok("  and the name follows the record too", session?.user.name === "Zzprobe Vishal Kumar", session?.user.name);
    ok("  so does every action's requireUser()", (await requireUser()).role === "HR_HEAD");

    const profile = text(await renderHtml(ProfilePage({ searchParams: Promise.resolve({}), params: Promise.resolve({}) })));
    ok("the profile page shows the role by its name, HR head", profile.includes("HR head") && !profile.includes("HR_HEAD"));
    const header = text(await renderHtml(DashboardLayout({ children: null })));
    ok("the header under his name shows HR head", /Zzprobe Vishal Kumar\s+HR head/.test(header), header.match(/Zzprobe Vishal Kumar\s+\S+(\s+\S+)?/)?.[0]);
    ok("  and nowhere Sales", !/Zzprobe Vishal Kumar\s+Sales/.test(header));

    const access = await accessContextFor(vishal.id);
    ok("his menu is HR head's: People and Payroll, no Sales", access.openModules.includes("hr") && access.openModules.includes("payroll") && !access.openModules.includes("companies"), access.openModules.join(","));

    section("Back again, and away");
    await db.user.update({ where: { id: vishal.id }, data: { role: "SALES" } });
    ok("moved back to Sales, the next request says so — nothing kept from before", (await auth())?.user.role === "SALES");
    token = { ...token, tid: "another-workspace" };
    ok("a token another workspace issued is no session here, whatever it says", (await auth()) === null);
    token = { id: "zzprobe-rolesync-another-workspaces-user", name: "Someone", email: `else${MAIL}`, role: "ADMIN", tid: tenant.id };
    ok("nor is one naming somebody this workspace doesn't have — no ADMIN on the token's say-so", (await auth()) === null);
    token = { id: vishal.id, name: "Zzprobe Vishal", email: vishal.email, role: "SALES", tid: tenant.id };
    await db.user.delete({ where: { id: vishal.id } });
    ok("an account deleted while signed in ends the session", (await auth()) === null);
  } finally {
    token = null;
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll role sync checks passed." : `\n${failures} role sync check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
