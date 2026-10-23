/**
 * check:notification-emails — which notifications a workspace emails (owner, 18 Oct 2026):
 * src/lib/notifications/email-settings.ts, src/lib/email.ts, Settings › Email notifications.
 *
 *   · An admin's choice for everyone: a switch per kind, at first the two emailed before; a colleague's
 *     birthday or anniversary and a holiday stay in the bell. Only somebody who changes the workspace's
 *     settings chooses, never while viewing as somebody else, and every change is audited.
 *   · Reminders the bell raises (a task overdue, a note reminder…) emailed by a sweep every five
 *     minutes, to people who haven't opened Deskzo too: only what falls due after the kind was switched
 *     on and not long ago, once each, and only the kinds emailed are swept.
 *   · The choice is final: a person's own mute — of the bell, or the old email switch — doesn't stop it.
 *   · One email per notification, at once: through the company's own mail server when one is set up
 *     (checked on the wire, against a fake SMTP server), Deskzo's Alerts mail otherwise, and Deskzo's
 *     when the company's server refuses it. Never to an address no mail reaches; never through a real
 *     server while a check has replaced the mailer.
 *   · Every path that writes notifications emails them; a person's Preferences show the mark, not a switch.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:notification-emails
 */
import "dotenv/config";
import Module from "node:module";
import net from "node:net";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { NOTIFICATION_CATALOGUE } from "../src/lib/notifications/catalogue";
import { EMAILED_BY_DEFAULT, IN_APP_ONLY, SWEPT_REMINDERS, canBeEmailed } from "../src/lib/notifications/email-defaults";
import { SETTINGS_ITEMS } from "../src/lib/settings/catalogue";
import type { PlatformMail } from "../src/lib/platform/mailer";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
let viewingAs = false;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody else." : null),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

// ── A mail server that accepts anything and remembers it: just enough SMTP for nodemailer ─────────

type Wire = { from: string; rcpt: string[]; data: string };
function fakeSmtp(): Promise<{ port: number; close: () => void; mails: Wire[] }> {
  const mails: Wire[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current: Wire = { from: "", rcpt: [], data: "" };
    let auth: "user" | "pass" | null = null;
    socket.write("220 zz.fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            mails.push(current);
            current = { from: "", rcpt: [], data: "" };
            socket.write("250 queued\r\n");
          } else current.data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          continue;
        }
        if (auth === "user") {
          auth = "pass";
          socket.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (auth === "pass") {
          auth = null;
          socket.write("235 ok\r\n");
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-zz.fake\r\n250 AUTH LOGIN PLAIN\r\n");
        else if (verb === "HELO") socket.write("250 zz.fake\r\n");
        else if (verb === "AUTH") {
          if (/^AUTH PLAIN \S+/i.test(line)) socket.write("235 ok\r\n");
          else {
            auth = "user";
            socket.write("334 VXNlcm5hbWU6\r\n");
          }
        } else if (verb === "MAIL") {
          current.from = line;
          socket.write("250 ok\r\n");
        } else if (verb === "RCPT") {
          current.rcpt.push(/<([^>]+)>/.exec(line)?.[1] ?? line);
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go on\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close(), mails })));
}

// ── Without a database ──────────────────────────────────────────────────────────────────────────

