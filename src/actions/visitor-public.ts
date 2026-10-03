"use server";

import type { VisitorPurpose } from "@prisma/client";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { notifyUser } from "@/lib/notify";
import { checkUpload } from "@/lib/hr/document-upload";
import { toPlain } from "@/lib/serialize";
import { isWithinWindow, lookupThrottle, looksLikeCode, normaliseCode } from "@/lib/visitors/invite-code";
import { workspaceClock } from "@/lib/time/workspace";
import {
  MAX_COMPANY_RESULTS,
  MIN_COMPANY_QUERY,
  emailRequiredFor,
  isUsableCompany,
  looksLikeEmail,
  normaliseCompany,
} from "@/lib/visitors/company-name";

/**
 * The reception tablet.
 *
 * ## No session, by design
 *
 * Nothing here calls `requireUser`. A receptionist will not sign in for every visitor, and a shared
 * account left permanently signed in on a device in a lobby is worse than no account at all — it is
 * a real identity with real permissions sitting unattended on a table.
 *
 * So the token in the URL is the whole of the authentication: 192 bits, the same arrangement the
 * feedback and preference links already use. Everything in this file therefore assumes it is being
 * called by a stranger, and is written accordingly:
 *
 *   · a bad token and a deactivated kiosk give the same answer, so the endpoint cannot be used to
 *     work out which tokens exist;
 *   · the directory it returns is names and departments only — no email, no phone, no designation,
 *     nothing about customers;
 *   · check-ins are rate limited per kiosk, because the one thing a stranger with the URL could
 *     otherwise do is send a colleague four hundred notifications;
 *   · the arrival time is taken here, not accepted from the form. A self-reported arrival time is
 *     not a record of anything.
 *
 * ## What a leaked URL exposes
 *
 * The staff list, by name and department. That is a genuine disclosure and the reason the token can
 * be rotated in one click from Settings. It is the unavoidable cost of letting a visitor say who
 * they are here to see without a receptionist typing it for them.
 */

async function liveKiosk(token: string) {
  if (!token || token.length < 16) return null;
  // Outside the plan, or switched off: the same as a tablet that was never set up.
  if (!(await moduleAvailableForTenant("visitors"))) return null;
  return db.visitorKiosk.findFirst({
    where: { token, active: true },
    // The failure counters come back with every kiosk, because every path that takes a code needs
    // them — see `checkInWithInvite`, where one of them did not have them and so did not throttle.
    select: { id: true, name: true, failedLookups: true, failedSince: true },
  });
}

/** What the tablet needs to draw its form. Deliberately thin. */
export async function kioskDirectory(token: string) {
  const kiosk = await liveKiosk(token);
  if (!kiosk) return null;

  const [departments, people] = await Promise.all([
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.user.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      // Name and department. Nothing else leaves the building.
      select: { id: true, name: true, departmentId: true },
    }),
  ]);

  return toPlain({ kioskId: kiosk.id, kioskName: kiosk.name, departments, people });
}

/** A minute's worth of check-ins from one tablet. Generous for a desk, useless for a flood. */
const MAX_PER_MINUTE = 6;

export type CheckInInput = {
  token: string;
  purpose: VisitorPurpose;
  hostUserId?: string;
  departmentId?: string;
  name: string;
  phone: string;
  company?: string;
  email?: string;
  note?: string;
  photoDataUrl?: string;
  /**
   * The tablet could not offer a camera at all — no device, or permission refused.
   *
   * Not a way to skip the photo: the form has no skip button, and this is only ever set when
   * getUserMedia actually failed. It exists because the alternative to degrading here is a queue
   * in the lobby every time a webcam driver misbehaves, and the entry records that it happened.
   */
  photoUnavailable?: boolean;
  companions?: { name: string }[];
};

