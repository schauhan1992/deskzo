"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import type { VisitorPurpose } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import { notifyUser } from "@/lib/notify";
import { generateCode } from "@/lib/visitors/invite-code";
import { isUsableCompany, normaliseCompany } from "@/lib/visitors/company-name";
import type { ActionResult } from "@/actions/company";

/**
 * The visitor book, and the tablets that write it.
 *
 * Reading it is gated on `visitors.view`; setting up a tablet is gated separately, because handing
 * somebody a URL that lists every employee is a different decision from letting them see who came
 * in today.
 */

/** 192 bits, base64url — the same size as the feedback and preference links. */
const TOKEN_BYTES = 24;

async function access(userId: string) {
  const [view, manage] = await Promise.all([
    hasEffectivePermission(userId, "visitors.view"),
    hasEffectivePermission(userId, "visitors.manage"),
  ]);
  return { view, manage };
}

export async function listVisitors(filters?: { onDate?: string; status?: "IN" | "OUT" | "ALL" }) {
  const user = await requireModuleUser("visitors");
  const { view } = await access(user.id);
  if (!view) return null;

  const day = filters?.onDate ? new Date(`${filters.onDate}T00:00:00.000Z`) : null;
  const from = day ?? new Date(Date.now() - 7 * 86400000);
  const to = day ? new Date(day.getTime() + 86400000) : new Date(Date.now() + 86400000);

  return toPlain(
    await db.visitorEntry.findMany({
      where: {
        checkedInAt: { gte: from, lt: to },
        ...(filters?.status && filters.status !== "ALL" ? { status: filters.status } : {}),
      },
      orderBy: { checkedInAt: "desc" },
      select: {
        id: true, purpose: true, name: true, phone: true, company: true, email: true, note: true,
        photoDataUrl: true, checkedInAt: true, checkedOutAt: true, status: true, badgeNo: true,
        host: { select: { id: true, name: true } },
        department: { select: { name: true } },
        kiosk: { select: { name: true } },
        companions: { select: { id: true, name: true } },
      },
    }),
  );
}

/** Who is in the building right now — the list a fire marshal wants. */
export async function visitorsOnSite() {
  const user = await requireModuleUser("visitors");
  const { view } = await access(user.id);
  if (!view) return null;
  return toPlain(
    await db.visitorEntry.findMany({
      where: { status: "IN" },
      orderBy: { checkedInAt: "asc" },
      select: {
        id: true, name: true, company: true, badgeNo: true, checkedInAt: true,
        host: { select: { name: true } }, kiosk: { select: { name: true } },
      },
    }),
  );
}

export async function checkOut(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("visitors");
  const { view } = await access(user.id);
  if (!view) return { ok: false, error: "You can't see the visitor book." };

  const entry = await db.visitorEntry.findUnique({ where: { id }, select: { name: true, status: true } });
  if (!entry) return { ok: false, error: "That entry no longer exists." };
  if (entry.status !== "IN") return { ok: false, error: `${entry.name} is already signed out.` };

  await db.visitorEntry.update({
    where: { id },
    data: { checkedOutAt: new Date(), status: "OUT", closedById: user.id },
  });
  revalidatePath("/visitors");
  return { ok: true, data: null };
}

// ─── Kiosks ─────────────────────────────────────────────────────────────────────────────────────

export async function listKiosks() {
  const user = await requireModuleUser("visitors");
  const { manage } = await access(user.id);
  if (!manage) return null;
  return toPlain(
    await db.visitorKiosk.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, token: true, active: true, lastUsedAt: true, createdAt: true,
        _count: { select: { entries: true } },
      },
    }),
  );
}

export async function saveKiosk(input: { id?: string; name: string; active?: boolean }): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("visitors");
  const { manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't set up reception tablets." };

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name the desk — it appears on the tablet and on every entry." };

  const saved = input.id
    ? await db.visitorKiosk.update({ where: { id: input.id }, data: { name, active: input.active ?? true }, select: { id: true } })
    : await db.visitorKiosk.create({
        data: { name, token: randomBytes(TOKEN_BYTES).toString("base64url"), createdById: user.id },
        select: { id: true },
      });

  await recordAudit({
    userId: user.id, action: input.id ? "UPDATE" : "CREATE", entityType: "VisitorKiosk",
    entityId: saved.id, entityLabel: name,
  });
  revalidatePath("/visitors/kiosks");
  return { ok: true, data: saved };
}

