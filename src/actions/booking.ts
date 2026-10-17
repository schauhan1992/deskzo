"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { moduleAvailableForTenant, requireModuleUser } from "@/lib/modules-access";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { leadStages } from "@/lib/pipeline/server";
import { possibleHosts } from "@/lib/booking/server";
import { BOOKING_LIMITS, DURATIONS, checkBookingPage, parseHours, type WeekHours } from "@/lib/booking/rules";
import type { ActionResult } from "@/actions/company";

/**
 * Booking pages (owner, 14 Oct 2026): the pages customers book meetings on — their address, hours, who
 * they meet and for how long (src/lib/booking). Part of the "booking" module; making and changing them is
 * `booking.manage`. A booking itself is made on the public page (src/actions/booking-public.ts).
 */

async function manager() {
  const user = await requireModuleUser("booking");
  return (await can(user.id, "booking.manage")) ? user : null;
}

const NOT_ALLOWED = "You can't change booking pages.";
const NOT_READY = "This workspace is still being updated. Try again in a minute.";

function refresh() {
  revalidatePath("/booking-pages");
}

export type ManagedBookingPage = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  durationMinutes: number;
  hostUserIds: string[];
  hours: WeekHours;
  daysAhead: number;
  minNoticeHours: number;
  bufferMinutes: number;
  online: boolean;
  pipelineId: string | null;
  active: boolean;
  upcoming: number;
};

export type BookingRow = { id: string; page: string; host: string; name: string; email: string; companyName: string | null; startsAt: Date; status: "CONFIRMED" | "CANCELLED"; leadId: string | null };

/** The pages, who can host, the pipelines a booking may open a lead in, the coming bookings and the address pages live under. */
export async function listBookingPages(): Promise<{
  pages: ManagedBookingPage[];
  hosts: { id: string; name: string }[];
  pipelines: { id: string; name: string }[];
  bookings: BookingRow[];
  origin: string;
  ready: boolean;
} | null> {
  if (!(await manager())) return null;
  const [hosts, pipeline, origin, leads] = await Promise.all([possibleHosts(), leadStages(), tenantOrigin(), moduleAvailableForTenant("leads")]);
  // A booking opens a lead only where the plan has leads (owner, 14 Oct 2026); with none, no pipeline to choose.
  const pipelines = leads ? pipeline.pipelines.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })) : [];
  try {
    const now = new Date();
    const [rows, upcoming, bookings] = await Promise.all([
      db.bookingPage.findMany({ orderBy: { createdAt: "asc" } }),
      db.booking.groupBy({ by: ["pageId"], where: { status: "CONFIRMED", startsAt: { gte: now } }, _count: { _all: true } }),
      db.booking.findMany({
        where: { startsAt: { gte: new Date(now.getTime() - 86_400_000) } },
        orderBy: { startsAt: "asc" },
        take: 50,
        select: { id: true, name: true, email: true, companyName: true, startsAt: true, status: true, leadId: true, page: { select: { title: true } }, host: { select: { name: true } } },
      }),
    ]);
    return {
      ready: true,
      hosts,
      pipelines,
      origin,
      pages: rows.map((r) => {
        const hours = parseHours(r.hours);
        return {
          id: r.id,
          slug: r.slug,
          title: r.title,
          description: r.description,
          durationMinutes: r.durationMinutes,
          hostUserIds: r.hostUserIds,
          hours: hours.ok ? hours.hours : { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] },
          daysAhead: r.daysAhead,
          minNoticeHours: r.minNoticeHours,
          bufferMinutes: r.bufferMinutes,
          online: r.online,
          pipelineId: r.pipelineId,
          active: r.active,
          upcoming: upcoming.find((u) => u.pageId === r.id)?._count._all ?? 0,
        };
      }),
      bookings: bookings.map((b) => ({ id: b.id, page: b.page.title, host: b.host.name, name: b.name, email: b.email, companyName: b.companyName, startsAt: b.startsAt, status: b.status, leadId: b.leadId })),
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ready: false, hosts, pipelines, origin, pages: [], bookings: [] };
    throw err;
  }
}

