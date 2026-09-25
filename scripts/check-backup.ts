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
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
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
import { adoptedKeyBundle, archiveFingerprints, archiveKeyMaterial, keysFromArchive, legacyFingerprint, newKeyBundle, type TenantKeys } from "../src/lib/tenancy/keys";
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
import {
  pruneOldBackups,
  filesOnDisk,
  presentBackups,
  resolveDumpTool,
  settleStaleRuns,
} from "../src/lib/backup/run";
import {
  collectGarbage,
  manifestExists,
  reassemble,
  readManifest,
  storeDump,
  storeSize,
  writeManifest,
} from "../src/lib/backup/chunks";
import { gzipSync } from "node:zlib";
import {
  ARCHIVE_EXTENSION,
  checkPassphrase,
  extractArchive,
  passphraseProblem,
  readArchiveHeader,
  verifyArchiveSignature,
  writeArchive,
} from "../src/lib/backup/archive";

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

/**
 * Compressible, structured, and deterministic — a stand-in for a dump.
 *
 * Not random bytes: random data does not compress, which would make the compression comparison in
 * the chunk section meaningless. Not a real `pg_dump` either, because this suite has to run the
 * same way on a machine where the database holds five rows.
 *
 * The generator is a deterministic xorshift, so this fixture is identical on every machine and
 * every run. A chunker test whose input varies is a test whose failures do not reproduce.
 */
function syntheticDump(rows: number): Buffer {
  const words = ["invoice", "renewal", "autodesk", "kochi", "subscription", "seat", "amc", "gstin", "ledger"];
  let x = 0x2545f491;
  const next = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
  const parts: Buffer[] = [];
  for (let i = 0; i < rows; i++) {
    const filler = Array.from({ length: 12 }, () => words[next() % words.length]).join(" ");
    parts.push(Buffer.from(`${i}\t${next()}\t${filler}\n`, "utf8"));
  }
  return Buffer.concat(parts);
}

/**
 * The same dump with a row inserted near the front, so every byte after it shifts.
 *
 * The shift is the point. It is what tells a content-defined chunker apart from a fixed-size one,
 * and it is what makes two dumps share most of their pieces rather than none.
 */
