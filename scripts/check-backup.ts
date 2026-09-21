/**
 * Whether the backups would actually be there.
 *
 * A backup module is the one part of a system whose failures are invisible right up to the moment
 * they are catastrophic. Nobody notices a dump that exits zero and writes 400 bytes. Nobody notices
 * a retention rule that deletes the last good copy. Nobody notices a fingerprint that never
 * mismatches. You find out on the day you are restoring, which is the day you cannot afford to.
 *
 *   npm run check:backup
 *
 * So this checks the two decisions rather than the mechanics — which old files may be deleted, and
 * whether a dump can be read back — and then runs the real pruner against real files in a temporary
 * folder, because "deletes the right files" is not a claim a pure function can make on its own.
 *
 * Everything is created under a temporary directory and a reserved filename prefix, and removed
 * again, so this is safe to run against a database with real data in it.
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "../src/lib/db";
import {
  DEFAULT_KEEP_DAYS,
  DEFAULT_KEEP_MINIMUM,
  STALE_AFTER_HOURS,
  backupFilename,
  formatBytes,
  parseDatabaseUrl,
  prunable,
  stalenessOf,
  type BackupFile,
} from "../src/lib/backup/policy";
import { secretFingerprint } from "../src/lib/backup/fingerprint";
import {
  RETRY_AFTER_MINUTES,
  RUNNING_PRESUMED_DEAD_MINUTES,
  describeSchedule,
  dueNow,
  formatTimeOfDay,
  nextRunAfter,
  normaliseSchedule,
  parseTimeOfDay,
  scheduledTimeOn,
  type Schedule,
  type ScheduleState,
} from "../src/lib/backup/schedule";
import { readSidecar, sidecarPath, writeSidecar } from "../src/lib/backup/sidecar";
import { pruneOldBackups, filesOnDisk, resolveDumpTool, settleStaleRuns } from "../src/lib/backup/run";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

const DAY = 86400000;
const HOUR = 3600000;

/** A fixed clock. Nothing here should depend on when it is run. */
const NOW = new Date("2026-09-20T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/**
 * Against the real clock, for the parts that run against the database.
 *
 * `pruneOldBackups` and `settleStaleRuns` read their own `new Date()`, so rows have to be old
 * relative to whenever this is actually run rather than to the fixed clock above.
 */
const realAgo = (ms: number) => new Date(Date.now() - ms);

function file(name: string, takenAt: Date, keep?: boolean): BackupFile {
  return { filename: name, takenAt, ...(keep === undefined ? {} : { keep }) };
}
const names = (files: BackupFile[]) => files.map((f) => f.filename).sort().join(",");

async function main() {
  section("Filenames");

  const stamped = backupFilename(new Date(2026, 8, 7, 4, 5, 6));
  ok("named for the app, dated and timed", stamped === "wroffy-2026-09-07-040506.dump", stamped);
  ok(
    "single digits padded, so names are a fixed width",
    /^wroffy-\d{4}-\d{2}-\d{2}-\d{6}\.dump$/.test(stamped),
    stamped,
  );
  {
    // The reason for the ordering: a folder of these sorted by name is sorted by age, which is how
    // anybody actually looks for "the most recent one" at three in the morning.
    const earlier = backupFilename(new Date(2026, 0, 2, 3, 4, 5));
    const later = backupFilename(new Date(2026, 10, 2, 3, 4, 5));
    ok("sorts chronologically as plain text", earlier < later, `${earlier} < ${later}`);
  }

  section("Connection details");

  {
    const c = parseDatabaseUrl("postgresql://wroffy:pw@localhost:5433/wroffy_crm?schema=public");
    ok("host, port, user and database pulled apart", c?.host === "localhost" && c.port === "5433" && c.user === "wroffy" && c.database === "wroffy_crm", JSON.stringify(c));
  }
  {
    // A password with a `@` or a `/` in it has to be escaped in a URL, and pg_dump wants the real
    // one. Passing the escaped form through produces an authentication failure that looks like a
    // wrong password because it is one.
    const c = parseDatabaseUrl("postgresql://user:p%40ss%2Fword@db:5432/app");
    ok("password percent-decoded", c?.password === "p@ss/word", c?.password);
  }
  ok("port defaults to 5432", parseDatabaseUrl("postgresql://u:p@host/app")?.port === "5432");
  ok("postgres:// accepted as well as postgresql://", parseDatabaseUrl("postgres://u:p@host/app") !== null);
  ok("a MySQL URL is refused rather than half-parsed", parseDatabaseUrl("mysql://u:p@host/app") === null);
  ok("no database name is refused", parseDatabaseUrl("postgresql://u:p@host/") === null);
  ok("nonsense returns null rather than throwing", parseDatabaseUrl("not a url") === null);
  ok("missing DATABASE_URL returns null", parseDatabaseUrl(undefined) === null);

  section("Secret fingerprint");

  {
    const secret = "a-real-looking-auth-secret-value";
    const fp = secretFingerprint(secret);
    ok("sixteen hex characters", /^[0-9a-f]{16}$/.test(fp ?? ""), fp);
    ok("same secret, same fingerprint", fp === secretFingerprint(secret));
    ok("a different secret gives a different fingerprint", fp !== secretFingerprint(secret + "!"));
    // The whole point of an HMAC rather than a prefix: this sits in a JSON file next to the dump.
    ok("does not contain the secret", !fp!.includes(secret.slice(0, 8)) && !secret.includes(fp!));
    ok("no secret, no fingerprint", secretFingerprint(undefined) === null && secretFingerprint("") === null);
    // A one-character difference must not survive truncation to 16 chars.
    const near = [secretFingerprint("secret-1"), secretFingerprint("secret-2"), secretFingerprint("secret-3")];
    ok("near-identical secrets stay distinguishable", new Set(near).size === 3, near.join(" "));
  }

  section("Retention — which files may be deleted");

  ok("an empty folder prunes nothing", prunable([], NOW).length === 0);

  {
    const files = [
      file("a", ago(1 * DAY)),
      file("b", ago(2 * DAY)),
      file("c", ago(3 * DAY)),
      file("d", ago(4 * DAY)),
    ];
    ok("nothing recent is touched", prunable(files, NOW).length === 0);
  }

  {
    const files = [
      file("new-1", ago(1 * DAY)),
      file("new-2", ago(2 * DAY)),
      file("new-3", ago(3 * DAY)),
      file("old-1", ago(30 * DAY)),
      file("old-2", ago(60 * DAY)),
    ];
    const doomed = prunable(files, NOW);
    ok("old files past the minimum go", names(doomed) === "old-1,old-2", names(doomed));
    ok("and only those — the result is a subset of the input", doomed.every((d) => files.includes(d)));
  }

  {
    // The failure this floor exists for: the nightly job breaks and nobody notices for months. With
    // age alone, the retention policy carefully deletes the last copies of a database nobody is
    // backing up any more.
    const ancient = [
      file("x-1", ago(100 * DAY)),
      file("x-2", ago(101 * DAY)),
      file("x-3", ago(102 * DAY)),
      file("x-4", ago(103 * DAY)),
      file("x-5", ago(104 * DAY)),
    ];
    const doomed = prunable(ancient, NOW, { keepMinimum: 3 });
    ok("the newest three survive any age", names(doomed) === "x-4,x-5", names(doomed));
    ok("and it is the newest three that survive, not the first three seen", !doomed.some((d) => ["x-1", "x-2", "x-3"].includes(d.filename)));
  }

  {
    const ancient = [file("y-1", ago(200 * DAY)), file("y-2", ago(201 * DAY)), file("y-3", ago(202 * DAY))];
    ok("every file ancient and keepMinimum covering them all — nothing goes", prunable(ancient, NOW, { keepMinimum: 3 }).length === 0);
    // The belt-and-braces guard. Even asked to keep none, it will not empty the folder.
    ok("a retention policy can never empty the folder", prunable(ancient, NOW, { keepMinimum: 0, keepDays: 1 }).length < ancient.length);
    ok("one lone ancient file is never the one deleted", prunable([file("z", ago(999 * DAY))], NOW, { keepMinimum: 0 }).length === 0);
  }

  {
    // A run still writing its file, and a failed run whose row is the only evidence it failed.
    const files = [
      file("k-1", ago(1 * DAY)),
      file("k-2", ago(2 * DAY)),
      file("k-3", ago(3 * DAY)),
      file("running", ago(90 * DAY), true),
      file("failed", ago(91 * DAY), true),
      file("plain-old", ago(92 * DAY)),
    ];
    const doomed = prunable(files, NOW);
    ok("a kept file is never pruned however old", names(doomed) === "plain-old", names(doomed));
  }

  {
    // Boundaries, because "older than 14 days" is exactly the kind of rule that is off by one.
    const onTheDay = [
      file("n-1", ago(0)),
      file("n-2", ago(1 * HOUR)),
      file("n-3", ago(2 * HOUR)),
      file("exactly", ago(DEFAULT_KEEP_DAYS * DAY)),
      file("a-second-older", ago(DEFAULT_KEEP_DAYS * DAY + 1000)),
    ];
    const doomed = prunable(onTheDay, NOW);
    ok("exactly at the cutoff is kept", !doomed.some((d) => d.filename === "exactly"), names(doomed));
    ok("a second past it goes", doomed.some((d) => d.filename === "a-second-older"), names(doomed));
  }

  {
    // The function sorts internally; a caller handing it rows in whatever order the database
    // returned must get the same answer as one handing them over newest first.
    const base = [
      file("s-1", ago(1 * DAY)),
      file("s-2", ago(40 * DAY)),
      file("s-3", ago(2 * DAY)),
      file("s-4", ago(41 * DAY)),
      file("s-5", ago(3 * DAY)),
    ];
    const forwards = names(prunable(base, NOW));
    const backwards = names(prunable([...base].reverse(), NOW));
    ok("input order does not change the outcome", forwards === backwards && forwards === "s-2,s-4", `${forwards} / ${backwards}`);
  }

  ok("keepDays of 0 still respects the minimum", prunable([file("q-1", ago(HOUR)), file("q-2", ago(2 * HOUR)), file("q-3", ago(3 * HOUR)), file("q-4", ago(4 * HOUR))], NOW, { keepDays: 0, keepMinimum: DEFAULT_KEEP_MINIMUM }).length === 1);

  section("Staleness");

  {
    const never = stalenessOf(null, NOW);
    // "No backup has ever completed" rather than "the last backup was N days ago" — there is no N,
    // and inventing one from the epoch is how a page ends up claiming 20,000 days.
    ok(
      "never backed up is stale, and says so differently",
      never.stale && never.hoursSince === null && /has ever completed/.test(never.message) && !/[0-9]/.test(never.message),
      never.message,
    );
  }
  ok("an hour ago is not stale", !stalenessOf(ago(HOUR), NOW).stale);
  ok("exactly at the threshold is stale", stalenessOf(ago(STALE_AFTER_HOURS * HOUR), NOW).stale);
  ok("an hour short of it is not", !stalenessOf(ago((STALE_AFTER_HOURS - 1) * HOUR), NOW).stale);
  {
    const twoDays = stalenessOf(ago(2 * DAY + HOUR), NOW);
    ok("days are counted in days", /2 days/.test(twoDays.message), twoDays.message);
    const oneDay = stalenessOf(ago(25 * HOUR), NOW, 24);
    ok("one day is singular", /1 day\b/.test(oneDay.message) && !/1 days/.test(oneDay.message), oneDay.message);
    const hours = stalenessOf(ago(13 * HOUR), NOW, 12);
    ok("under a day is counted in hours", /13 hours/.test(hours.message), hours.message);
  }
  ok("a fresh backup carries no message to show", stalenessOf(ago(HOUR), NOW).message === "");

  section("Sizes");

  ok("nothing recorded shows a dash, not 0 B", formatBytes(null) === "—" && formatBytes(undefined) === "—");
  ok("a negative size is a dash rather than nonsense", formatBytes(-1) === "—");
  ok("bytes below a kilobyte", formatBytes(512) === "512 B", formatBytes(512));
  ok("kilobytes", formatBytes(2048) === "2.0 KB", formatBytes(2048));
  ok("megabytes — the size a real dump comes out at", formatBytes(1435618) === "1.4 MB", formatBytes(1435618));
  ok("gigabytes", formatBytes(3 * 1024 ** 3) === "3.0 GB", formatBytes(3 * 1024 ** 3));
  ok("three digits drop the decimal", formatBytes(700 * 1024 ** 2) === "700 MB", formatBytes(700 * 1024 ** 2));
  ok("a BigInt size is accepted, as Prisma returns one", formatBytes(BigInt(2048)) === "2.0 KB");

  section("The sidecar");

  const temp = await mkdtemp(path.join(tmpdir(), "wroffy-backup-check-"));
  try {
    const dump = path.join(temp, "wroffy-2026-09-20-120000.dump");
    ok("the sidecar sits beside its dump", sidecarPath(dump) === `${dump}.json`);

    const written = {
      filename: "wroffy-2026-09-20-120000.dump",
      takenAt: NOW.toISOString(),
      schemaVersion: "20260920180000_backups",
      secretFingerprint: secretFingerprint("a-secret")!,
      via: "docker compose (postgres)",
      sizeBytes: 1435618,
      app: "Wroffy ERP",
    };
    await writeSidecar(dump, written);
    const read = await readSidecar(dump);
    ok("every field survives the round trip", JSON.stringify(read) === JSON.stringify(written), JSON.stringify(read));

    ok("a dump with no sidecar reads as null, not a crash", (await readSidecar(path.join(temp, "no-such.dump"))) === null);

    await writeFile(path.join(temp, "broken.dump.json"), "{ this is not json", "utf8");
    ok("unreadable JSON reads as null", (await readSidecar(path.join(temp, "broken.dump"))) === null);

    await writeFile(path.join(temp, "wrong.dump.json"), JSON.stringify({ hello: "world" }), "utf8");
    // Without takenAt there is nothing to check a restore against, which is the same answer as a
    // missing file: this dump cannot be verified.
    ok("the wrong shape reads as null", (await readSidecar(path.join(temp, "wrong.dump"))) === null);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  section("The daily schedule");

  {
    const at2am: Schedule = { enabled: true, hour: 2, minute: 0 };
    const off: Schedule = { enabled: false, hour: 2, minute: 0 };
    /** Local time, because the schedule is local time — see `scheduledTimeOn`. */
    const local = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute, 0, 0);
    const quiet: ScheduleState = { lastSucceededAt: null, lastFailedAt: null, runningSince: null };
    const state = (over: Partial<ScheduleState>): ScheduleState => ({ ...quiet, ...over });

    ok("switched off is never due", !dueNow(off, quiet, local(20, 3)).due);

    {
      const early = dueNow(at2am, state({ lastSucceededAt: local(19, 2, 1) }), local(20, 1, 55));
      ok("before the chosen time, not due", !early.due, early.reason);
    }

    {
      // The minute it comes round, with yesterday's backup on the books.
      const verdict = dueNow(at2am, state({ lastSucceededAt: local(19, 2, 1) }), local(20, 2, 0));
      ok("at the chosen time, due", verdict.due, verdict.reason);
    }

    {
      const verdict = dueNow(at2am, state({ lastSucceededAt: local(20, 2, 1) }), local(20, 2, 5));
      ok("five minutes later, already taken, not due", !verdict.due, verdict.reason);
      // This is the entire double-fire guard, and it is a comparison rather than a lock.
      ok("  and still not due at midday", !dueNow(at2am, state({ lastSucceededAt: local(20, 2, 1) }), local(20, 12)).due);
      ok("  and due again the next morning", dueNow(at2am, state({ lastSucceededAt: local(20, 2, 1) }), local(21, 2)).due);
    }

    {
      /**
       * The case the whole design exists for: the machine was off at 2am. A scheduler that fires
       * *at* 02:00 gives that day no backup and says nothing. This one catches up.
       */
      const verdict = dueNow(at2am, state({ lastSucceededAt: local(19, 2, 1) }), local(20, 9, 30));
      ok("a missed window is caught up, not skipped", verdict.due, verdict.reason);
      ok("  and the reason says so, so the log is readable", /catching up/.test(verdict.reason), verdict.reason);
      ok(
        "  while an on-time run does not claim to be catching up",
        !/catching up/.test(dueNow(at2am, state({ lastSucceededAt: local(19, 2) }), local(20, 2, 3)).reason),
      );
    }

    ok("never backed up at all, past the time — due", dueNow(at2am, quiet, local(20, 3)).due);

    {
      // A backup already running is left alone: two dumps at once means two half-written files.
      const running = state({ runningSince: local(20, 2, 0) });
      ok("not due while one is running", !dueNow(at2am, running, local(20, 2, 3)).due);
      const dead = state({ runningSince: local(19, 2, 0) });
      ok(
        "but a RUNNING row from yesterday is presumed dead, not respected for ever",
        dueNow(at2am, dead, local(20, 3)).due,
        RUNNING_PRESUMED_DEAD_MINUTES + " minute threshold",
      );
    }

    {
      /**
       * Without a retry gap a 02:00 failure is due again at 02:05, and at every knock until
       * midnight — a few hundred failure rows burying the one that explains anything.
       */
      const justFailed = state({ lastFailedAt: local(20, 2, 1) });
      const soon = dueNow(at2am, justFailed, local(20, 2, 6));
      ok("a failure is not retried on the very next knock", !soon.due, soon.reason);
      ok("  and the refusal says how long is left", /more minutes/.test(soon.reason), soon.reason);
      ok(
        "  but it is retried once the gap has passed",
        dueNow(at2am, justFailed, new Date(local(20, 2, 1).getTime() + RETRY_AFTER_MINUTES * 60000 + 1000)).due,
      );
      ok(
        "  and a failure does not block a day that already succeeded after it",
        !dueNow(at2am, state({ lastFailedAt: local(20, 2, 1), lastSucceededAt: local(20, 4) }), local(20, 5)).due,
      );
    }

    {
      // Midnight is the boundary most likely to be got wrong, so it gets its own case.
      const midnight: Schedule = { enabled: true, hour: 0, minute: 0 };
      ok(
        "00:00 is a real time, not a falsy one",
        dueNow(midnight, state({ lastSucceededAt: local(19, 12) }), local(20, 0, 1)).due,
      );
      const lateNight: Schedule = { enabled: true, hour: 23, minute: 30 };
      ok("23:30 is not due at 23:29", !dueNow(lateNight, quiet, local(20, 23, 29)).due);
      ok("  and is at 23:30", dueNow(lateNight, quiet, local(20, 23, 30)).due);
    }

    ok(
      "every refusal carries a reason worth reading",
      [
        dueNow(off, quiet, local(20, 3)),
        dueNow(at2am, quiet, local(20, 1)),
        dueNow(at2am, state({ lastSucceededAt: local(20, 2, 1) }), local(20, 5)),
        dueNow(at2am, state({ runningSince: local(20, 2) }), local(20, 2, 5)),
        dueNow(at2am, state({ lastFailedAt: local(20, 2) }), local(20, 2, 5)),
      ].every((v) => !v.due && v.reason.length > 10),
    );

    section("Next run, and what the page shows");

    ok("today's time if it is still ahead", nextRunAfter(local(20, 1), at2am).getTime() === local(20, 2).getTime());
    ok("tomorrow's if it has passed", nextRunAfter(local(20, 3), at2am).getTime() === local(21, 2).getTime());
    ok("exactly on the minute counts as passed", nextRunAfter(local(20, 2), at2am).getTime() === local(21, 2).getTime());
    ok(
      "rolls over a month end",
      nextRunAfter(new Date(2026, 8, 30, 5), at2am).getTime() === new Date(2026, 9, 1, 2).getTime(),
    );
    ok("scheduledTimeOn zeroes the seconds", scheduledTimeOn(local(20, 9, 47), at2am).getSeconds() === 0);

    section("Reading and writing the time");

    ok("02:00 round-trips", formatTimeOfDay(2, 0) === "02:00" && parseTimeOfDay("02:00")?.hour === 2);
    ok("23:59 is valid", parseTimeOfDay("23:59")?.minute === 59);
    ok("00:00 is valid", parseTimeOfDay("00:00")?.hour === 0);
    ok("a single-digit hour is accepted, as some browsers send it", parseTimeOfDay("2:30")?.hour === 2);
    ok("24:00 is refused", parseTimeOfDay("24:00") === null);
    ok("a 60th minute is refused", parseTimeOfDay("12:60") === null);
    // Not silently defaulted: saving would otherwise report success and run at a time nobody chose.
    ok("nonsense is refused rather than defaulted", parseTimeOfDay("tea time") === null);
    ok("empty is refused", parseTimeOfDay("") === null && parseTimeOfDay(null) === null);
    ok("seconds are refused", parseTimeOfDay("02:00:00") === null);

    ok(
      "an out-of-range row is clamped rather than wedging the schedule",
      (() => {
        const n = normaliseSchedule({ enabled: true, hour: 99, minute: -5 });
        return n.hour === 23 && n.minute === 0;
      })(),
    );
    ok(
      "a missing row normalises to the default, switched off",
      (() => {
        const n = normaliseSchedule(null);
        return !n.enabled && n.hour === 2 && n.minute === 0;
      })(),
    );
    ok("describeSchedule says off when it is off", /off/i.test(describeSchedule(off)));
    ok("and names the time when it is on", describeSchedule(at2am).includes("02:00"), describeSchedule(at2am));
  }

  section("Pruning for real — files and rows together");

  const folder = await mkdtemp(path.join(tmpdir(), "wroffy-backup-prune-"));
  const planted: { filename: string; startedAt: Date; status: "SUCCEEDED" | "FAILED" | "RUNNING" }[] = [
    { filename: "zzcheck-recent-1.dump", startedAt: realAgo(1 * HOUR), status: "SUCCEEDED" },
    { filename: "zzcheck-recent-2.dump", startedAt: realAgo(2 * HOUR), status: "SUCCEEDED" },
    { filename: "zzcheck-recent-3.dump", startedAt: realAgo(3 * HOUR), status: "SUCCEEDED" },
    { filename: "zzcheck-old-1.dump", startedAt: realAgo(400 * DAY), status: "SUCCEEDED" },
    { filename: "zzcheck-old-2.dump", startedAt: realAgo(401 * DAY), status: "SUCCEEDED" },
    { filename: "zzcheck-old-failed.dump", startedAt: realAgo(402 * DAY), status: "FAILED" },
    { filename: "zzcheck-old-running.dump", startedAt: realAgo(403 * DAY), status: "RUNNING" },
  ];

  try {
    await mkdir(folder, { recursive: true });
    for (const row of planted) {
      const dump = path.join(folder, row.filename);
      await writeFile(dump, "PGDMP not really, but a file", "utf8");
      await writeFile(sidecarPath(dump), JSON.stringify({ takenAt: row.startedAt.toISOString() }), "utf8");
      await db.backup.create({
        data: {
          filename: row.filename,
          directory: folder,
          status: row.status,
          startedAt: row.startedAt,
          finishedAt: row.status === "RUNNING" ? null : row.startedAt,
          sizeBytes: row.status === "SUCCEEDED" ? BigInt(1024 * 1024) : null,
          error: row.status === "FAILED" ? "pg_dump exited with code 1." : null,
          via: "check",
        },
      });
    }

    const before = await filesOnDisk(folder);
    ok("the folder listing sees the planted dumps", before.size === planted.length, before.size);
    ok("and ignores the sidecars", ![...before].some((f) => f.endsWith(".json")));

    const pruned = await pruneOldBackups(folder);
    const left = await filesOnDisk(folder);
    const rowsLeft = await db.backup.findMany({ where: { directory: folder }, select: { filename: true } });
    const remaining = [...left].sort().join(",");
    const remainingRows = rowsLeft.map((r) => r.filename).sort().join(",");

    ok("two old successful dumps were deleted", pruned === 2, pruned);
    ok(
      "the recent ones, the failed one and the running one are all still there",
      remaining === "zzcheck-old-failed.dump,zzcheck-old-running.dump,zzcheck-recent-1.dump,zzcheck-recent-2.dump,zzcheck-recent-3.dump",
      remaining,
    );
    // A row without its file is a backup you think you have. A file without its row is one nothing
    // will ever clean up. They go together or not at all.
    ok("the rows match the files exactly", remainingRows === remaining, remainingRows);

    const strays = (await readdir(folder)).filter((f) => f.endsWith(".json") && f.startsWith("zzcheck-old-1"));
    ok("a deleted dump takes its sidecar with it", strays.length === 0, strays.join(","));

    // Running it again must be a no-op rather than eating into what is left.
    const again = await pruneOldBackups(folder);
    ok("pruning twice deletes nothing the second time", again === 0, again);
  } finally {
    await db.backup.deleteMany({ where: { directory: folder } });
    await rm(folder, { recursive: true, force: true });
  }

  section("Runs stuck at RUNNING");

  /**
   * The row is written before pg_dump starts, so every dump contains its own row mid-run. Restore
   * one and that backup is permanently RUNNING — which used to be cosmetic and stopped being so the
   * moment the schedule learned not to start a backup while one is running. A stuck row was then a
   * schedule that had quietly switched itself off.
   *
   * Found by running the thing, not by reading it, which is why it is checked here.
   */
  const stuckFolder = await mkdtemp(path.join(tmpdir(), "wroffy-backup-stuck-"));
  try {
    const finished = path.join(stuckFolder, "zzstuck-finished.dump");
    await writeFile(finished, "x".repeat(4096), "utf8");

    const rows = await db.backup.createManyAndReturn({
      data: [
        // Old, and its file is complete on disk: the dump finished, only the closing write was lost.
        { filename: "zzstuck-finished.dump", directory: stuckFolder, status: "RUNNING", startedAt: realAgo(26 * HOUR) },
        // Old, and nothing on disk: it really did die.
        { filename: "zzstuck-nothing.dump", directory: stuckFolder, status: "RUNNING", startedAt: realAgo(27 * HOUR) },
        // A dump that could genuinely still be going. Must be left alone.
        { filename: "zzstuck-current.dump", directory: stuckFolder, status: "RUNNING", startedAt: realAgo(2 * 60000) },
      ],
      select: { id: true, filename: true },
    });

    const settled = await settleStaleRuns(stuckFolder);
    ok("only the stale ones are settled", settled === 2, settled);

    const after = await db.backup.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      select: { filename: true, status: true, sizeBytes: true, error: true, finishedAt: true },
    });
    const byName = new Map(after.map((r) => [r.filename, r]));

    const complete = byName.get("zzstuck-finished.dump")!;
    ok("a stuck run whose file is complete is recorded as succeeded", complete.status === "SUCCEEDED", complete.status);
    ok("  with the size the file actually is", Number(complete.sizeBytes) === 4096, complete.sizeBytes);
    // From the file's own timestamp, so a run settled a week later does not claim to have finished then.
    ok("  and a finish time, not left null", complete.finishedAt !== null);

    const gone = byName.get("zzstuck-nothing.dump")!;
    ok("a stuck run with no file is recorded as failed", gone.status === "FAILED", gone.status);
    ok("  and says why, rather than leaving an empty error", /[Ii]nterrupted/.test(gone.error ?? ""), gone.error);

    ok("a run that could still be going is untouched", byName.get("zzstuck-current.dump")!.status === "RUNNING");

    // Running it again must be a no-op: settling is reconciliation, not a state machine that churns.
    ok("settling twice settles nothing the second time", (await settleStaleRuns(stuckFolder)) === 0);
  } finally {
    await db.backup.deleteMany({ where: { directory: stuckFolder } });
    await rm(stuckFolder, { recursive: true, force: true });
  }

  section("This machine");

  {
    // Not an assertion about the environment — a CI box with no Postgres client and no Docker is a
    // legitimate place to run the rest of this. But it is worth printing, because "pg_dump could not
    // be found" is a thing to discover now rather than at 2am.
    const tool = await resolveDumpTool("pg_dump");
    ok("pg_dump resolves", true, tool ? tool.via : "not found here — backups would fail on this machine");
  }

  console.log(failures === 0 ? "\nAll backup checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
