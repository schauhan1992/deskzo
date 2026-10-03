/**
 * The rules that decide what appears on somebody's screen.
 *
 * Worth checking rather than eyeballing, because every one of these is a way to embarrass the
 * company at scale: wishing somebody a happy birthday on the wrong day, telling a new joiner they
 * have been here zero years, showing a private note to the whole office, or bringing a greeting
 * back after the person closed it.
 *
 *   npm run check:celebrations
 */

import {
  anniversaryKey,
  birthdayKey,
  celebrationKey,
  celebrationReaches,
  greeting,
  holidayKey,
  momentsFor,
  type HolidayForCelebration,
  type PersonForCelebration,
  type StoredCelebration,
} from "../src/lib/hr/celebrations";
import { clockFor, indiaClock } from "../src/lib/time/zone";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | null | undefined = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const TODAY = d("2026-09-18");

const alice: PersonForCelebration = {
  userId: "u-alice",
  name: "Alice Kumar",
  designation: "Account Executive",
  dateOfBirth: d("1994-09-18"),
  joinedOn: d("2023-09-18"),
  departmentId: "d-sales",
};
const bob: PersonForCelebration = {
  userId: "u-bob",
  name: "Bob Nair",
  designation: "Support Engineer",
  dateOfBirth: d("1990-09-18"),
  joinedOn: d("2026-09-18"), // joined today — no anniversary yet
  departmentId: "d-support",
};
const carol: PersonForCelebration = {
  userId: "u-carol",
  name: "Carol Shah",
  designation: "Accountant",
  dateOfBirth: d("1988-03-04"),
  joinedOn: d("2020-01-06"),
  departmentId: "d-accounts",
};

const viewerAlice = { userId: "u-alice", departmentId: "d-sales" };
const viewerCarol = { userId: "u-carol", departmentId: "d-accounts" };

const base = { today: TODAY, people: [alice, bob, carol], holidays: [], celebrations: [], seen: [] };

console.log("\n— Celebrations —\n");

// ── Whose day it is ─────────────────────────────────────────────────────────

const forAlice = momentsFor({ ...base, viewer: viewerAlice });
const aliceBirthday = forAlice.find((m) => m.key === birthdayKey("u-alice", 2026));
ok("your own birthday is found", !!aliceBirthday, aliceBirthday?.title);
ok("and it interrupts you", aliceBirthday?.splash === true, "a splash, not a chip");
ok("it is addressed to you", aliceBirthday?.title === "Happy birthday!", aliceBirthday?.title);

const bobBirthdayForAlice = forAlice.find((m) => m.key === birthdayKey("u-bob", 2026));
ok("a colleague's birthday is found", !!bobBirthdayForAlice, bobBirthdayForAlice?.title);
ok(
  "but it does NOT interrupt you",
  bobBirthdayForAlice?.splash === false,
  "somebody else's birthday belongs in the strip",
);

ok(
  "your own occasions come first",
  forAlice[0]?.aboutViewer === true,
  `first is "${forAlice[0]?.title}"`,
);

// Carol's birthday is in March. Today is September.
const carolBirthday = forAlice.find((m) => m.key === birthdayKey("u-carol", 2026));
ok("a birthday on another date is not announced", !carolBirthday, "March is not September");

// ── Anniversaries ───────────────────────────────────────────────────────────

const aliceAnniversary = forAlice.find((m) => m.key === anniversaryKey("u-alice", 2026));
ok("a completed year is announced", !!aliceAnniversary, aliceAnniversary?.title);
ok("and counts correctly", !!aliceAnniversary?.title.includes("3rd"), aliceAnniversary?.title);

const bobAnniversary = forAlice.find((m) => m.key === anniversaryKey("u-bob", 2026));
ok(
  "somebody who joined today gets no anniversary",
  !bobAnniversary,
  "\"0 years today\" is worse than saying nothing",
);

// ── Ordinals, because "1th year" would be seen by everyone ──────────────────

const ordinalCases: [number, string][] = [
  [1, "1st"],
  [2, "2nd"],
  [3, "3rd"],
  [4, "4th"],
  [11, "11th"],
  [12, "12th"],
  [13, "13th"],
  [21, "21st"],
  [22, "22nd"],
];
for (const [years, expected] of ordinalCases) {
  const person = {
    ...alice,
    userId: "u-ord",
    name: "Ord Test",
    dateOfBirth: null,
    joinedOn: d(`${2026 - years}-09-18`),
  };
  const m = momentsFor({
    ...base,
    people: [person],
    viewer: { userId: "u-ord", departmentId: null },
  }).find((x) => x.key === anniversaryKey("u-ord", 2026));
  ok(`${years} years reads "${expected}"`, !!m?.title.startsWith(expected), m?.title);
}

// ── Audiences ───────────────────────────────────────────────────────────────

const privateNote: StoredCelebration = {
  id: "c-private",
  kind: "ACHIEVEMENT",
  audience: "PERSON",
  title: "Well done on the Acme renewal",
  message: null,
  imageDataUrl: null,
  accent: null,
  subjectUserId: "u-carol",
  departmentId: null,
  startsOn: TODAY,
  endsOn: TODAY,
};
const teamNote: StoredCelebration = {
  ...privateNote,
  id: "c-team",
  audience: "DEPARTMENT",
  subjectUserId: null,
  departmentId: "d-support",
  title: "Support cleared every ticket",
};
const everyone: StoredCelebration = {
  ...privateNote,
  id: "c-all",
  audience: "EVERYONE",
  subjectUserId: null,
  departmentId: null,
  title: "We crossed 500 customers",
};