const pageSchema = z.object({
  id: z.string().min(1).optional(),
  slug: z.string().trim().toLowerCase(),
  title: z.string().trim().max(BOOKING_LIMITS.title),
  description: z.string().trim().max(BOOKING_LIMITS.description).default(""),
  durationMinutes: z.number().int(),
  hostUserIds: z.array(z.string().min(1)).max(BOOKING_LIMITS.hosts),
  hours: z.unknown(),
  daysAhead: z.number().int(),
  minNoticeHours: z.number().int(),
  bufferMinutes: z.number().int(),
  online: z.boolean(),
  pipelineId: z.string().min(1).nullable(),
  active: z.boolean().default(true),
});

/** Adds a booking page or changes one. Its address must be free, its hosts able to host, its pipeline in use. */
export async function saveBookingPage(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const parsed = pageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the page." };
  const data = parsed.data;
  const problem = checkBookingPage({ ...data, description: data.description });
  if (problem) return { ok: false, error: problem };
  if (!(DURATIONS as readonly number[]).includes(data.durationMinutes)) return { ok: false, error: "Choose how long a meeting is." };
  const hours = parseHours(data.hours);
  if (!hours.ok) return { ok: false, error: hours.error };
  const able = new Set((await possibleHosts()).map((h) => h.id));
  if (data.hostUserIds.some((id) => !able.has(id))) return { ok: false, error: "Each host must be somebody here who is active and has an email address." };
  const pipeline = await leadStages();
  if (data.pipelineId && !pipeline.pipelines.some((p) => p.id === data.pipelineId && !p.archived)) return { ok: false, error: "That pipeline is no longer in use." };

  const fields = {
    slug: data.slug,
    title: data.title,
    description: data.description || null,
    durationMinutes: data.durationMinutes,
    hostUserIds: data.hostUserIds,
    hours: hours.hours,
    daysAhead: data.daysAhead,
    minNoticeHours: data.minNoticeHours,
    bufferMinutes: data.bufferMinutes,
    online: data.online,
    pipelineId: data.pipelineId,
    active: data.active,
  };
  try {
    const taken = await db.bookingPage.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (taken && taken.id !== data.id) return { ok: false, error: `The address ${data.slug} is taken. Choose another.` };
    if (data.id && !(await db.bookingPage.findUnique({ where: { id: data.id }, select: { id: true } }))) return { ok: false, error: "That page no longer exists." };
    const saved = data.id
      ? await db.bookingPage.update({ where: { id: data.id }, data: fields, select: { id: true } })
      : await db.bookingPage.create({ data: { ...fields, createdById: user.id }, select: { id: true } });
    await recordAudit({ userId: user.id, action: data.id ? "UPDATE" : "CREATE", entityType: "BookingPage", entityId: saved.id, entityLabel: `Booking page ${data.title} (/book/${data.slug})${data.active ? "" : " — off"}` });
    refresh();
    return { ok: true, data: { id: saved.id } };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_READY };
    throw err;
  }
}

/** Deletes a page nobody has booked on; one with bookings is switched off instead, keeping them. */
export async function deleteBookingPage(id: string): Promise<ActionResult<{ deleted: boolean }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NOT_ALLOWED };
  const page = await db.bookingPage.findUnique({ where: { id }, select: { id: true, title: true, _count: { select: { bookings: true } } } });
  if (!page) return { ok: false, error: "That page no longer exists." };
  if (page._count.bookings > 0) {
    await db.bookingPage.update({ where: { id }, data: { active: false } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "BookingPage", entityId: id, entityLabel: `Booking page ${page.title} switched off — it has bookings` });
    refresh();
    return { ok: true, data: { deleted: false } };
  }
  await db.bookingPage.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "BookingPage", entityId: id, entityLabel: `Booking page ${page.title}` });
  refresh();
  return { ok: true, data: { deleted: true } };
}