export async function checkIn(
  input: CheckInInput,
): Promise<{ ok: true; badgeNo: number; hostName: string | null } | { ok: false; error: string }> {
  const kiosk = await liveKiosk(input.token);
  // The same answer as a deactivated kiosk and a mistyped URL.
  if (!kiosk) return { ok: false, error: "This tablet isn't set up. Please ask at the desk." };

  const name = input.name.trim();
  const phone = input.phone.trim();
  if (name.length < 2) return { ok: false, error: "Please enter your name." };
  if (phone.replace(/\D/g, "").length < 7) return { ok: false, error: "Please enter a phone number we can reach you on." };
  if (!input.hostUserId && !input.departmentId) return { ok: false, error: "Please choose who you're here to see." };

  // Company, email and a photo are required for a walk-in. Enforced here and not only in the form,
  // because the form is a page served to a device in a lobby and the server is the only thing that
  // actually decides.
  if (!isUsableCompany(input.company ?? "")) {
    return { ok: false, error: "Please enter the company you're from." };
  }
  // Required of everybody except a courier — see emailRequiredFor. An address that was given
  // is still checked, so a driver who volunteers one cannot type nonsense into the field.
  const email = (input.email ?? "").trim();
  if (emailRequiredFor(input.purpose) && !looksLikeEmail(email)) {
    return { ok: false, error: "Please enter an email address we can reach you on." };
  }
  if (email && !looksLikeEmail(email)) {
    return { ok: false, error: "That email address doesn't look right." };
  }
  if (!input.photoDataUrl && !input.photoUnavailable) {
    return { ok: false, error: "A photo is needed to sign in. Please ask at the desk if the camera isn't working." };
  }

  const now = new Date();
  const recent = await db.visitorEntry.count({
    where: { kioskId: kiosk.id, checkedInAt: { gt: new Date(now.getTime() - 60_000) } },
  });
  if (recent >= MAX_PER_MINUTE) {
    return { ok: false, error: "Too many sign-ins just now. Please wait a moment and try again." };
  }

  if (input.photoDataUrl) {
    const check = checkUpload({ name, fileDataUrl: input.photoDataUrl, mimeType: "image/jpeg" });
    if (!check.ok) return { ok: false, error: "That photo didn't save. Try again, or skip it." };
  }

  // A badge number that restarts each day. Unique enough for a lanyard, and not a running total of
  // how many people have ever visited.
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayCount = await db.visitorEntry.count({ where: { checkedInAt: { gte: startOfDay } } });

  const host = input.hostUserId
    ? await db.user.findFirst({ where: { id: input.hostUserId, active: true }, select: { id: true, name: true } })
    : null;
  // A host id that does not resolve is dropped rather than refused: the visitor is standing at a
  // desk and should not be made to debug a stale directory. The department still routes it.
  const departmentId =
    input.departmentId ??
    (host ? (await db.user.findUnique({ where: { id: host.id }, select: { departmentId: true } }))?.departmentId ?? null : null);

  const visitorCompany = await resolveVisitorCompany(input.company ?? "");

  const entry = await db.visitorEntry.create({
    data: {
      kioskId: kiosk.id,
      purpose: input.purpose,
      visitorCompanyId: visitorCompany?.id ?? null,
      hostUserId: host?.id ?? null,
      departmentId,
      name,
      phone,
      company: input.company?.trim() || null,
      email: input.email?.trim() || null,
      // A note saying the camera was out, so an entry with no photo is explained rather than
      // looking like somebody skipped a step that cannot be skipped.
      note: [
        input.note?.trim(),
        input.photoUnavailable && !input.photoDataUrl ? "No photo — camera unavailable at the desk" : null,
      ].filter(Boolean).join(" · ") || null,
      photoDataUrl: input.photoDataUrl || null,
      checkedInAt: now,
      badgeNo: todayCount + 1,
      companions: {
        create: (input.companions ?? [])
          .map((c) => c.name.trim())
          .filter(Boolean)
          .slice(0, 10)
          .map((n) => ({ name: n })),
      },
    },
    select: { id: true, badgeNo: true },
  });

  await db.visitorKiosk.update({ where: { id: kiosk.id }, data: { lastUsedAt: now } });

  // The point of the whole module: somebody is standing in the lobby and the person they came to
  // see does not know. Told directly when there is a host, and to the department otherwise.
  if (host) {
    await notifyUser({
      userId: host.id,
      type: "VISITOR_ARRIVED",
      title: `${name} is at ${kiosk.name}`,
      message: [input.company?.trim(), input.purpose === "INTERVIEW" ? "Interview" : null, phone]
        .filter(Boolean)
        .join(" · "),
      link: "/visitors",
    });
  } else if (departmentId) {
    const team = await db.user.findMany({ where: { active: true, departmentId }, select: { id: true } });
    await Promise.all(
      team.map((u) =>
        notifyUser({
          userId: u.id,
          type: "VISITOR_ARRIVED",
          title: `${name} is at ${kiosk.name} for your team`,
          message: [input.company?.trim(), phone].filter(Boolean).join(" · "),
          link: "/visitors",
        }),
      ),
    );
  }

  return { ok: true, badgeNo: entry.badgeNo ?? 0, hostName: host?.name ?? null };
}

/**
 * Companies a visitor might be from, as they type.
 *
 * Reads `VisitorCompany`, never `Company` — see that model's comment. Even so it is
 * bounded three ways: two characters minimum, eight results, and no code path that returns the
 * whole list. Somebody determined to enumerate it would need thousands of requests against a desk
 * that already rate limits, for a list of vendors and previous visitors rather than our customers.
 *
 * Most-visited first, so the firms that actually keep coming are the ones at the top.
 */