/**
 * A new URL for a desk.
 *
 * The old one stops working immediately, which is the point — a kiosk link is a standing grant of
 * the staff directory to whoever holds it, and the only remedy for a link that has gone somewhere
 * unexpected is a new link. The tablet has to be re-opened afterwards, and the screen says so.
 */
export async function rotateKioskToken(id: string): Promise<ActionResult<{ token: string }>> {
  const user = await requireModuleUser("visitors");
  const { manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't set up reception tablets." };

  const kiosk = await db.visitorKiosk.findUnique({ where: { id }, select: { name: true } });
  if (!kiosk) return { ok: false, error: "That tablet no longer exists." };

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  await db.visitorKiosk.update({ where: { id }, data: { token } });
  await recordAudit({
    userId: user.id, action: "UPDATE", entityType: "VisitorKiosk", entityId: id,
    entityLabel: `${kiosk.name} — link rotated, the old one stopped working`,
  });
  revalidatePath("/visitors/kiosks");
  return { ok: true, data: { token } };
}

export async function deleteKiosk(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("visitors");
  const { manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't set up reception tablets." };
  const kiosk = await db.visitorKiosk.findUnique({ where: { id }, select: { name: true, _count: { select: { entries: true } } } });
  if (!kiosk) return { ok: false, error: "That tablet no longer exists." };
  if (kiosk._count.entries > 0) {
    // The entries carry which desk took them, and that is part of the record.
    return { ok: false, error: `${kiosk._count.entries} visitors signed in here. Deactivate it instead.` };
  }
  await db.visitorKiosk.delete({ where: { id } });
  revalidatePath("/visitors/kiosks");
  return { ok: true, data: null };
}

/**
 * Close out everybody still signed in from before today.
 *
 * Visitors forget to sign out. Left alone, "who is in the building" silently becomes a list of
 * everybody who has ever visited, and the one moment it matters is the one moment it is wrong.
 * Marked ABANDONED rather than OUT, because nobody actually saw them leave.
 */
export async function closeStaleVisits(): Promise<ActionResult<{ closed: number }>> {
  const user = await requireModuleUser("visitors");
  const { view } = await access(user.id);
  if (!view) return { ok: false, error: "You can't see the visitor book." };

  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const { count } = await db.visitorEntry.updateMany({
    where: { status: "IN", checkedInAt: { lt: startOfToday } },
    data: { status: "ABANDONED", checkedOutAt: now, closedById: user.id },
  });
  revalidatePath("/visitors");
  return { ok: true, data: { closed: count } };
}

// ─── Pre-registration ───────────────────────────────────────────────────────────────────────────

/**
 * Inviting somebody in advance.
 *
 * Anybody signed in can invite a visitor for themselves — it is not gated on `visitors.view`,
 * because inviting somebody to see you is not the same as reading the building's visitor book, and
 * requiring the second to do the first would mean nobody used it.
 *
 * Inviting on somebody *else's* behalf is allowed and the host is told, which is the arrangement an
 * assistant booking for their manager actually needs.
 */
export async function createInvite(input: {
  hostUserId?: string;
  purpose?: VisitorPurpose;
  name: string;
  phone?: string;
  email?: string;
  company?: string;
  note?: string;
  /** Local datetime from the form, e.g. "2026-09-22T14:30". */
  expectedAt: string;
  expectedCompanions?: number;
}): Promise<ActionResult<{ id: string; code: string }>> {
  const user = await requireModuleUser("visitors");

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Who are you expecting?" };
  if (!input.expectedAt) return { ok: false, error: "When are they coming?" };

  const expectedAt = new Date(input.expectedAt);
  if (Number.isNaN(expectedAt.getTime())) return { ok: false, error: "That date doesn't look right." };

  const hostUserId = input.hostUserId || user.id;
  const host = await db.user.findFirst({ where: { id: hostUserId, active: true }, select: { id: true, name: true } });
  if (!host) return { ok: false, error: "That host isn't an active user." };

  // Retried on collision: the code is random rather than sequential, and a unique index turning a
  // one-in-a-trillion clash into an error beats two visitors sharing a code.
  let created: { id: string; code: string } | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      created = await db.visitorInvite.create({
        data: {
          code: generateCode(),
          purpose: input.purpose ?? "MEETING",
          hostUserId: host.id,
          name,
          phone: input.phone?.trim() || null,
          email: input.email?.trim() || null,
          company: input.company?.trim() || null,
          note: input.note?.trim() || null,
          expectedAt,
          expectedCompanions: Math.max(0, Math.min(20, input.expectedCompanions ?? 0)),
          createdById: user.id,
        },
        select: { id: true, code: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }
  if (!created) return { ok: false, error: "Couldn't allocate a code. Try again." };

  if (host.id !== user.id) {
    await notifyUser({
      userId: host.id,
      type: "VISITOR_EXPECTED",
      title: `${user.name} booked a visitor for you`,
      message: `${name} — ${expectedAt.toDateString()}`,
      link: "/visitors/expected",
    });
  }

  await recordAudit({
    userId: user.id, action: "CREATE", entityType: "VisitorInvite",
    entityId: created.id, entityLabel: `${name} for ${host.name}`,
  });
  revalidatePath("/visitors/expected");
  return { ok: true, data: created };
}

/**
 * Invites somebody may see.
 *
 * Their own by default. Reception — anybody with `visitors.view` — sees everybody's, because
 * knowing who is expected today is the whole job of a front desk.
 */
export async function listInvites(filters?: { mine?: boolean; upcomingOnly?: boolean }) {
  const user = await requireModuleUser("visitors");
  const { view } = await access(user.id);
  const mineOnly = filters?.mine ?? !view;

  const since = new Date(Date.now() - 2 * 86400000);
  return toPlain(
    await db.visitorInvite.findMany({
      where: {
        ...(mineOnly ? { OR: [{ hostUserId: user.id }, { createdById: user.id }] } : {}),
        ...(filters?.upcomingOnly ? { status: "PENDING", expectedAt: { gte: since } } : {}),
      },
      orderBy: { expectedAt: "asc" },
      select: {
        id: true, code: true, purpose: true, name: true, phone: true, email: true, company: true,
        note: true, expectedAt: true, expectedCompanions: true, status: true,
        host: { select: { id: true, name: true } },
        createdBy: { select: { name: true } },
        entry: { select: { id: true, checkedInAt: true } },
      },
    }),
  );
}

export async function cancelInvite(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("visitors");
  const { view } = await access(user.id);
  const invite = await db.visitorInvite.findUnique({
    where: { id },
    select: { id: true, name: true, status: true, hostUserId: true, createdById: true },
  });
  if (!invite) return { ok: false, error: "That invitation no longer exists." };
  // The host, whoever booked it, or reception.
  if (!view && invite.hostUserId !== user.id && invite.createdById !== user.id) {
    return { ok: false, error: "That isn't your invitation." };
  }
  if (invite.status === "ARRIVED") return { ok: false, error: `${invite.name} has already arrived.` };

  await db.visitorInvite.update({ where: { id }, data: { status: "CANCELLED" } });
  await recordAudit({
    userId: user.id, action: "UPDATE", entityType: "VisitorInvite", entityId: id,
    entityLabel: `Cancelled — ${invite.name}`,
  });
  revalidatePath("/visitors/expected");
  return { ok: true, data: null };
}

/**
 * Close off invitations for days that have passed.
 *
 * Without this, "expected today" slowly becomes every visitor who was ever booked and did not turn
 * up — and a live code stays live. Run from the expected-visitors screen, and by the notification
 * sweep if one is wired to it later.
 */
export async function expireStaleInvites(): Promise<ActionResult<{ expired: number }>> {
  await requireModuleUser("visitors");
  // The same 36-hour window the code itself honours, so nothing is expired while it still works.
  const cutoff = new Date(Date.now() - 36 * 3600_000);
  const { count } = await db.visitorInvite.updateMany({
    where: { status: "PENDING", expectedAt: { lt: cutoff } },
    data: { status: "EXPIRED" },
  });
  revalidatePath("/visitors/expected");
  return { ok: true, data: { expired: count } };
}

// ─── The visitor-company list ───────────────────────────────────────────────────────────────────

export async function listVisitorCompanies() {
  const user = await requireModuleUser("visitors");
  const { manage } = await access(user.id);
  if (!manage) return null;
  return toPlain(
    await db.visitorCompany.findMany({
      orderBy: [{ visitCount: "desc" }, { name: "asc" }],
      select: {
        id: true, name: true, source: true, visitCount: true, lastSeenAt: true, active: true,
        _count: { select: { entries: true } },
      },
    }),
  );
}

/**
 * Bring our own vendors across so the list is not empty on day one.
 *
 * Vendors, OEMs and distributors only — never customers. A reception tablet that can be typed into
 * by anybody must not become a way to read the client book, which is the whole reason this list
 * exists separately from `Company` in the first place.
 *
 * Re-runnable. Matching is on the normalised name, so a vendor already typed by a visitor is
 * adopted rather than duplicated, and running it twice adds nothing the second time.
 */
export async function importVendorCompanies(): Promise<ActionResult<{ added: number; adopted: number }>> {
  const user = await requireModuleUser("visitors");
  const { manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't manage the visitor company list." };

  const vendors = await db.company.findMany({
    where: { relationshipType: { in: ["VENDOR", "OEM", "DISTRIBUTOR"] } },
    select: { id: true, name: true },
  });

  let added = 0;
  let adopted = 0;
  for (const vendor of vendors) {
    const normalizedName = normaliseCompany(vendor.name);
    if (normalizedName.length < 2) continue;

    const existing = await db.visitorCompany.findUnique({ where: { normalizedName }, select: { id: true, companyId: true } });
    if (existing) {
      // Already here because a visitor typed it. Linked back and relabelled, so the desk sees the
      // spelling we use rather than whatever the first visitor typed.
      if (!existing.companyId) {
        await db.visitorCompany.update({
          where: { id: existing.id },
          data: { companyId: vendor.id, source: "VENDOR", name: vendor.name },
        });
        adopted += 1;
      }
      continue;
    }
    await db.visitorCompany.create({
      data: { name: vendor.name, normalizedName, source: "VENDOR", companyId: vendor.id },
    });
    added += 1;
  }

  await recordAudit({
    userId: user.id, action: "CREATE", entityType: "VisitorCompany", entityId: "import",
    entityLabel: `Brought ${added} vendors across, adopted ${adopted}`,
  });
  revalidatePath("/visitors/companies");
  return { ok: true, data: { added, adopted } };
}

export async function saveVisitorCompany(input: {
  id?: string;
  name: string;
  active?: boolean;
}): Promise<ActionResult<null>> {
  const user = await requireModuleUser("visitors");
  const { manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't manage the visitor company list." };

  const name = input.name.trim();
  if (!isUsableCompany(name)) return { ok: false, error: "That's too short to be a company name." };
  const normalizedName = normaliseCompany(name);

  try {
    if (input.id) {
      await db.visitorCompany.update({
        where: { id: input.id },
        data: { name, normalizedName, active: input.active ?? true },
      });
    } else {
      await db.visitorCompany.create({ data: { name, normalizedName, source: "MANUAL" } });
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "There's already an entry for that company." };
    }
    throw err;
  }
  revalidatePath("/visitors/companies");
  return { ok: true, data: null };
}

/**
 * Fold one company into another.
 *
 * The one thing a list that grows by itself eventually needs. Entries are re-pointed rather than
 * edited, so the text each visitor actually typed survives on their own record — what changes is
 * which row the desk offers next time.
 */
export async function mergeVisitorCompanies(fromId: string, intoId: string): Promise<ActionResult<{ moved: number }>> {
  const user = await requireModuleUser("visitors");
  const { manage } = await access(user.id);
  if (!manage) return { ok: false, error: "You can't manage the visitor company list." };
  if (fromId === intoId) return { ok: false, error: "That's the same company." };

  const [from, into] = await Promise.all([
    db.visitorCompany.findUnique({ where: { id: fromId }, select: { name: true, visitCount: true } }),
    db.visitorCompany.findUnique({ where: { id: intoId }, select: { name: true } }),
  ]);
  if (!from || !into) return { ok: false, error: "One of those no longer exists." };

  const moved = await db.$transaction(async (tx) => {
    const { count } = await tx.visitorEntry.updateMany({
      where: { visitorCompanyId: fromId },
      data: { visitorCompanyId: intoId },
    });
    await tx.visitorCompany.update({
      where: { id: intoId },
      data: { visitCount: { increment: from.visitCount } },
    });
    await tx.visitorCompany.delete({ where: { id: fromId } });
    return count;
  });

  await recordAudit({
    userId: user.id, action: "UPDATE", entityType: "VisitorCompany", entityId: intoId,
    entityLabel: `Merged ${from.name} into ${into.name}`,
  });
  revalidatePath("/visitors/companies");
  return { ok: true, data: { moved } };
}
