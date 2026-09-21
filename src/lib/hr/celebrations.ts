import type { CelebrationAudience, CelebrationKind } from "@prisma/client";

/**
 * What to put on somebody's screen today, and — more importantly — what not to.
 *
 * Pure, so the rules can be tested without a database. Two decisions run through all of it:
 *
 * Most occasions are *derived*. A birthday is on the employee record and a festival is on the
 * holiday calendar; re-entering them as celebration rows would guarantee the two drift, and the
 * first time somebody corrected a date of birth without remembering to fix the greeting, the app
 * would wish them a happy birthday on the wrong day. So birthdays, anniversaries and holidays are
 * computed from the records that already exist, and only the things nobody can compute — an
 * achievement, a written festival greeting — are stored.
 *
 * And every occasion has a stable `key`. That key is what a dismissal is recorded against, which is
 * why it must be derivable rather than random: the same birthday computed tomorrow must produce the
 * same key, or the greeting comes back after somebody has closed it.
 */

export type MomentTone = "birthday" | "anniversary" | "festival" | "achievement" | "milestone" | "welcome" | "announcement";

export type Moment = {
  /** Stable across renders and days — a dismissal is stored against this. */
  key: string;
  tone: MomentTone;
  title: string;
  message: string | null;
  /** Whose occasion it is, when it is about a person. */
  subject: { id: string; name: string; designation: string | null } | null;
  /** True when the person seeing it is the person it is about. */
  aboutViewer: boolean;
  imageDataUrl: string | null;
  accent: string | null;
  /**
   * Whether this interrupts the screen or merely sits in the greeting strip. Somebody else's
   * birthday is worth knowing; it is not worth a modal.
   */
  splash: boolean;
};

export type PersonForCelebration = {
  userId: string;
  name: string;
  designation: string | null;
  dateOfBirth: Date | null;
  joinedOn: Date | null;
  departmentId: string | null;
};

export type StoredCelebration = {
  id: string;
  kind: CelebrationKind;
  audience: CelebrationAudience;
  title: string;
  message: string | null;
  imageDataUrl: string | null;
  accent: string | null;
  subjectUserId: string | null;
  departmentId: string | null;
  startsOn: Date;
  endsOn: Date;
  subject?: { id: string; name: string } | null;
};

export type HolidayForCelebration = { id: string; name: string; date: Date; optional: boolean };

const toneOfKind: Record<CelebrationKind, MomentTone> = {
  ACHIEVEMENT: "achievement",
  FESTIVAL: "festival",
  MILESTONE: "milestone",
  WELCOME: "welcome",
  ANNOUNCEMENT: "announcement",
};

/** UTC day-of-year comparison — every date in this app is stored as a UTC date-only value. */
function sameDayOfYear(a: Date, month: number, day: number) {
  return a.getUTCMonth() + 1 === month && a.getUTCDate() === day;
}

function ordinal(n: number) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * Whether a stored celebration is meant for this viewer.
 *
 * A PERSON celebration is shown to its subject *and* to nobody else, which is what makes it usable
 * for something private like a personal note; an achievement meant for the whole company is posted
 * to EVERYONE instead.
 */
export function celebrationReaches(
  c: Pick<StoredCelebration, "audience" | "subjectUserId" | "departmentId">,
  viewer: { userId: string; departmentId: string | null },
) {
  if (c.audience === "PERSON") return c.subjectUserId === viewer.userId;
  if (c.audience === "DEPARTMENT") return !!c.departmentId && c.departmentId === viewer.departmentId;
  return true;
}

export function celebrationKey(id: string) {
  return `celebration:${id}`;
}
export function birthdayKey(userId: string, year: number) {
  return `birthday:${userId}:${year}`;
}
export function anniversaryKey(userId: string, year: number) {
  return `anniversary:${userId}:${year}`;
}
export function holidayKey(id: string, year: number) {
  return `holiday:${id}:${year}`;
}