export async function searchVisitorCompanies(
  token: string,
  query: string,
): Promise<{ id: string; name: string }[]> {
  const kiosk = await liveKiosk(token);
  if (!kiosk) return [];

  const q = query.trim();
  if (q.length < MIN_COMPANY_QUERY) return [];

  return db.visitorCompany.findMany({
    where: { active: true, name: { contains: q, mode: "insensitive" } },
    orderBy: [{ visitCount: "desc" }, { name: "asc" }],
    take: MAX_COMPANY_RESULTS,
    select: { id: true, name: true },
  });
}

/**
 * The row a typed company name belongs to, creating it if this is the first time.
 *
 * Matched on the normalised form, so "Acme Ltd." finds the existing "acme" row rather than adding
 * a fourth spelling. The display name of an existing row is left alone — the first spelling wins,
 * because letting each visitor rewrite it means the name changes every week.
 */
async function resolveVisitorCompany(typed: string): Promise<{ id: string; name: string } | null> {
  const name = typed.trim();
  if (!isUsableCompany(name)) return null;
  const normalizedName = normaliseCompany(name);

  const existing = await db.visitorCompany.findUnique({
    where: { normalizedName },
    select: { id: true, name: true },
  });
  if (existing) {
    await db.visitorCompany.update({
      where: { id: existing.id },
      data: { visitCount: { increment: 1 }, lastSeenAt: new Date() },
    });
    return existing;
  }

  try {
    return await db.visitorCompany.create({
      data: { name, normalizedName, source: "VISITOR", visitCount: 1, lastSeenAt: new Date() },
      select: { id: true, name: true },
    });
  } catch {
    // Two visitors from the same new company signing in at once. Whoever lost re-reads the winner.
    return db.visitorCompany.findUnique({ where: { normalizedName }, select: { id: true, name: true } });
  }
}
// ─── Pre-registered visitors ────────────────────────────────────────────────────────────────────

/**
 * Looking up an invite code at the desk.
 *
 * This is the riskiest endpoint in the module: it is unauthenticated, it takes a short secret, and
 * a successful answer contains a person's name. Three things bound it, and none of them is
 * sufficient alone:
 *
 *   1. the code is eight characters from a 31-letter alphabet — about 10^12;
 *   2. it only resolves on the day it is for, plus the following morning, so the live keyspace at
 *      any moment is one day's invitations rather than every invitation ever issued;
 *   3. wrong codes are counted per desk and the desk stops answering after eight in ten minutes.
 *
 * What comes back is the minimum needed to say "is this you?" — the visitor's name and who they are
 * seeing. Not their phone number, not their email, not the note the host wrote about the meeting.
 */
export async function lookupInvite(
  token: string,
  code: string,
): Promise<{ ok: true; name: string; hostName: string; purpose: VisitorPurpose; expectedCompanions: number } | { ok: false; error: string }> {
  const kiosk = await liveKiosk(token);
  if (!kiosk) return { ok: false, error: "This tablet isn't set up. Please ask at the desk." };

  const now = new Date();
  const throttle = lookupThrottle(kiosk, now);
  if (throttle.lockedOut) {
    return { ok: false, error: "Too many wrong codes. Please ask at the desk." };
  }

  // Rejected before the database is asked, so a malformed guess costs nothing and still counts.
  const cleaned = normaliseCode(code);
  const invite = looksLikeCode(cleaned)
    ? await db.visitorInvite.findFirst({
        where: { code: cleaned, status: "PENDING" },
        select: {
          id: true, name: true, purpose: true, expectedAt: true, expectedCompanions: true,
          host: { select: { name: true } },
        },
      })
    : null;

  // A code that does not exist, one for next week, and one already used all give the same answer.
  // Distinguishing them would turn this into an oracle for which codes are real.
  if (!invite || !isWithinWindow(invite.expectedAt, now, await workspaceClock())) {
    await db.visitorKiosk.update({
      where: { id: kiosk.id },
      data: { failedLookups: throttle.nextCount, failedSince: throttle.windowStart },
    });
    return { ok: false, error: "We can't find that code. Please sign in below, or ask at the desk." };
  }

  // A correct code clears the counter: a desk where somebody is genuinely arriving is not a desk
  // being probed, and a visitor after a colleague's typo should not be locked out.
  await db.visitorKiosk.update({ where: { id: kiosk.id }, data: { failedLookups: 0, failedSince: null } });

  return {
    ok: true,
    name: invite.name,
    hostName: invite.host.name,
    purpose: invite.purpose,
    expectedCompanions: invite.expectedCompanions,
  };
}

