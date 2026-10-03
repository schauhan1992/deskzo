/**
 * Maintenance mode — src/lib/maintenance.ts.
 *
 *   · Without a database: what a row means (off, scheduled, on, ended), when a scheduled window is
 *     announced, the page people see (their message escaped, the end in India time, the way back),
 *     and who the proxy holds — nobody while it is off; while it is on, everybody but those allowed
 *     through, with sign-in and unsubscribe links left open.
 *   · Through the real code: who may bypass it (settings.manage, cached); who may change it; every
 *     refusal; scheduling a window in India time, audited; the settings page, the banner and the
 *     status endpoint.
 *
 * It never switches maintenance on in the database — that would hold everybody using this server at
 * the maintenance page. It saves only windows a month away and puts back whatever was there before.
 *
 *   npm run check:maintenance
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import { announced, maintenancePage, maintenanceState, DEFAULT_MESSAGE, type MaintenanceState } from "../src/lib/maintenance-state";
// Times on the workspace's clock, which is India's here.
import { indiaClock } from "../src/lib/time/zone";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "ADMIN", name: "Zzmaint", email: `x${MAIL}` });
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
      usePathname: () => "/settings/maintenance",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zzprobe-maintenance.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("What a row means");

  const now = new Date("2026-10-01T10:00:00+05:30");
  const at = (h: number) => new Date(now.getTime() + h * 3_600_000);
  const row = (over: Partial<{ enabled: boolean; startsAt: Date | null; endsAt: Date | null; message: string | null }>) => ({
    enabled: true,
    startsAt: null,
    endsAt: null,
    message: null,
    ...over,
  });
  ok("no row is off", maintenanceState(null, now).phase === "off");
  ok("switched off is off, whatever times are left on it", maintenanceState(row({ enabled: false, startsAt: at(-1), endsAt: at(1) }), now).phase === "off");
  ok("switched on with no start is on", maintenanceState(row({}), now).phase === "on");
  ok("a start still to come is scheduled", maintenanceState(row({ startsAt: at(2) }), now).phase === "scheduled");
  ok("a start that has come is on", maintenanceState(row({ startsAt: at(-1), endsAt: at(1) }), now).phase === "on");
  ok("an end that has passed is over, without anybody switching it off", maintenanceState(row({ startsAt: at(-3), endsAt: at(-1) }), now).phase === "ended");
  ok("  exactly at the end it is over", maintenanceState(row({ endsAt: now }), now).phase === "ended");
  ok("an empty message is the default one", maintenanceState(row({ message: "   " }), now).message === DEFAULT_MESSAGE);
  ok("a scheduled window is announced from a day ahead", announced(maintenanceState(row({ startsAt: at(23) }), now), now) && !announced(maintenanceState(row({ startsAt: at(25) }), now), now));
  ok("  and not once it has started", !announced(maintenanceState(row({ startsAt: at(-1) }), now), now));

  // ─────────────────────────────────────────────────────────────────────────────
  section("The page people see");

  const onState = (over: Partial<MaintenanceState> = {}): MaintenanceState => ({ phase: "on", startsAt: null, endsAt: null, message: DEFAULT_MESSAGE, ...over });
  const html = maintenancePage(onState({ message: `Upgrading <script>alert("x")</script> & more`, endsAt: new Date("2026-10-01T18:30:00Z") }), indiaClock, "Acme <ERP>");
  ok("the message is shown as text, never as markup", html.includes("Upgrading &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more") && !html.includes("<script>alert"));
  ok("  and so is the app's name", html.includes("Acme &lt;ERP&gt; is down for maintenance"));
  ok("the end is in India time", /Expected back by <strong>Fri, 2 Oct 2026, 12:00 am<\/strong>/.test(html), html.match(/Expected back by <strong>[^<]+/)?.[0]);
  ok("  and not mentioned when there isn't one", !maintenancePage(onState(), indiaClock).includes("Expected back"));
  ok("it checks whether the app is back, and reloads when it is", html.includes("/api/maintenance/status") && html.includes("location.reload()"));
  ok("admins are shown the way in", html.includes('href="/login"'));
  ok("it isn't indexed", html.includes('name="robots" content="noindex"'));

  // ─────────────────────────────────────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-require-imports */
  const lib = require("../src/lib/maintenance") as typeof import("../src/lib/maintenance");
  section("Who is held");

  const allowed = async (id: string) => id === "admin";
  const verdict = (pathname: string, userId: string | null, state = onState()) => lib.maintenanceVerdict({ pathname, userId, state, mayBypass: allowed });
  ok("nobody while it is off", (await verdict("/dashboard", null, onState({ phase: "off" }))) === "serve" && (await verdict("/dashboard", "rep", onState({ phase: "scheduled" }))) === "serve");
  ok("while it is on, somebody signed in without the right is held", (await verdict("/dashboard", "rep")) === "hold");
  ok("  somebody with it carries on", (await verdict("/dashboard", "admin")) === "serve" && (await verdict("/companies/COM-000001", "admin")) === "serve");
  ok("  a visitor who isn't signed in is held", (await verdict("/", null)) === "hold");
  ok("the sign-in page stays open, so an admin can get in", (await verdict("/login", null)) === "serve" && (await verdict("/login/verify", null)) === "serve");
  ok("  but only the sign-in page — not something that starts with its name", (await verdict("/loginx", null)) === "hold");
  ok("unsubscribe and preference links keep working", (await verdict("/preferences/tok123", null)) === "serve" && (await verdict("/track/tok/c", null)) === "serve");
  ok("the customer portal and forms are held like everything else", (await verdict("/portal", null)) === "hold" && (await verdict("/forms/signup", null)) === "hold");

  await cleanup();
  const original = await db.maintenanceMode.findUnique({ where: { id: "global" } });
  try {
    const make = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzmaint ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: "ZZMAINT" })) },
        },
      });
    const admin = await make("Admin", { "settings.manage": true });
    const rep = await make("Rep", { "settings.manage": false });

    ok("the proxy lets through whoever can change settings", (await lib.mayBypassMaintenance(admin.id)) && !(await lib.mayBypassMaintenance(rep.id)));
    await db.userPermission.updateMany({ where: { userId: admin.id, permission: "settings.manage" }, data: { allowed: false } });
    ok("  remembered for a few seconds rather than asked on every request", await lib.mayBypassMaintenance(admin.id));
    lib.forgetMaintenanceCache();
    ok("  and asked again once forgotten", !(await lib.mayBypassMaintenance(admin.id)));
    await db.userPermission.updateMany({ where: { userId: admin.id, permission: "settings.manage" }, data: { allowed: true } });
    lib.forgetMaintenanceCache();

    // ───────────────────────────────────────────────────────────────────────────
    section("Who may change it, and what it refuses");

    const actions = require("../src/actions/maintenance") as typeof import("../src/actions/maintenance");
    actorId = rep.id;
    ok("somebody who can't change settings can't see it", (await actions.getMaintenanceSettings()) === null);
    ok("  nor change it", !(await actions.saveMaintenance({ mode: "off" })).ok);

    actorId = admin.id;
    const inHours = (h: number) => indiaClock.input(new Date(Date.now() + h * 3_600_000));
    const refused = async (input: Parameters<typeof actions.saveMaintenance>[0]) => {
      const r = await actions.saveMaintenance(input);
      return r.ok ? "SAVED" : r.error;
    };
    const before = await db.maintenanceMode.findUnique({ where: { id: "global" } });
    ok("a start that has passed", (await refused({ mode: "schedule", startsAt: inHours(-1) })).includes("has passed"));
    ok("a schedule with no start", (await refused({ mode: "schedule" })).includes("Pick when it starts"));
    ok("an end before the start", (await refused({ mode: "schedule", startsAt: inHours(720), endsAt: inHours(719) })).includes("end after it starts"));
    ok("  or, switching on now, an end already past", (await refused({ mode: "now", endsAt: inHours(-1) })).includes("end after it starts"));
    ok("an end that isn't a time", (await refused({ mode: "schedule", startsAt: inHours(720), endsAt: "soon" })).includes("isn't a date"));
    ok("a message too long to read at a glance", (await refused({ mode: "schedule", startsAt: inHours(720), message: "x".repeat(501) })).includes("under 500"));
    ok("a mode that isn't one", (await refused({ mode: "sometime" as "now" })).includes("Choose"));
    const after = await db.maintenanceMode.findUnique({ where: { id: "global" } });
    ok("  and none of those changed anything", JSON.stringify(after) === JSON.stringify(before));

    // ───────────────────────────────────────────────────────────────────────────
    section("Scheduling one — a month away, so nobody is held");

    const start = inHours(720);
    const end = inHours(722);
    const saved = await actions.saveMaintenance({ mode: "schedule", startsAt: start, endsAt: end, message: "  Moving to the new server.  " });
    ok("it saves as scheduled", saved.ok && saved.data.phase === "scheduled", saved.ok ? saved.data.phase : saved.error);
    const stored = await db.maintenanceMode.findUnique({ where: { id: "global" } });
    ok("the times typed are India time", stored?.startsAt?.getTime() === indiaClock.parseInput(start)?.getTime() && stored?.endsAt?.getTime() === indiaClock.parseInput(end)?.getTime());
    ok("  the message trimmed, and who set it", stored?.message === "Moving to the new server." && stored?.updatedById === admin.id && stored?.enabled === true);
    ok("it is audited", (await db.auditLog.count({ where: { userId: admin.id, entityType: "MaintenanceMode", entityLabel: { startsWith: "Maintenance scheduled from" } } })) === 1);
    ok("the proxy sees it straight away on this server — scheduled, so nobody is held yet", (await lib.currentMaintenance()).phase === "scheduled" && (await lib.maintenanceVerdict({ pathname: "/dashboard", userId: rep.id, state: await lib.currentMaintenance(), mayBypass: lib.mayBypassMaintenance })) === "serve");
    const view = await actions.getMaintenanceSettings();
    ok("the settings read it back, with who can still use the app", view?.phase === "scheduled" && view.stillIn.includes("Zzmaint Admin") && !view.stillIn.includes("Zzmaint Rep"), view?.stillIn.length);

    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const Page = (require("../src/app/(dashboard)/settings/maintenance/page") as { default: () => Promise<ReactElement> }).default;
    const pageHtml = renderToStaticMarkup(await Page());
    ok("the settings page shows it scheduled, the form, and a preview of the page", pageHtml.includes("Maintenance is scheduled.") && pageHtml.includes("Cancel the scheduled maintenance") && /<iframe[^>]*srcdoc=/i.test(pageHtml));
    ok("  and who can still get in", pageHtml.includes("Zzmaint Admin"));
    actorId = rep.id;
    ok("  somebody without the right is told so", renderToStaticMarkup(await Page()).includes("Only somebody who can change organisation settings"));
    actorId = admin.id;

    const { MaintenanceBanner } = require("../src/components/layout/maintenance-banner") as typeof import("../src/components/layout/maintenance-banner");
    const banner = async (state: MaintenanceState) => {
      const el = await MaintenanceBanner({ state });
      return el ? renderToStaticMarkup(el) : "";
    };
    ok("no banner for a window a month away", (await banner(await lib.currentMaintenance())) === "");
    const soon = maintenanceState({ enabled: true, startsAt: new Date(Date.now() + 3 * 3_600_000), endsAt: new Date(Date.now() + 5 * 3_600_000), message: null });
    ok("a window within a day is announced to everybody", (await banner(soon)).includes("Scheduled maintenance") && (await banner(soon)).includes("Save your work"));
    ok("while it is on, those still working are told the app is down for everybody else", (await banner(onState())).includes("Maintenance mode is on") && (await banner(onState())).includes("/settings/maintenance"));

    const { GET } = require("../src/app/api/maintenance/status/route") as typeof import("../src/app/api/maintenance/status/route");
    const status = (await (await GET()).json()) as { down: boolean };
    ok("the status the maintenance page polls says it isn't down", status.down === false);

    const off = await actions.saveMaintenance({ mode: "off" });
    ok("switching it off", off.ok && (await lib.currentMaintenance()).phase === "off" && (await db.maintenanceMode.findUnique({ where: { id: "global" } }))?.enabled === false);
  } finally {
    // Whatever was there before, back exactly — including nothing.
    if (original) {
      const { id, updatedAt, ...rest } = original;
      void updatedAt;
      await db.maintenanceMode.update({ where: { id }, data: rest });
    } else {
      await db.maintenanceMode.deleteMany({ where: { id: "global" } });
    }
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll maintenance checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