function pure() {
  section("1. Which kinds can be emailed");
  const catalogued = new Set(NOTIFICATION_CATALOGUE.map((d) => d.type));
  ok("emailed at first: a proforma on your deal and AI credits, as before", [...EMAILED_BY_DEFAULT].sort().join() === "AI_CREDITS,PROFORMA_ISSUED", [...EMAILED_BY_DEFAULT]);
  ok("  and both can be switched", [...EMAILED_BY_DEFAULT].every(canBeEmailed));

  // The sweep in src/lib/notify.ts is the only code there that names its kinds; notifyUser is handed them.
  const notify = read("src/lib/notify.ts");
  const swept = new Set([...notify.matchAll(/type: "([A-Z_]+)"/g)].map((m) => m[1]!).filter((t) => catalogued.has(t as never)));
  const listed = new Set<string>([...SWEPT_REMINDERS, ...IN_APP_ONLY]);
  const missing = [...swept].filter((t) => !listed.has(t));
  const extra = [...listed].filter((t) => !swept.has(t));
  ok("every kind the bell's sweep raises is a reminder emailed by the scheduled sweep, or kept to the bell", missing.length === 0, missing.join(", "));
  ok("  and nothing else is", extra.length === 0, extra.join(", "));
  ok("  never both", ![...SWEPT_REMINDERS].some((t) => IN_APP_ONLY.has(t)));
  ok("  kept to the bell: a colleague's birthday or anniversary, a holiday", [...IN_APP_ONLY].sort().join() === "BIRTHDAY_TODAY,HOLIDAY_UPCOMING,WORK_ANNIVERSARY", [...IN_APP_ONLY]);
  ok("  none of those can be emailed", [...IN_APP_ONLY].every((t) => !canBeEmailed(t)));
  ok("every other catalogued kind can", NOTIFICATION_CATALOGUE.filter((d) => !IN_APP_ONLY.has(d.type)).every((d) => canBeEmailed(d.type)));
  ok("  an unknown one can't", !canBeEmailed("NOT_A_TYPE" as never));

  section("2. Every path that writes a notification emails it");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  };
  walk(path.join(process.cwd(), "src"));
  const writers = files
    .filter((f) => /\.notification\.(create|createMany|createManyAndReturn|upsert)\(/.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(process.cwd(), f).split(path.sep).join("/"))
    .sort();
  const known = ["src/lib/collections/daily.ts", "src/lib/hr/wishes.ts", "src/lib/notify.ts", "src/lib/recurring-billing/run.ts"];
  ok("the places that write notifications are the ones known", writers.join() === known.join(), writers);
  for (const file of known.filter((f) => f !== "src/lib/notify.ts")) {
    ok(`  ${file} emails what it writes`, read(file).includes("sendEmailNotification("));
  }
  ok("  a muted person is emailed by the day's claim, once (collections, recurring billing)", ["src/lib/collections/daily.ts", "src/lib/recurring-billing/run.ts"].every((f) => read(f).includes("if (count === 1 || !shown) await sendEmailNotification(")));
  ok("  wishes: once for the occasion, with its first wish", read("src/lib/hr/wishes.ts").includes("if (wishes.length === 1) await sendEmailNotification("));
  ok("  the bell's own sweep sends nothing, so opening Deskzo never waits on mail", !/sendEmailNotification\(/.test(notify.slice(notify.indexOf("export async function syncSystemNotifications"))));
  ok("  its reminders are emailed by the scheduled sweep instead, on the five-minute heartbeat", read("src/lib/notifications/reminder-emails.ts").includes("sendEmailNotification(") && read("src/lib/marketing/heartbeat.ts").includes("await emailReminders("));

  section("3. Addresses no mail reaches");
  const { undeliverable } = load("../src/lib/email") as typeof import("../src/lib/email");
  ok("reserved test domains", ["a@x.invalid", "a@example.test", "a@zz.example", "a@host.localhost", "a@example.com", "a@mail.example.org", "A@EXAMPLE.NET"].every(undeliverable));
  ok("  real ones aren't", !["a@acme.in", "a@gmail.com", "a@example-co.com", "a@examples.com", "a@invalid.co", "a@test.in"].some(undeliverable));

  section("4. The screens");
  const item = SETTINGS_ITEMS.find((i) => i.key === "notification-emails");
  ok("Settings › Email notifications: for whoever changes the workspace's settings, in the notifications module", item?.label === "Email notifications" && item.permission === "settings.manage" && item.module === "notifications" && item.href === "/settings/notification-emails", item);
  ok("  its page is there, behind the catalogue's gate", existsSync("src/app/(dashboard)/settings/notification-emails/page.tsx") && read("src/app/(dashboard)/settings/notification-emails/page.tsx").includes('settingsKey="notification-emails"'));
  const prefs = read("src/components/notifications/notification-preferences.tsx");
  ok("a person's Preferences: the bell's switch only, with the Emailed mark", !/row\.email\b/.test(prefs) && !/>Email<\/th>/.test(prefs) && prefs.includes("row.emailed") && prefs.includes("Emailed"));
  const guide = read("scripts/help-guides/notifications.ts");
  ok("the help guide explains the setting", guide.includes('"Email notifications"') && guide.includes("Settings › Email notifications"));
}

// ── In a scratch workspace ──────────────────────────────────────────────────────────────────────

async function main() {
  pure();

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_notemails`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  const smtp = await fakeSmtp();
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const settings = require("../src/lib/notifications/email-settings") as typeof import("../src/lib/notifications/email-settings");
    const actions = require("../src/actions/notification") as typeof import("../src/actions/notification");
    const { notifyUser } = require("../src/lib/notify") as typeof import("../src/lib/notify");
    const { sendEmailNotification } = require("../src/lib/email") as typeof import("../src/lib/email");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    // The fake mail server is on this machine, which the providers refuse unless a check says so.
    (require("../src/lib/marketing/providers/email") as typeof import("../src/lib/marketing/providers/email")).allowTestSmtpServers(true);
    const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
    const { encryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
    /* eslint-enable @typescript-eslint/no-require-imports */

    await db.organisationSettings.upsert({ where: { id: "global" }, create: { id: "global", legalName: "Zz Acme Traders Private Limited", tradeName: "Zz Acme Traders" }, update: { legalName: "Zz Acme Traders Private Limited", tradeName: "Zz Acme Traders" } });
    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-notemails.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const member = await person("Zz Member");
    const as = <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
      return work().finally(() => {
        actor = null;
      });
    };
    ok("the admin changes the workspace's settings; the member doesn't", (await can(boss.id, "settings.manage")) && !(await can(member.id, "settings.manage")));

    section("5. The admin's choice");
    const first = await settings.emailChoices();
    ok("every catalogued kind is on the screen", first.length === NOTIFICATION_CATALOGUE.length, first.length);
    ok("  as it came: the two on, the rest off, nothing chosen", first.every((c) => c.isDefault && c.email === EMAILED_BY_DEFAULT.has(c.type)));
    ok("  birthdays, anniversaries and holidays without a switch", first.filter((c) => !c.switchable).map((c) => c.type).sort().join() === [...IN_APP_ONLY].sort().join());

    const refused = await as(member, () => actions.setNotificationEmail({ type: "TASK_ASSIGNED", email: true }));
    ok("somebody who doesn't change settings can't choose", !refused.ok && !(await settings.isEmailed("TASK_ASSIGNED")), refused.ok ? "ACCEPTED" : refused.error);
    const peek = await as(member, () => actions.notificationEmailChoices());
    ok("  nor read the screen", !peek.ok);
    viewingAs = true;
    const masked = await as(boss, () => actions.setNotificationEmail({ type: "TASK_ASSIGNED", email: true }));
    viewingAs = false;
    ok("an admin viewing as somebody else can't either", !masked.ok && !(await settings.isEmailed("TASK_ASSIGNED")));
    const everyone = await as(boss, () => actions.setNotificationEmail({ type: "BIRTHDAY_TODAY", email: true }));
    ok("a colleague's birthday can't be switched on: it would email every employee", !everyone.ok && !(await settings.isEmailed("BIRTHDAY_TODAY")), everyone.ok ? "ACCEPTED" : everyone.error);
    const nonsense = await as(boss, () => actions.setNotificationEmail({ type: "NOT_A_TYPE", email: true }));
    ok("  nor one that isn't a notification", !nonsense.ok);

    const on = await as(boss, () => actions.setNotificationEmail({ type: "TASK_ASSIGNED", email: true }));
    ok("the admin switches a kind on", on.ok && (await settings.isEmailed("TASK_ASSIGNED")));
    const row = await db.notificationEmailType.findUnique({ where: { type: "TASK_ASSIGNED" } });
    ok("  recorded with who chose", row?.email === true && row.updatedById === boss.id);
    const audit = await db.auditLog.findFirst({ where: { entityType: "NotificationEmailType", entityId: "TASK_ASSIGNED" }, orderBy: { createdAt: "desc" } });
    ok("  and audited in words", audit?.userId === boss.id && !!audit.entityLabel.includes("A task is assigned to me") && audit.entityLabel.includes("is emailed"), audit?.entityLabel);
    const off = await as(boss, () => actions.setNotificationEmail({ type: "AI_CREDITS", email: false }));
    ok("  and one of the first two off", off.ok && !(await settings.isEmailed("AI_CREDITS")));
    const now = await settings.emailedTypes();
    ok("what the workspace emails now", [...now].sort().join() === "PROFORMA_ISSUED,TASK_ASSIGNED", [...now]);
    const screen = await as(boss, () => actions.notificationEmailChoices());
    ok("  the screen says so", screen.ok && screen.data.find((c) => c.type === "TASK_ASSIGNED")?.email === true && screen.data.find((c) => c.type === "AI_CREDITS")?.email === false && screen.data.find((c) => c.type === "AI_CREDITS")?.isDefault === false);

    const prefs = await as(member, () => actions.notificationPreferences());
    ok("a person's Preferences mark the kinds emailed", prefs.ok && prefs.data.find((r) => r.type === "TASK_ASSIGNED")?.emailed === true && prefs.data.find((r) => r.type === "TICKET_COMMENT")?.emailed === false);

    section("6. Sent by Deskzo, when the company has no mail server");
    const caught: PlatformMail[] = [];
    mailer.setTestPlatformMailer(async (m) => void caught.push(m));
    try {
      const told = await notifyUser({ userId: member.id, type: "TASK_ASSIGNED", title: "Zz <b>Ring</b> Acme", message: "Confirm the order & the date", link: "/tasks/zz-1" });
      const m = caught.at(-1);
      ok("one notification, one email, at once", !!told && caught.length === 1, caught.length);
      ok("  Deskzo's Alerts mail, to the person's own address", m?.type === "ALERTS" && m.to === member.email);
      ok("  in the company's name, via Deskzo", m?.fromName === "Zz Acme Traders via Deskzo", m?.fromName);
      ok("  its subject the notification's title", m?.subject === "Zz <b>Ring</b> Acme");
      ok("  saying what happened, with a link to open it", !!m?.text.includes("Confirm the order & the date") && /https?:\/\/\S+\/tasks\/zz-1/.test(m.text) && m.text.startsWith(`Hello ${member.name},`));
      ok("  its HTML escaped", !!m?.html?.includes("Confirm the order &amp; the date") && !m.html.includes("<b>Ring</b>") && m.html.includes('/tasks/zz-1"'));
      ok("  saying who chooses these emails", !!m?.text.includes("Settings › Email notifications"));
      ok("  and the platform's log doesn't keep what it said", m?.logSubject === "A workspace notification: A task is assigned to me", m?.logSubject);

      await notifyUser({ userId: member.id, type: "TICKET_COMMENT", title: "Zz not emailed" });
      ok("a kind the workspace doesn't email isn't", caught.length === 1);

      await db.notificationPreference.create({ data: { userId: member.id, type: "TASK_ASSIGNED", inApp: false, email: false } });
      const muted = await notifyUser({ userId: member.id, type: "TASK_ASSIGNED", title: "Zz muted" });
      ok("a person who muted it — bell and old email switch — still gets the email: the admin's choice is final", muted === null && caught.length === 2 && caught.at(-1)?.subject === "Zz muted");
      ok("  while their bell stays quiet", (await db.notification.count({ where: { userId: member.id, title: "Zz muted" } })) === 0);
      const own = await as(member, () => actions.setNotificationPreference({ type: "TASK_ASSIGNED", inApp: true }));
      ok("  their own switch is the bell's only", own.ok && (await db.notificationPreference.findFirst({ where: { userId: member.id, type: "TASK_ASSIGNED" } }))?.inApp === true);

      await as(boss, () => actions.setNotificationEmail({ type: "TASK_ASSIGNED", email: false }));
      await notifyUser({ userId: member.id, type: "TASK_ASSIGNED", title: "Zz bell only" });
      ok("switched off by the admin: the bell, no email", caught.length === 2 && (await db.notification.count({ where: { userId: member.id, title: "Zz bell only" } })) === 1);
      await as(boss, () => actions.setNotificationEmail({ type: "TASK_ASSIGNED", email: true }));

      const gone = await person("Zz Gone", { active: false });
      const helper = await person("Zz Support", { kind: "SUPPORT" });
      await notifyUser({ userId: gone.id, type: "TASK_ASSIGNED", title: "Zz to the gone" });
      await notifyUser({ userId: helper.id, type: "TASK_ASSIGNED", title: "Zz to support" });
      ok("nobody who has left, and no support login, is emailed", caught.length === 2);

      const invalid = await person("Zz Reserved");
      await db.user.update({ where: { id: invalid.id }, data: { email: "zz.reserved@notemails.invalid" } });
      const seen = await sendEmailNotification({ userId: invalid.id, type: "TASK_ASSIGNED", subject: "Zz reserved", body: "" });
      ok("a check's stand-in sees even a reserved address", seen === "DESKZO" && caught.at(-1)?.to === "zz.reserved@notemails.invalid");

      section("7. Through the company's own mail server");
      await db.messagingProvider.create({
        data: {
          key: "smtp",
          kind: "EMAIL",
          label: "Zz SMTP",
          enabled: true,
          priority: -1000,
          classes: ["TRANSACTIONAL"],
          fromName: "Acme Accounts",
          fromEmail: "alerts@zz-acme.in",
          config: { host: "127.0.0.1", port: String(smtp.port), user: "alerts@zz-acme.in" },
          secretCipher: await encryptSecret("zz-password"),
        },
      });
      const before = caught.length;
      const withoutSaying = await sendEmailNotification({ userId: member.id, type: "TASK_ASSIGNED", subject: "Zz guarded", body: "x" });
      ok("while a check has replaced the mailer without saying, the company's server isn't touched", withoutSaying === "DESKZO" && smtp.mails.length === 0 && caught.length === before + 1);

      mailer.setTestPlatformMailer(async (m) => void caught.push(m), { companyMail: true });
      const via = await sendEmailNotification({ userId: member.id, type: "TASK_ASSIGNED", subject: "Zz through the company", body: "Through the company's server", link: "/tasks/zz-2" });
      const wire = smtp.mails.at(-1);
      ok("set up: it goes through the company's server", via === "COMPANY" && smtp.mails.length === 1 && caught.length === before + 1, via);
      ok("  to the person", !!wire?.rcpt.includes(member.email!));
      ok("  from its address, in the company's name", !!wire && /From: "?Zz Acme Traders"? <alerts@zz-acme\.in>/.test(wire.data), wire?.data.split("\n").find((l) => l.startsWith("From:")));
      ok("  with the link", !!wire?.data.includes("/tasks/zz-2"));

      await db.messagingProvider.updateMany({ where: { label: "Zz SMTP" }, data: { config: { host: "127.0.0.1", port: "1", user: "alerts@zz-acme.in" } } });
      const fallback = await sendEmailNotification({ userId: member.id, type: "TASK_ASSIGNED", subject: "Zz refused", body: "x" });
      ok("the company's server refusing it: Deskzo sends it instead", fallback === "DESKZO" && caught.at(-1)?.subject === "Zz refused", fallback);
      await db.messagingProvider.updateMany({ where: { label: "Zz SMTP" }, data: { config: { host: "127.0.0.1", port: String(smtp.port), user: "alerts@zz-acme.in" } } });

      mailer.setTestPlatformMailer(null);
      const sentBefore = smtp.mails.length;
      const nowhere = await sendEmailNotification({ userId: invalid.id, type: "TASK_ASSIGNED", subject: "Zz nowhere", body: "x" });
      ok("for real, an address no mail reaches is never sent to", nowhere === null && smtp.mails.length === sentBefore);
    } finally {
      mailer.setTestPlatformMailer(null);
    }

    section("8. Reminders by email, every five minutes");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { emailReminders, LATE_MS } = require("../src/lib/notifications/reminder-emails") as typeof import("../src/lib/notifications/reminder-emails");
    const { syncSystemNotifications } = require("../src/lib/notify") as typeof import("../src/lib/notify");
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const clock = await workspaceClock();
    const DAY = 86_400_000;
    const real = new Date();
    /** A typed day (midnight UTC), `plus` days from today on the workspace's clock. */
    const typedDay = (plus: number) => new Date(clock.calendarDate(real).getTime() + plus * DAY);
    /** An hour into that day, on the workspace's clock. */
    const into = (plus: number) => new Date(clock.startOfDay(typedDay(plus).toISOString().slice(0, 10))!.getTime() + 3_600_000);
    const mailed: PlatformMail[] = [];
    mailer.setTestPlatformMailer(async (m) => void mailed.push(m));
    try {
      const idle = await emailReminders({ now: real });
      ok("a workspace emailing none of the reminders sweeps nobody", idle.kinds === 0 && idle.people === 0, idle);

      const reminded = await person("Zz Reminded");
      const quiet = await person("Zz Quiet");
      const task = (title: string, userId: string, plus: number) => db.task.create({ data: { title, createdByUserId: boss.id, assignedToUserId: userId, dueDate: typedDay(plus) }, select: { id: true } });
      await task("Zz long overdue", reminded.id, -3);
      await task("Zz due today", reminded.id, 0);
      await task("Zz quiet's task", quiet.id, 0);
      await db.notificationPreference.create({ data: { userId: quiet.id, type: "TASK_OVERDUE", inApp: false, email: false } });

      const switched = await as(boss, () => actions.setNotificationEmail({ type: "TASK_OVERDUE", email: true }));
      const onSince = (await db.notificationEmailType.findUnique({ where: { type: "TASK_OVERDUE" }, select: { onSince: true } }))?.onSince;
      ok("a reminder kind can be switched on, from that moment", switched.ok && (await settings.isEmailed("TASK_OVERDUE")) && !!onSince && Math.abs(onSince.getTime() - Date.now()) < 60_000, onSince);

      const first = await emailReminders({ now: new Date() });
      ok("switching it on doesn't email what's already pending", first.kinds === 1 && first.people >= 3 && first.emailed === 0 && mailed.length === 0, first);
      ok("  though the sweep puts it in the bell, as the bell's own sweep would", (await db.notification.count({ where: { userId: reminded.id, type: "TASK_OVERDUE", message: "Zz long overdue" } })) === 1);

      const overdue = await emailReminders({ now: into(1) });
      ok("a task going overdue after it was switched on is emailed as it falls due", mailed.some((m) => m.to === reminded.email && m.subject === "Task overdue" && m.text.includes("Zz due today")), mailed.map((m) => m.subject));
      ok("  to the one who muted it in their bell too: the admin's choice is final", mailed.some((m) => m.to === quiet.email && m.text.includes("Zz quiet's task")) && overdue.emailed === 2, overdue);
      ok("  whose bell stays quiet", (await db.notification.count({ where: { userId: quiet.id, type: "TASK_OVERDUE" } })) === 0);
      ok("  and never the one that was pending already", !mailed.some((m) => m.text.includes("Zz long overdue")));
      const again = await emailReminders({ now: new Date(into(1).getTime() + 5 * 60_000) });
      ok("the next beat sends none of them again", again.emailed === 0 && mailed.length === 2, again);
      ok("  each claimed once", (await db.notificationEmailClaim.count()) === 2);

      await db.stickyNote.create({ data: { ownerUserId: reminded.id, body: "Zz unswept note", remindAt: new Date(real.getTime() - 60_000) } });
      await emailReminders({ now: new Date() });
      ok("a reminder kind the workspace doesn't email isn't swept: it's left for the bell", (await db.notification.count({ where: { userId: reminded.id, type: "NOTE_REMINDER" } })) === 0);

      await as(boss, () => actions.setNotificationEmail({ type: "NOTE_REMINDER", email: true }));
      const lateNote = await db.stickyNote.create({ data: { ownerUserId: quiet.id, body: "Zz forgotten note", remindAt: new Date(Date.now() + 60_000) } });
      const late = await emailReminders({ now: new Date(Date.now() + LATE_MS + 3_600_000) });
      ok("a reminder found more than two days after it fell due isn't emailed", late.emailed === 0 && !mailed.some((m) => m.text.includes("Zz forgotten note")), late);
      await db.stickyNote.delete({ where: { id: lateNote.id } });
      await db.stickyNote.create({ data: { ownerUserId: quiet.id, body: "Zz timely note", remindAt: new Date(Date.now() + 60_000) } });
      const timely = await emailReminders({ now: new Date(Date.now() + 3 * 60_000) });
      ok("  one found within five minutes is", timely.emailed === 1 && mailed.some((m) => m.to === quiet.email && m.subject === "Sticky note reminder" && m.text.includes("Zz timely note")), timely);
      ok("  one already pending when its kind was switched on isn't", !mailed.some((m) => m.text.includes("Zz unswept note")));

      await as(boss, () => actions.setNotificationEmail({ type: "TASK_REMINDER", email: true }));
      const remindedTask = await task("Zz remind me", reminded.id, 5);
      const reminder = await db.taskReminder.create({ data: { taskId: remindedTask.id, userId: reminded.id, nextAt: new Date(Date.now() + 60_000) }, select: { id: true } });
      const fired = await emailReminders({ now: new Date(Date.now() + 3 * 60_000) });
      ok("a task reminder fires on time with nobody in Deskzo: emailed", fired.emailed === 1 && mailed.some((m) => m.subject === "Task reminder" && m.text.includes("Zz remind me")), fired);
      ok("  in the bell too, and a one-off reminder is done", (await db.notification.count({ where: { userId: reminded.id, type: "TASK_REMINDER" } })) === 1 && (await db.taskReminder.count({ where: { id: reminder.id } })) === 0);

      const company = await db.company.create({ data: { name: "Zz Ticket Co", normalizedName: "zz ticket co", createdById: boss.id }, select: { id: true } });
      const opened = new Date(Date.now() - 80 * 3_600_000);
      const ticket = await db.ticket.create({ data: { companyId: company.id, title: "Zz slow ticket", createdByUserId: boss.id, assignedToUserId: reminded.id, priority: "MEDIUM", createdAt: opened }, select: { id: true } });
      const slaNotices = await syncSystemNotifications(reminded.id, { kinds: new Set(["TICKET_SLA_OVERDUE"]) });
      const sla = slaNotices.find((n) => n.dedupeKey === `ticket-sla:${ticket.id}`);
      ok("a ticket fell past its SLA when its hours ran out", sla?.at?.getTime() === opened.getTime() + 72 * 3_600_000, sla?.at);
      ok("  and a sweep asked for one kind raises only that kind", slaNotices.every((n) => n.type === "TICKET_SLA_OVERDUE"));
      const dueNotices = await syncSystemNotifications(reminded.id, { kinds: new Set(["TASK_DUE", "TASK_OVERDUE"]), now: into(5) });
      const due = dueNotices.find((n) => n.type === "TASK_DUE" && n.message === "Zz remind me");
      ok("a task falls due at the start of its day, on the workspace's clock", due?.at?.getTime() === clock.startOfDay(typedDay(5).toISOString().slice(0, 10))!.getTime(), due?.at);

      await as(boss, () => actions.setNotificationEmail({ type: "TASK_OVERDUE", email: false }));
      ok("switched off, it's no longer on from any moment", (await db.notificationEmailType.findUnique({ where: { type: "TASK_OVERDUE" }, select: { onSince: true } }))?.onSince === null);
      const before = mailed.length;
      await task("Zz overdue while off", reminded.id, 0);
      await emailReminders({ now: into(1) });
      ok("  and sends nothing", mailed.length === before);
    } finally {
      mailer.setTestPlatformMailer(null);
    }

    section("9. Back to the defaults");
    const cleared = await as(boss, () => actions.resetNotificationEmails());
    ok("the admins' choices forgotten", cleared.ok && cleared.data.cleared >= 2 && (await db.notificationEmailType.count()) === 0, cleared.ok ? cleared.data.cleared : cleared.error);
    ok("  and the first two emailed again", [...(await settings.emailedTypes())].sort().join() === "AI_CREDITS,PROFORMA_ISSUED");
    ok("  audited", (await db.auditLog.count({ where: { entityType: "NotificationEmailType", entityId: "all" } })) === 1);
    const memberReset = await as(member, () => actions.resetNotificationEmails());
    ok("  which only an admin can do", !memberReset.ok);
  } finally {
    smtp.close();
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} notification email checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