ok("a private note reaches its subject", celebrationReaches(privateNote, viewerCarol));
ok("and nobody else", !celebrationReaches(privateNote, viewerAlice), "not even an admin's colleague");
ok("a team note reaches that team", celebrationReaches(teamNote, { userId: "u-bob", departmentId: "d-support" }));
ok("and not another team", !celebrationReaches(teamNote, viewerAlice));
ok("an everyone note reaches everyone", celebrationReaches(everyone, viewerAlice));

// A department celebration with no department set must not leak to everybody.
ok(
  "a team note with no team set reaches nobody",
  !celebrationReaches({ ...teamNote, departmentId: null }, viewerAlice),
  "a missing audience is not 'everyone'",
);

// ── Windows ─────────────────────────────────────────────────────────────────

const past = { ...everyone, id: "c-past", startsOn: d("2026-09-01"), endsOn: d("2026-09-17") };
const future = { ...everyone, id: "c-future", startsOn: d("2026-09-19"), endsOn: d("2026-09-30") };
const spanning = { ...everyone, id: "c-span", startsOn: d("2026-09-15"), endsOn: d("2026-09-20") };

const windowed = momentsFor({ ...base, viewer: viewerAlice, celebrations: [past, future, spanning] });
ok("a finished celebration does not show", !windowed.some((m) => m.key === celebrationKey("c-past")));
ok("one that hasn't started does not show", !windowed.some((m) => m.key === celebrationKey("c-future")));
ok("one spanning today does show", windowed.some((m) => m.key === celebrationKey("c-span")));
ok(
  "a written celebration interrupts",
  windowed.find((m) => m.key === celebrationKey("c-span"))?.splash === true,
  "somebody wrote it for today on purpose",
);

// ── Holidays ────────────────────────────────────────────────────────────────

const holidays: HolidayForCelebration[] = [
  { id: "h-diwali", name: "Diwali", date: d("2026-09-18"), optional: false },
  { id: "h-restricted", name: "Restricted holiday", date: d("2026-09-18"), optional: true },
  { id: "h-other", name: "Republic Day", date: d("2026-01-26"), optional: false },
];
const withHolidays = momentsFor({ ...base, viewer: viewerAlice, holidays });
const diwali = withHolidays.find((m) => m.key === holidayKey("h-diwali", 2026));
const restricted = withHolidays.find((m) => m.key === holidayKey("h-restricted", 2026));
ok("today's holiday shows", !!diwali, diwali?.title);
ok("a holiday on another date does not", !withHolidays.some((m) => m.key === holidayKey("h-other", 2026)));
ok("a full holiday says the office is closed", !!diwali?.message?.includes("closed"), diwali?.message);
ok(
  "a restricted holiday does NOT say the office is closed",
  !restricted?.message?.includes("closed") && !!restricted?.message?.includes("open"),
  restricted?.message,
);
ok("a holiday never interrupts", diwali?.splash === false, "it is on the calendar, not a surprise");

// ── Dismissal ───────────────────────────────────────────────────────────────

const dismissed = momentsFor({
  ...base,
  viewer: viewerAlice,
  holidays,
  celebrations: [spanning],
  seen: [birthdayKey("u-alice", 2026), celebrationKey("c-span")],
});
ok("a dismissed birthday stays gone", !dismissed.some((m) => m.key === birthdayKey("u-alice", 2026)));
ok("a dismissed celebration stays gone", !dismissed.some((m) => m.key === celebrationKey("c-span")));
ok(
  "but everything else still shows",
  dismissed.some((m) => m.key === anniversaryKey("u-alice", 2026)),
  "dismissing one occasion is not dismissing the day",
);

// The key must be reproducible, or a dismissal never sticks.
const first = momentsFor({ ...base, viewer: viewerAlice }).map((m) => m.key);
const second = momentsFor({ ...base, viewer: viewerAlice }).map((m) => m.key);
ok("keys are stable across renders", JSON.stringify(first) === JSON.stringify(second), `${first.length} key(s)`);

const nextYear = momentsFor({ ...base, today: d("2027-09-18"), viewer: viewerAlice }).map((m) => m.key);
ok(
  "and carry the year, so next year's birthday is a new occasion",
  nextYear.includes(birthdayKey("u-alice", 2027)) && !nextYear.includes(birthdayKey("u-alice", 2026)),
);

// ── Exited and inactive people ──────────────────────────────────────────────
//
// The query filters these out, so this checks the shape the engine is given rather than the engine
// itself — an empty roster must simply produce no occasions, not throw.
const nobody = momentsFor({ ...base, people: [], viewer: viewerAlice });
ok("an empty roster produces nothing", nobody.length === 0);

// ── The greeting ────────────────────────────────────────────────────────────

// The hour where the workspace is — India's here — whatever zone this machine keeps.
const at = (h: number) => indiaClock.at(2026, 8, 18, h, 0);
ok("early morning", greeting(at(3), "Alice", indiaClock).startsWith("Working late"), greeting(at(3), "Alice", indiaClock));
ok("morning", greeting(at(9), "Alice", indiaClock).startsWith("Good morning"), greeting(at(9), "Alice", indiaClock));
ok("afternoon", greeting(at(14), "Alice", indiaClock).startsWith("Good afternoon"), greeting(at(14), "Alice", indiaClock));
ok("evening", greeting(at(20), "Alice", indiaClock).startsWith("Good evening"), greeting(at(20), "Alice", indiaClock));
ok("it uses the first name", greeting(at(9), "Alice", indiaClock).endsWith("Alice"));
ok(
  "it is the workspace's hour: 9 am in India is still the evening before in New York",
  greeting(at(9), "Alice", clockFor("America/New_York")).startsWith("Good evening"),
  greeting(at(9), "Alice", clockFor("America/New_York")),
);

console.log(failures === 0 ? "\nAll celebration checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
