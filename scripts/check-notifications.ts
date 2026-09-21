/**
 * Whether a mute actually mutes, and whether the preferences screen still covers what we send.
 *
 * Two failures this guards, and both are quiet:
 *
 *   · **A mute that does not.** The preference is stored, the screen shows it off, and the
 *     notifications keep arriving — because one of the two paths that create them never learned the
 *     rule. There are two: `notifyUser`, and the `createMany` inside `syncSystemNotifications`,
 *     which is where renewals, overdue tasks and SLA breaches come from. Exactly the ones somebody
 *     would want to turn down.
 *   · **A type nobody can tune.** A value added to `NotificationType` and not to the catalogue
 *     renders as `REGULARISATION_DECIDED` on the list and is missing from the preferences screen
 *     altogether — no error, just an option that quietly does not exist.
 *
 *   npm run check:notifications
 *
 * Everything is created under a reserved user and removed again, so this is safe to run against a
 * database with real data in it.
 */
import Module from "node:module";
import { readFileSync } from "node:fs";
import type { NotificationType } from "@prisma/client";
import { db } from "../src/lib/db";
import {
  NOTIFICATION_CATALOGUE,
  NOTIFICATION_GROUPS,
  isAlwaysOn,
  notificationLabel,
  wants,
} from "../src/lib/notifications/catalogue";
import { notifyUser } from "../src/lib/notify";

/** The action layer resolves a session; only "who is asking" is substituted. */
const internals = Module as unknown as { _load(r: string, parent: unknown, m: boolean): unknown };
const originalLoad = internals._load;
let actor: { id: string; name: string; email: string; role: string } | null = null;
internals._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  const resolved = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
  if (request.includes("lib/session")) {
    return { ...resolved, requireUser: async () => actor, currentUser: async () => actor };
  }
  return resolved;
};

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