/**
 * Signing in with an invite.
 *
 * Re-checks the code rather than trusting whatever the previous screen decided: the lookup and this
 * are two separate requests from a device in a lobby, and only one of them is the one that writes.
 */
export async function checkInWithInvite(input: {
  token: string;
  code: string;
  photoDataUrl?: string;
  photoUnavailable?: boolean;
  companions?: { name: string }[];
}): Promise<{ ok: true; badgeNo: number; hostName: string | null } | { ok: false; error: string }> {
  const kiosk = await liveKiosk(input.token);
  if (!kiosk) return { ok: false, error: "This tablet isn't set up. Please ask at the desk." };

  const now = new Date();

  /**
   * The same eight-in-ten-minutes limit the lookup has, because this takes the same code.
   *
   * `lookupInvite` was throttled and this was not, which made the throttle decorative: a guesser
   * simply skipped the read-only screen and hammered the one that **writes**. A hit here does not
   * merely confirm that a code is real — it signs that visitor in, prints a badge, notifies the host
   * and burns the invite, so the cheaper endpoint to attack was also the damaging one.
   *
   * Counted against the desk rather than the caller, matching `lookupInvite`: the tablet is the
   * thing being abused, and a lobby has one of them.
   */
  const throttle = lookupThrottle(kiosk, now);
  if (throttle.lockedOut) {
    return { ok: false, error: "Too many wrong codes. Please ask at the desk." };
  }

  const cleaned = normaliseCode(input.code);
  const invite = looksLikeCode(cleaned)
    ? await db.visitorInvite.findFirst({
        where: { code: cleaned, status: "PENDING" },
        select: {
          id: true, name: true, phone: true, email: true, company: true, note: true,
          purpose: true, expectedAt: true, hostUserId: true,
          host: { select: { id: true, name: true, departmentId: true } },
        },
      })
    : null;
  if (!invite || !isWithinWindow(invite.expectedAt, now, await workspaceClock())) {
    await db.visitorKiosk.update({
      where: { id: kiosk.id },
      data: { failedLookups: throttle.nextCount, failedSince: throttle.windowStart },
    });
    return { ok: false, error: "We can't find that code. Please sign in below, or ask at the desk." };
  }

  // A real arrival clears the counter, exactly as it does on the lookup.
  await db.visitorKiosk.update({ where: { id: kiosk.id }, data: { failedLookups: 0, failedSince: null } });

  if (!input.photoDataUrl && !input.photoUnavailable) {
    return { ok: false, error: "A photo is needed to sign in. Please ask at the desk if the camera isn't working." };
  }
  if (input.photoDataUrl) {
    const check = checkUpload({ name: invite.name, fileDataUrl: input.photoDataUrl, mimeType: "image/jpeg" });
    if (!check.ok) return { ok: false, error: "That photo didn't save. Please try again." };
  }

  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayCount = await db.visitorEntry.count({ where: { checkedInAt: { gte: startOfDay } } });

  // The list learns from invited visitors too, so a firm that keeps being invited is offered to
  // the next walk-in who works there.
  const invitedCompany = invite.company ? await resolveVisitorCompany(invite.company) : null;

  // One transaction, so an invite can never be consumed without producing a visit — nor a visit
  // created from an invite that stays PENDING and can be used again.
  const entry = await db.$transaction(async (tx) => {
    const created = await tx.visitorEntry.create({
      data: {
        kioskId: kiosk.id,
        purpose: invite.purpose,
        visitorCompanyId: invitedCompany?.id ?? null,
        hostUserId: invite.host.id,
        departmentId: invite.host.departmentId,
        name: invite.name,
        // A pre-registered visitor gave these to their host, not to the tablet.
        phone: invite.phone ?? "—",
        company: invite.company,
        email: invite.email,
        note: invite.note,
        photoDataUrl: input.photoDataUrl || null,
        checkedInAt: now,
        badgeNo: todayCount + 1,
        companions: {
          create: (input.companions ?? [])
            .map((c) => c.name.trim())
            .filter(Boolean)
            .slice(0, 10)
            .map((n) => ({ name: n })),
        },
      },
      select: { id: true, badgeNo: true },
    });

    await tx.visitorInvite.update({
      where: { id: invite.id },
      data: { status: "ARRIVED", entryId: created.id },
    });
    return created;
  });

  await db.visitorKiosk.update({ where: { id: kiosk.id }, data: { lastUsedAt: now } });

  await notifyUser({
    userId: invite.host.id,
    type: "VISITOR_ARRIVED",
    title: `${invite.name} has arrived at ${kiosk.name}`,
    message: [invite.company, "You were expecting them"].filter(Boolean).join(" · "),
    link: "/visitors",
  });

  return { ok: true, badgeNo: entry.badgeNo ?? 0, hostName: invite.host.name };
}