/**
 * Everything happening today for one viewer, most personal first.
 *
 * The ordering is the whole user experience: their own birthday before a colleague's, a colleague's
 * before a festival, and a festival before an announcement. Somebody who opens the app on their
 * birthday and a public holiday should be wished a happy birthday first.
 */
export function momentsFor(input: {
  today: Date;
  viewer: { userId: string; departmentId: string | null };
  people: PersonForCelebration[];
  holidays: HolidayForCelebration[];
  celebrations: StoredCelebration[];
  /** Occasion keys this person has already dismissed. */
  seen: string[];
}): Moment[] {
  const { today, viewer, people, holidays, celebrations } = input;
  const seen = new Set(input.seen);
  const month = today.getUTCMonth() + 1;
  const day = today.getUTCDate();
  const year = today.getUTCFullYear();
  const out: Moment[] = [];

  for (const p of people) {
    if (p.dateOfBirth && sameDayOfYear(p.dateOfBirth, month, day)) {
      const mine = p.userId === viewer.userId;
      out.push({
        key: birthdayKey(p.userId, year),
        tone: "birthday",
        title: mine ? "Happy birthday!" : `It's ${p.name}'s birthday`,
        message: mine ? "From everyone here. Have a good one." : p.designation,
        subject: { id: p.userId, name: p.name, designation: p.designation },
        aboutViewer: mine,
        imageDataUrl: null,
        accent: null,
        // A colleague's birthday belongs in the strip, not across the screen — the person whose
        // birthday it is gets the splash.
        splash: mine,
      });
    }

    // An anniversary needs a completed year. "0 years today" on somebody's first-day anniversary
    // is worse than saying nothing.
    if (p.joinedOn && sameDayOfYear(p.joinedOn, month, day)) {
      const years = year - p.joinedOn.getUTCFullYear();
      if (years >= 1) {
        const mine = p.userId === viewer.userId;
        out.push({
          key: anniversaryKey(p.userId, year),
          tone: "anniversary",
          title: mine
            ? `${ordinal(years)} year here today`
            : `${p.name} — ${years} year${years === 1 ? "" : "s"} today`,
          message: mine ? "Thank you for the last " + (years === 1 ? "year." : `${years} years.`) : p.designation,
          subject: { id: p.userId, name: p.name, designation: p.designation },
          aboutViewer: mine,
          imageDataUrl: null,
          accent: null,
          splash: mine,
        });
      }
    }
  }

  // Their own occasions first, then colleagues'.
  out.sort((a, b) => Number(b.aboutViewer) - Number(a.aboutViewer));

  for (const c of celebrations) {
    if (!celebrationReaches(c, viewer)) continue;
    if (c.startsOn > today || c.endsOn < today) continue;
    out.push({
      key: celebrationKey(c.id),
      tone: toneOfKind[c.kind],
      title: c.title,
      message: c.message,
      subject: c.subject ? { id: c.subject.id, name: c.subject.name, designation: null } : null,
      aboutViewer: c.subjectUserId === viewer.userId,
      imageDataUrl: c.imageDataUrl,
      accent: c.accent,
      // Somebody wrote this on purpose for today, so it is worth the interruption.
      splash: true,
    });
  }

  for (const h of holidays) {
    if (!sameDayOfYear(h.date, month, day)) continue;
    out.push({
      key: holidayKey(h.id, year),
      tone: "festival",
      title: h.name,
      // Restricted holidays are opt-in leave, so the office is open — saying it is closed would
      // simply be untrue, and people plan around this sentence.
      message: h.optional ? "A restricted holiday — the office is open, but you may take it." : "The office is closed today.",
      subject: null,
      aboutViewer: false,
      imageDataUrl: null,
      accent: null,
      splash: false,
    });
  }

  return out.filter((m) => !seen.has(m.key));
}

/** The one-line greeting above the dashboard, which is not an occasion and never interrupts. */
export function greeting(now: Date, firstName: string) {
  // Local hours: this is about whether it is morning where the person is sitting, and everybody
  // using this app sits in one country.
  const hour = now.getHours();
  const part = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return `${part}, ${firstName}`;
}