function withInsertion(dump: Buffer): Buffer {
  const at = Math.floor(dump.length * 0.1);
  return Buffer.concat([dump.subarray(0, at), Buffer.from("an inserted row\n".repeat(200)), dump.subarray(at)]);
}

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

  section("Key fingerprints");

  {
    // The fingerprint backups carried before workspaces: an HMAC under AUTH_SECRET itself. The first
    // workspace's keys still answer to it (src/lib/tenancy/keys.ts), so its older backups match.
    const secret = "a-real-looking-auth-secret-value";
    const fp = legacyFingerprint(secret);
    ok("sixteen hex characters", /^[0-9a-f]{16}$/.test(fp), fp);
    ok("same secret, same fingerprint", fp === legacyFingerprint(secret));
    ok("a different secret gives a different fingerprint", fp !== legacyFingerprint(secret + "!"));
    // The whole point of an HMAC rather than a prefix: this sits in a JSON file next to the dump.
    ok("does not contain the secret", !fp.includes(secret.slice(0, 8)) && !secret.includes(fp));
    // A one-character difference must not survive truncation to 16 chars.
    const near = [legacyFingerprint("secret-1"), legacyFingerprint("secret-2"), legacyFingerprint("secret-3")];
    ok("near-identical secrets stay distinguishable", new Set(near).size === 3, near.join(" "));
  }

  section("Keys carried in an archive");

  {
    // From before workspaces: the archive carried the AUTH_SECRET, and restoring it must give the keys
    // that secret derived — exactly the ones the first workspace adopted.
    const secret = "the-auth-secret-of-an-older-installation";
    const fromLegacy = keysFromArchive(secret);
    const adopted = adoptedKeyBundle(secret);
    ok("an older archive's AUTH_SECRET gives the keys it always derived", fromLegacy.data === adopted.data && fromLegacy.digest === adopted.digest && fromLegacy.tracking === adopted.tracking);
    ok("  and answers to the fingerprint its backups carried", archiveFingerprints(secret).includes(legacyFingerprint(secret)));

    const bundle = newKeyBundle();
    const keys: TenantKeys = {
      dataKey: Buffer.from(bundle.data, "base64"),
      digestKey: Buffer.from(bundle.digest, "base64"),
      trackingKey: Buffer.from(bundle.tracking, "base64"),
      renderKey: Buffer.from(bundle.render, "base64"),
      sessionSecret: bundle.session,
      fingerprint: "unused-here",
      legacyFingerprints: [],
    };
    const material = archiveKeyMaterial(keys);
    ok("a workspace's keys go into an archive and come back", keysFromArchive(material).data === bundle.data && keysFromArchive(material).render === bundle.render);
    ok("  without its sign-in secret — nobody is signed in by a file", !material.includes(bundle.session));
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
      secretFingerprint: legacyFingerprint("a-secret"),
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

  // ── The sealed archive ────────────────────────────────────────────────────────────────────────
  section("The archive somebody downloads and uploads back");

  /**
   * This format exists to fix two failures the `.dump` + `.dump.json` pair could not.
   *
   * The pair travels as two files, and an offsite rule matching `*.dump` drops the sidecar — which
   * is the half that says which key the data was written under. The restore then succeeds and every
   * encrypted column comes back as noise. And the dump is readable: a complete copy of the business
   * in a file whose whole purpose is to be carried somewhere else.
   *
   * So: one sealed file. These assertions are what make that claim true rather than intended —
   * particularly the three refusals, because a backup format that accepts a damaged file is worse
   * than one that accepts nothing.
   */
  {
    const dir = await mkdtemp(path.join(tmpdir(), "wroffy-archive-check-"));
    try {
      const PASS = "correct horse battery staple";
      const SECRET = "the-auth-secret-of-the-source-instance";
      // Over a megabyte, so the body crosses stream chunk boundaries rather than fitting in one.
      const body = Buffer.concat([Buffer.from("PGDMP", "latin1"), randomBytes(1024 * 1024)]);
      const dumpPath = path.join(dir, "source.dump");
      await writeFile(dumpPath, body);

      const archivePath = path.join(dir, `backup${ARCHIVE_EXTENSION}`);
      const takenAt = new Date("2026-09-21T12:00:00.000Z");
      await writeArchive({
        dumpPath,
        outPath: archivePath,
        passphrase: PASS,
        meta: {
          takenAt,
          schemaVersion: "20260921120707_report_window_indexes",
          secretFingerprint: "abc123def456",
          via: "pg_dump (host)",
          includeSecret: SECRET,
          signFor: "zz-workspace-a",
        },
      });

      const header = await readArchiveHeader(archivePath);
      ok("the header reads without the passphrase", header.takenAt === takenAt.toISOString(), header.takenAt);
      ok(
        "  so a folder of these can be told apart before anybody types anything",
        header.schemaVersion === "20260921120707_report_window_indexes" && header.dumpBytes === body.length,
        `schema ${header.schemaVersion}, ${header.dumpBytes} bytes inside`,
      );

      const raw = await readFile(archivePath);
      ok(
        "the sealed AUTH_SECRET is nowhere in the file in the clear",
        !raw.includes(Buffer.from(SECRET, "utf8")),
        "this file is the key to the vault; that is the whole reason it is sealed",
      );
      ok(
        "  and neither is the dump's own content",
        raw.indexOf(body.subarray(100, 200)) === -1,
        "a plaintext run from the middle would mean the body was never encrypted",
      );

      ok("the right passphrase is recognised", checkPassphrase(header, PASS));
      ok(
        "  a near miss is not",
        !checkPassphrase(header, "correct horse battery stapl"),
        "checked against a sealed verifier, so this answers in microseconds rather than after a 40MB stream",
      );

      const outPath = path.join(dir, "restored.dump");
      const extracted = await extractArchive({ archivePath, outDumpPath: outPath, passphrase: PASS });
      ok("the dump comes back byte for byte", (await readFile(outPath)).equals(body), `${body.length} bytes`);

      // ── The platform's signature ────────────────────────────────────────────────────────────
      ok("the platform signed it for the workspace it came from", header.signature?.tenantId === "zz-workspace-a" && (await verifyArchiveSignature(archivePath, "zz-workspace-a")));
      ok("  and for no other — a workspace restores by itself only its own", !(await verifyArchiveSignature(archivePath, "zz-workspace-b")));
      {
        const relabelled = Buffer.from(raw);
        const at = relabelled.indexOf(Buffer.from('"tenantId":"zz-workspace-a"', "utf8"));
        Buffer.from('"tenantId":"zz-workspace-b"', "utf8").copy(relabelled, at);
        const relabelledPath = path.join(dir, `relabelled${ARCHIVE_EXTENSION}`);
        await writeFile(relabelledPath, relabelled);
        ok("  relabelling it for another workspace breaks the signature", at > 0 && !(await verifyArchiveSignature(relabelledPath, "zz-workspace-b")));
      }
      {
        // A version 1 archive — from before signatures — still opens, and is not signed.
        const headerLen = raw.readUInt32BE(9);
        const v1Header = JSON.parse(raw.subarray(13, 13 + headerLen).toString("utf8")) as Record<string, unknown>;
        delete v1Header.signature;
        v1Header.format = 1;
        const v1Json = Buffer.from(JSON.stringify(v1Header), "utf8");
        const v1Preamble = Buffer.from(raw.subarray(0, 13));
        v1Preamble.writeUInt8(1, 8);
        v1Preamble.writeUInt32BE(v1Json.length, 9);
        const v1Path = path.join(dir, `v1${ARCHIVE_EXTENSION}`);
        await writeFile(v1Path, Buffer.concat([v1Preamble, v1Json, raw.subarray(13 + headerLen, raw.length - 32)]));
        const v1Out = path.join(dir, "v1.dump");
        await extractArchive({ archivePath: v1Path, outDumpPath: v1Out, passphrase: PASS });
        ok("an archive from before signatures still opens", (await readFile(v1Out)).equals(body));
        ok("  and counts as unsigned — for the first workspace only", !(await verifyArchiveSignature(v1Path, "zz-workspace-a")));
      }
      ok("  and the sealed secret with it", extracted.secret === SECRET, "this is what lets a restore onto a fresh server keep the vault");

      // ── The three refusals ──────────────────────────────────────────────────────────────────
      const refused = async (label: string, run: () => Promise<unknown>, expected: string) => {
        let name: string | null = null;
        try {
          await run();
        } catch (e) {
          name = (e as Error).name;
        }
        ok(label, name === expected, name ?? "it did not throw");
      };

      await refused(
        "a wrong passphrase is refused",
        () => extractArchive({ archivePath, outDumpPath: path.join(dir, "no.dump"), passphrase: "a different passphrase" }),
        "PassphraseError",
      );
      ok(
        "  leaving no half-written dump behind",
        await stat(path.join(dir, "no.dump")).then(() => false).catch(() => true),
        "a partial file here is one somebody would later try to restore",
      );

      const tampered = Buffer.from(raw);
      tampered[Math.floor(tampered.length / 2)] ^= 0xff;
      const tamperedPath = path.join(dir, `tampered${ARCHIVE_EXTENSION}`);
      await writeFile(tamperedPath, tampered);
      await refused(
        "one flipped byte anywhere in the body is caught",
        () => extractArchive({ archivePath: tamperedPath, outDumpPath: path.join(dir, "t.dump"), passphrase: PASS }),
        "ArchiveFormatError",
      );
      ok("  and by the signature, before any passphrase is typed", !(await verifyArchiveSignature(tamperedPath, "zz-workspace-a")));

      const cutPath = path.join(dir, `cut${ARCHIVE_EXTENSION}`);
      await writeFile(cutPath, raw.subarray(0, raw.length - 5000));
      await refused(
        "a truncated archive is caught — the shape a half-finished upload takes",
        () => extractArchive({ archivePath: cutPath, outDumpPath: path.join(dir, "c.dump"), passphrase: PASS }),
        "ArchiveFormatError",
      );

      let rawDumpMessage = "";
      try {
        await readArchiveHeader(dumpPath);
      } catch (e) {
        rawDumpMessage = (e as Error).message;
      }
      ok(
        "a raw pg_dump is refused by name, not by confusion",
        rawDumpMessage.includes("raw pg_dump"),
        rawDumpMessage || "it did not throw",
      );

      ok("a short passphrase is refused", passphraseProblem("short") !== null);
      await refused(
        "  and by the writer too, not only by the form",
        () =>
          writeArchive({
            dumpPath,
            outPath: path.join(dir, "never.wbak"),
            passphrase: "tooshort",
            meta: { takenAt, schemaVersion: null, secretFingerprint: null, via: null, includeSecret: null, signFor: "zz-workspace-a" },
          }),
        "PassphraseError",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ── Deduplication ─────────────────────────────────────────────────────────────────────────────
  section("Storing the same database many times without storing it many times");

  /**
   * `pg_dump` has no incremental mode, so the saving is made downstream of it: a dump is cut into
   * content-defined chunks, each stored once under the hash of its contents, and a backup is the
   * list of hashes it needs. Two dumps a day apart share nearly every chunk.
   *
   * Three properties make that true rather than hopeful, and each has an assertion here:
   *
   *   1. A change costs only the chunks it touched. Fixed-size chunks would fail this — inserting
   *      one row shifts every later byte, so every downstream chunk would hash differently and an
   *      "incremental" backup would quietly store 100% every time.
   *   2. The dump must be uncompressed. Measured below, and it is not a close call.
   *   3. Deleting one backup must not break the others, because they share their pieces.
   */
  {
    const dir = await mkdtemp(path.join(tmpdir(), "wroffy-chunk-check-"));
    try {
      /**
       * Comfortably past `MAX_CHUNK`, so boundaries are actually exercised.
       *
       * The first version of this fixture was 1.01 MB against a 1 MiB ceiling. It never had to cut,
       * produced exactly one chunk, and every assertion below then passed or failed for a reason
       * that had nothing to do with chunking.
       */
      const first = syntheticDump(40_000);
      const a = path.join(dir, "a.dump");
      await writeFile(a, first);

      const m1 = await storeDump(dir, a);
      await writeManifest(dir, "one", m1);
      ok("a dump splits into chunks", m1.chunks.length > 3, `${m1.chunks.length} chunks from ${first.length} bytes`);
      ok("  and the first one stores every piece", m1.newChunks === m1.chunks.length);

      const back = path.join(dir, "back.dump");
      await reassemble(dir, m1, back);
      ok("it rebuilds byte for byte", (await readFile(back)).equals(first), "a backup that does not come back is not a backup");

      const second = withInsertion(first);
      const b = path.join(dir, "b.dump");
      await writeFile(b, second);

      const m2 = await storeDump(dir, b);
      await writeManifest(dir, "two", m2);
      ok(
        "an insertion makes only the chunks it touched new",
        m2.newChunks <= 2,
        `${m2.newChunks} of ${m2.chunks.length} chunks new — with fixed-size chunks every one after the insertion would be`,
      );
      ok(
        "  and the shifted dump still rebuilds exactly",
        await (async () => {
          const out = path.join(dir, "b-back.dump");
          await reassemble(dir, m2, out);
          return (await readFile(out)).equals(second);
        })(),
      );

      /**
       * The reason `runBackup` dumps chunked backups with `--compress=0`.
       *
       * Both files below are compressed *after* the change, which is the only faithful comparison:
       * a real edit goes through the compressor and everything downstream of it comes out different.
       * Splicing bytes into an already-compressed file instead makes compression look better than
       * uncompressed, which is an artefact of the test rather than a property of the format.
       */
      const czDir = await mkdtemp(path.join(tmpdir(), "wroffy-chunk-cz-"));
      try {
        const ca = path.join(czDir, "a.gz");
        const cb = path.join(czDir, "b.gz");
        await writeFile(ca, gzipSync(first, { level: 6 }));
        await writeFile(cb, gzipSync(second, { level: 6 }));
        const c1 = await storeDump(czDir, ca);
        const c2 = await storeDump(czDir, cb);
        const compressedShare = c2.newBytes / Math.max(c1.newBytes, 1);
        const plainShare = m2.newBytes / Math.max(m1.newBytes, 1);
        ok(
          "a compressed dump deduplicates to nothing, which is why chunked backups are not compressed",
          compressedShare > plainShare * 2,
          `compressed re-stores ${(compressedShare * 100).toFixed(0)}%, uncompressed ${(plainShare * 100).toFixed(0)}% — same change, same chunker`,
        );
      } finally {
        await rm(czDir, { recursive: true, force: true });
      }

      // ── Sharing means deletion is not a local decision ────────────────────────────────────────
      const before = await storeSize(dir);
      const kept = await collectGarbage(dir);
      ok(
        "a sweep removes nothing while both backups are listed",
        kept.removed === 0,
        "every manifest is read before one byte is deleted, because the pieces are shared",
      );

      await rm(path.join(dir, ".manifests", "one.json"));
      const swept = await collectGarbage(dir);
      ok(
        "dropping one backup frees only what nothing else needs",
        swept.removed > 0 && swept.freedBytes < before.bytes,
        `${swept.removed} chunks freed, ${swept.freedBytes} of ${before.bytes} bytes`,
      );

      const survivor = await readManifest(dir, "two");
      ok(
        "  and the backup that stayed still rebuilds",
        await (async () => {
          const out = path.join(dir, "survivor.dump");
          await reassemble(dir, survivor!, out);
          return (await readFile(out)).equals(second);
        })(),
        "this is the assertion that catches a sweep which deletes shared pieces",
      );

      // ── A damaged store is caught before a restore, not during one ────────────────────────────
      const prefixes = await readdir(path.join(dir, ".chunks"));
      const victimDir = path.join(dir, ".chunks", prefixes[0]!);
      await rm(path.join(victimDir, (await readdir(victimDir))[0]!));

      let threw: string | null = null;
      try {
        await reassemble(dir, survivor!, path.join(dir, "nope.dump"));
      } catch (e) {
        threw = (e as Error).name;
      }
      ok("a missing piece is refused rather than restored short", threw !== null, threw ?? "it did not throw");
      ok(
        "  leaving no partial dump behind",
        await stat(path.join(dir, "nope.dump")).then(() => false).catch(() => true),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ── Both kinds in one folder ──────────────────────────────────────────────────────────────────
  section("Pruning and presence once a backup can have no file");

  /**
   * The section above proves the chunk store behaves on its own. This one proves the rest of the
   * module knows it exists.
   *
   * Every part of this feature that was written when a backup *was* a file has a way of being
   * quietly wrong about one that is not. The pruner removes a path that was never written, succeeds,
   * and leaves the manifest behind for ever. The listing screen asks "is the file in the folder"
   * and gets no for a backup that is perfectly restorable. Neither failure raises anything; both are
   * found by somebody trying to restore, which is the worst possible moment.
   *
   * So the fixture below is both kinds in one folder — real `.dump` files, a real manifest over real
   * chunks, real rows — and the real functions are run against it.
   */
  {
    const dir = await mkdtemp(path.join(tmpdir(), "wroffy-backup-wiring-"));
    /**
     * The dumps the chunked backups are made from live outside the backup folder.
     *
     * `runBackup` writes its working copy under a hidden name inside the directory and deletes it
     * the moment the pieces are in the store, so a `.dump` left sitting there would be a file no
     * real run ever leaves — and the `filesOnDisk` counts below would be answering about the
     * fixture rather than about the pruner.
     */
    const work = await mkdtemp(path.join(tmpdir(), "wroffy-backup-wiring-src-"));
    try {
      const older = syntheticDump(20_000);
      const newer = withInsertion(older);

      const rows = await db.backup.createManyAndReturn({
        data: [
          { filename: "zzwire-recent.dump", directory: dir, kind: "FULL", status: "SUCCEEDED", startedAt: realAgo(1 * HOUR), finishedAt: realAgo(1 * HOUR), sizeBytes: BigInt(4096), via: "check" },
          { filename: "zzwire-recent.chunked", directory: dir, kind: "INCREMENTAL", status: "SUCCEEDED", startedAt: realAgo(2 * HOUR), finishedAt: realAgo(2 * HOUR), sizeBytes: BigInt(newer.length), via: "check" },
          { filename: "zzwire-old.dump", directory: dir, kind: "FULL", status: "SUCCEEDED", startedAt: realAgo(400 * DAY), finishedAt: realAgo(400 * DAY), sizeBytes: BigInt(4096), via: "check" },
          { filename: "zzwire-old.chunked", directory: dir, kind: "INCREMENTAL", status: "SUCCEEDED", startedAt: realAgo(401 * DAY), finishedAt: realAgo(401 * DAY), sizeBytes: BigInt(older.length), via: "check" },
        ],
        select: { id: true, filename: true },
      });
      /** The manifest of a chunked backup is named for its row, so the ids are the fixture. */
      const idOf = (filename: string) => rows.find((r) => r.filename === filename)!.id;

      for (const name of ["zzwire-recent.dump", "zzwire-old.dump"]) {
        const dump = path.join(dir, name);
        await writeFile(dump, "PGDMP not really, but a file", "utf8");
        await writeFile(sidecarPath(dump), JSON.stringify({ takenAt: NOW.toISOString() }), "utf8");
      }

      // Stored oldest first, the order real runs happen in, so the second manifest's `newChunks` is
      // the number a real incremental run would have reported and the guard below is measuring the
      // thing it claims to. What matters either way is that the two overlap: pruning a backup whose
      // pieces nothing else holds could not tell a correct sweep from a destructive one.
      const olderSource = path.join(work, "older.dump");
      await writeFile(olderSource, older);
      await writeManifest(dir, idOf("zzwire-old.chunked"), await storeDump(dir, olderSource));

      const newerSource = path.join(work, "newer.dump");
      await writeFile(newerSource, newer);
      const newerManifest = await storeDump(dir, newerSource);
      await writeManifest(dir, idOf("zzwire-recent.chunked"), newerManifest);
      ok(
        "the two chunked backups really do share pieces",
        newerManifest.newChunks < newerManifest.chunks.length,
        `${newerManifest.newChunks} of ${newerManifest.chunks.length} chunks new — without sharing, the sweep below would prove nothing`,
      );

      ok(
        "a chunked backup has no file of its own to delete",
        await stat(path.join(dir, "zzwire-old.chunked")).then(() => false).catch(() => true),
        "which is exactly how a pruner that only knows how to rm one reports success and removes nothing",
      );

      const storeBefore = await storeSize(dir);
      const pruned = await pruneOldBackups(dir, { keepDays: DEFAULT_KEEP_DAYS, keepMinimum: 2 });
      ok("both kinds age out under the one retention rule", pruned === 2, pruned);

      const left = await filesOnDisk(dir);
      ok("the old FULL backup's file went, the recent one stayed", !left.has("zzwire-old.dump") && left.has("zzwire-recent.dump"), [...left].sort().join(","));
      ok(
        "the old chunked backup's manifest went instead",
        !(await manifestExists(dir, idOf("zzwire-old.chunked"))),
        "a manifest outliving its row is a backup gone from the log and still pinning its chunks in the store, where nothing will ever free them",
      );
      ok("  and the surviving chunked backup's manifest did not", await manifestExists(dir, idOf("zzwire-recent.chunked")));

      const rowsLeft = await db.backup.findMany({ where: { directory: dir }, select: { filename: true } });
      const remainingRows = rowsLeft.map((r) => r.filename).sort().join(",");
      ok("the rows went with the data, whichever kind", remainingRows === "zzwire-recent.chunked,zzwire-recent.dump", remainingRows);

      const storeAfter = await storeSize(dir);
      const survivor = await readManifest(dir, idOf("zzwire-recent.chunked"));
      ok(
        "the sweep that follows the prune frees what the pruned backup alone needed",
        storeAfter.chunks < storeBefore.chunks && storeAfter.bytes < storeBefore.bytes,
        `${storeBefore.chunks} chunks before, ${storeAfter.chunks} after`,
      );
      ok(
        "  and keeps exactly what the surviving manifest names — no more, no less",
        !!survivor && storeAfter.chunks === new Set(survivor.chunks).size,
        `${storeAfter.chunks} left, ${survivor ? new Set(survivor.chunks).size : "no manifest"} named`,
      );

      /**
       * The assertion standing between this feature and its catastrophic version.
       *
       * Deleting "this backup's chunks" as the backup is pruned reads as the obvious thing to do and
       * is the one thing that must never happen: the pieces are shared, so it takes them out from
       * under every other backup that named them — most of them. Nothing throws, nothing is logged,
       * the settings page looks identical, and it is discovered at a restore. The only order that
       * cannot do it is the one here: drop the doomed manifest first, then sweep whatever the
       * survivors no longer name. So the survivor is rebuilt rather than merely listed.
       */
      ok(
        "and the backup that stayed rebuilds byte for byte afterwards",
        await (async () => {
          if (!survivor) return false;
          const out = path.join(work, "survivor.dump");
          await reassemble(dir, survivor, out);
          return (await readFile(out)).equals(newer);
        })(),
        `${newer.length} bytes back out of a store that has just been pruned and swept`,
      );

      // ── What the screen is allowed to offer ─────────────────────────────────────────────────────
      /**
       * `presentBackups` decides whether a row gets a Download and a Restore button, and it has to
       * ask a different question per kind: a FULL backup *is* its file, a chunked one is its
       * manifest. Both directions are checked, and the absent one is the one that matters — a row
       * wrongly reported present is a restore offered for data that is not there, which fails after
       * the schema has already been dropped.
       */
      const listed: { id: string; filename: string; kind: "FULL" | "INCREMENTAL" }[] = [
        { id: idOf("zzwire-recent.dump"), filename: "zzwire-recent.dump", kind: "FULL" },
        { id: idOf("zzwire-old.dump"), filename: "zzwire-old.dump", kind: "FULL" },
        { id: idOf("zzwire-recent.chunked"), filename: "zzwire-recent.chunked", kind: "INCREMENTAL" },
        { id: idOf("zzwire-old.chunked"), filename: "zzwire-old.chunked", kind: "INCREMENTAL" },
      ];
      const present = await presentBackups(dir, listed);

      ok("a FULL backup whose file is in the folder is present", present.has(idOf("zzwire-recent.dump")));
      ok(
        "a chunked backup is present on its manifest, not on a file that was never written",
        present.has(idOf("zzwire-recent.chunked")),
        "asking `is the .dump there` hides every chunked backup in the list, restorable or not",
      );
      ok(
        "a FULL backup whose file has gone is not present",
        !present.has(idOf("zzwire-old.dump")),
        "the row survives a hand-deleted file; the button must not",
      );
      ok("a chunked backup whose manifest has gone is not present", !present.has(idOf("zzwire-old.chunked")));
      ok("and nothing else crept into the answer", present.size === 2, present.size);

      /**
       * The backup folder on a mount that has gone away.
       *
       * This is asked once for a whole page of rows, so it has to come back empty rather than throw.
       * "Nothing is restorable right now" is a page somebody can act on; a stack trace on the
       * settings screen is not.
       */
      const moved = await presentBackups(path.join(dir, "not-here"), listed);
      ok("a backup folder that is not there reports nothing present, rather than throwing", moved.size === 0, moved.size);
    } finally {
      await db.backup.deleteMany({ where: { directory: dir } });
      await rm(dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
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