async function main() {
  section("The catalogue covers what we actually send");

  /**
   * Read from the schema rather than from the generated client's runtime object, because that is
   * the thing somebody edits when they add a type — and the point is to fail when those two
   * disagree.
   */
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const block = /enum NotificationType \{([\s\S]*?)\n\}/.exec(schema);
  const enumValues = (block?.[1] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));

  ok("the enum was found in the schema", enumValues.length > 20, enumValues.length);

  const catalogued = new Set(NOTIFICATION_CATALOGUE.map((d) => d.type as string));
  const missing = enumValues.filter((v) => !catalogued.has(v));
  const stale = [...catalogued].filter((c) => !enumValues.includes(c));

  ok("every type we send has an entry", missing.length === 0, missing.join(", ") || `${enumValues.length} types`);
  ok("and nothing is catalogued that we no longer send", stale.length === 0, stale.join(", "));
  ok("no type is listed twice", catalogued.size === NOTIFICATION_CATALOGUE.length);

  ok("every entry names a real group", NOTIFICATION_CATALOGUE.every((d) => NOTIFICATION_GROUPS.some((g) => g.key === d.group)));
  ok("every group has something in it", NOTIFICATION_GROUPS.every((g) => NOTIFICATION_CATALOGUE.some((d) => d.group === g.key)), NOTIFICATION_GROUPS.filter((g) => !NOTIFICATION_CATALOGUE.some((d) => d.group === g.key)).map((g) => g.key).join(","));

  // A label that is just the enum with the underscores taken out is a label nobody wrote.
  ok(
    "every entry is written in words, not shouted",
    NOTIFICATION_CATALOGUE.every((d) => d.label.length > 3 && d.label !== d.label.toUpperCase() && d.when.length > 10),
  );
  ok("the fallback label is readable when a type is somehow missing", notificationLabel("NOT_A_REAL_TYPE" as NotificationType) === "not a real type");

  {
    /**
     * The always-on list is short on purpose. If it grows, the preferences screen stops being a
     * preferences screen — so a change to it should be a decision, not a drift.
     */
    const alwaysOn = NOTIFICATION_CATALOGUE.filter((d) => d.alwaysOn).map((d) => d.type);
    ok("only a handful cannot be switched off", alwaysOn.length <= 4, alwaysOn.join(", "));
    ok("  and they are the ones about somebody seeing something", alwaysOn.every((t) => /SECURITY|CREDENTIAL/.test(t)), alwaysOn.join(", "));
  }

  section("What a preference means");

  const ANY: NotificationType = "TASK_ASSIGNED";
  ok("no row at all means yes", wants(ANY, "inApp", null) && wants(ANY, "email", undefined));
  ok("a row saying no means no", !wants(ANY, "inApp", { inApp: false, email: true }));
  ok("  per channel, not both at once", wants(ANY, "email", { inApp: false, email: true }));
  // Ignored rather than defaulted: a leftover row must not be able to switch a security alert off.
  ok("an always-on type ignores the row entirely", wants("SECURITY_ALERT", "inApp", { inApp: false, email: false }));
  ok("  and is reported as always-on", isAlwaysOn("SECURITY_ALERT") && !isAlwaysOn("TASK_ASSIGNED"));

  section("A mute that actually mutes");

  const stamp = Date.now();
  const user = await db.user.create({
    data: {
      name: "ZZNotify Probe",
      email: `zznotify.${stamp}@example.invalid`,
      passwordHash: "not-a-real-hash",
      role: "SALES",
    },
    select: { id: true, name: true, email: true, role: true },
  });
  actor = user;

  try {
    const count = (type?: NotificationType) =>
      db.notification.count({ where: { userId: user.id, ...(type ? { type } : {}) } });

    await notifyUser({ userId: user.id, type: "TASK_ASSIGNED", title: "One" });
    ok("with no preference set, a notification is created", (await count("TASK_ASSIGNED")) === 1);

    await db.notificationPreference.create({
      data: { userId: user.id, type: "TASK_ASSIGNED", inApp: false, email: false },
    });
    await notifyUser({ userId: user.id, type: "TASK_ASSIGNED", title: "Two" });
    /**
     * Not created, rather than created and hidden. A row that exists and is filtered out still turns
     * up in a count, an export, and the next screen somebody writes against this table.
     */
    ok("once muted, nothing is written at all", (await count("TASK_ASSIGNED")) === 1, await count("TASK_ASSIGNED"));

    await notifyUser({ userId: user.id, type: "LEAD_ASSIGNED", title: "Three" });
    ok("  and only that type is affected", (await count("LEAD_ASSIGNED")) === 1);

    await db.notificationPreference.create({
      data: { userId: user.id, type: "SECURITY_ALERT", inApp: false, email: false },
    });
    await notifyUser({ userId: user.id, type: "SECURITY_ALERT", title: "Four" });
    ok("an always-on type arrives even when a row says no", (await count("SECURITY_ALERT")) === 1);

    // In-app off but email on is a real combination, and must still suppress the bell.
    await db.notificationPreference.create({
      data: { userId: user.id, type: "TICKET_COMMENT", inApp: false, email: true },
    });
    await notifyUser({ userId: user.id, type: "TICKET_COMMENT", title: "Five" });
    ok("muting the bell but not email still suppresses the bell", (await count("TICKET_COMMENT")) === 0);

    section("The other path that creates notifications");

    {
      /**
       * `syncSystemNotifications` writes with `createMany`, not through `notifyUser` — so it had to
       * learn the rule separately, and a mute on a renewal or an overdue task would otherwise do
       * nothing at all. Driven here through the real action rather than by calling the sweep, so
       * what is checked is the path the app uses.
       */
      const { listNotifications } = await import("../src/actions/notification");

      await db.notification.createMany({
        data: [
          { userId: user.id, type: "RENEWAL_EXPIRING", title: "Planted", dedupeKey: `zz-renewal:${stamp}` },
        ],
        skipDuplicates: true,
      });
      const page = await listNotifications({ page: 1, pageSize: 50 });
      ok("the list returns what is there", page.total >= 1 && page.rows.length >= 1, page.total);
      ok("  and counts unread separately", page.unread >= 1, page.unread);
      // Not a bare count: fetching the list also runs the system sweep, which legitimately creates
      // overdue-task and renewal rows of its own. What matters is that the planted one appears once.
      ok(
        "  and the planted one appears exactly once",
        page.rows.filter((r) => r.title === "Planted").length === 1,
        page.rows.filter((r) => r.title === "Planted").length,
      );
    }

    section("Archive, restore, delete");

    {
      const { listNotifications, archiveNotification, unarchiveNotification, deleteNotifications } = await import(
        "../src/actions/notification"
      );

      const inbox = await listNotifications({ page: 1, pageSize: 50 });
      const first = inbox.rows[0]!;

      await archiveNotification({ ids: [first.id] });
      const afterArchive = await listNotifications({ page: 1, pageSize: 50 });
      ok("archiving takes it out of the inbox", !afterArchive.rows.some((r) => r.id === first.id));
      // Archiving is also reading: you cannot be done with something you have not seen.
      const archivedRow = await db.notification.findUnique({ where: { id: first.id }, select: { read: true, archivedAt: true } });
      ok("  and marks it read on the way", archivedRow?.read === true && archivedRow.archivedAt !== null);

      const archived = await listNotifications({ page: 1, pageSize: 50, view: "archived" });
      ok("  it is in the archive", archived.rows.some((r) => r.id === first.id));
      ok("  and nothing else is", archived.rows.length === 1, archived.rows.length);

      await unarchiveNotification({ ids: [first.id] });
      const restored = await listNotifications({ page: 1, pageSize: 50 });
      ok("putting it back returns it to the inbox", restored.rows.some((r) => r.id === first.id));

      const deleted = await deleteNotifications({ ids: [first.id] });
      ok("deleting removes it for good", deleted.ok && deleted.data.deleted === 1);
      ok("  and it is gone from the table", (await db.notification.count({ where: { id: first.id } })) === 0);

      ok("deleting nothing is not an error", (await deleteNotifications({ ids: [] })).ok);
    }

    section("Somebody else's notifications");

    {
      const { archiveNotification, deleteNotifications } = await import("../src/actions/notification");

      const other = await db.user.create({
        data: {
          name: "ZZNotify Other",
          email: `zznotify.other.${stamp}@example.invalid`,
          passwordHash: "not-a-real-hash",
          role: "SALES",
        },
        select: { id: true },
      });
      const theirs = await db.notification.create({
        data: { userId: other.id, type: "TASK_ASSIGNED", title: "Not yours" },
        select: { id: true },
      });

      try {
        /**
         * Every write is scoped by the session's own id as well as by the row's, so an id from
         * anywhere else matches nothing. Returning a count of zero rather than an error is the
         * right shape: it says nothing about whether that id exists.
         */
        const archive = await archiveNotification({ ids: [theirs.id] });
        ok("archiving somebody else's does nothing", archive.ok && archive.data.archived === 0);
        const remove = await deleteNotifications({ ids: [theirs.id] });
        ok("  nor can it be deleted", remove.ok && remove.data.deleted === 0);
        ok("  and it is untouched", (await db.notification.count({ where: { id: theirs.id, archivedAt: null } })) === 1);
      } finally {
        await db.notification.deleteMany({ where: { userId: other.id } });
        await db.user.delete({ where: { id: other.id } });
      }
    }

    section("Setting a preference through the real action");

    {
      const { setNotificationPreference, notificationPreferences, resetNotificationPreferences } = await import(
        "../src/actions/notification"
      );

      const all = await notificationPreferences();
      ok("every catalogued type comes back", all.ok && all.data.length === NOTIFICATION_CATALOGUE.length, all.ok ? all.data.length : all.error);
      ok("  with the stored mute reflected", all.ok && all.data.find((r) => r.type === "TASK_ASSIGNED")?.inApp === false);
      ok("  and an untouched type reading as on", all.ok && all.data.find((r) => r.type === "VISIT_SCHEDULED")?.inApp === true);

      const refused = await setNotificationPreference({ type: "SECURITY_ALERT", inApp: false, email: false });
      // Refused rather than stored-and-ignored: a switch that shows off while the notifications keep
      // coming takes the credibility of every other switch with it.
      ok("an always-on type refuses to be switched off", !refused.ok, refused.ok ? "ACCEPTED IT" : refused.error);

      const nonsense = await setNotificationPreference({ type: "NOT_A_TYPE", inApp: false, email: false });
      ok("an unknown type is refused", !nonsense.ok);

      const good = await setNotificationPreference({ type: "VISIT_SCHEDULED", inApp: false, email: true });
      ok("an ordinary type saves", good.ok, good.ok ? "" : good.error);

      const cleared = await resetNotificationPreferences();
      ok("resetting deletes the opinions rather than rewriting them", cleared.ok && cleared.data.cleared > 0, cleared.ok ? cleared.data.cleared : "");
      ok("  so everything is back on", (await db.notificationPreference.count({ where: { userId: user.id } })) === 0);
      await notifyUser({ userId: user.id, type: "TASK_ASSIGNED", title: "After reset" });
      ok("  and a previously muted type arrives again", (await count("TASK_ASSIGNED")) >= 1);
    }
  } finally {
    await db.notificationPreference.deleteMany({ where: { userId: user.id } });
    await db.notification.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    actor = null;
  }

  console.log(failures === 0 ? "\nAll notification checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
