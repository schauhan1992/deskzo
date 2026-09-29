import { db } from "@/lib/db";
import { DEFAULT_DUE_DAY, DEFAULT_TEMPLATES, isAutoCheckKey, type AutoCheckKey } from "@/lib/close/catalogue";
import { indiaToday } from "@/lib/close/months";
import { PEOPLE_ONLY } from "@/lib/people";

/**
 * The checklist's templates: what every month's close is copied from.
 *
 * A workspace starts with the fourteen defaults (catalogue.ts), seeded the first time the checklist is
 * used — never again, so a default somebody deleted stays deleted. "Seeded" is remembered as a
 * `DailyJobRun` row with the job `close-seed` (the settings row has no flag for it), and the seeding
 * holds a transaction-scoped advisory lock, so two pages opened at once seed once.
 */

export const SEED_JOB = "close-seed";

/** Seeds the default templates if this workspace never has. True when this call did it. */
export async function ensureDefaultTemplates(now: Date = new Date()): Promise<boolean> {
  if (await db.dailyJobRun.findFirst({ where: { job: SEED_JOB }, select: { day: true } })) return false;
  return db.$transaction(async (tx) => {
    // One seeding at a time per workspace; the loser finds the row the winner wrote.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('wroffy:close-seed'))`;
    if (await tx.dailyJobRun.findFirst({ where: { job: SEED_JOB }, select: { day: true } })) return false;
    await tx.dailyJobRun.create({ data: { job: SEED_JOB, day: indiaToday(now), ok: true } });
    // Templates made some other way before the first seeding are the workspace's own list: kept, and
    // the defaults not added beside them.
    if ((await tx.closeTaskTemplate.count()) > 0) return false;
    await tx.closeTaskTemplate.createMany({
      data: DEFAULT_TEMPLATES.map((t, i) => ({
        title: t.title,
        description: t.description,
        autoCheck: t.autoCheck,
        dueDay: DEFAULT_DUE_DAY,
        sortOrder: (i + 1) * 10,
        ownerId: null,
        active: true,
      })),
    });
    return true;
  });
}

export type TemplateInput = {
  id?: string | null;
  title: string;
  description?: string | null;
  ownerId?: string | null;
  dueDay?: number | null;
  autoCheck?: string | null;
  sortOrder?: number | null;
  active?: boolean | null;
};

/** Why a template can't be saved as given, or null. */
export function templateProblem(input: TemplateInput): string | null {
  const title = input.title?.trim() ?? "";
  if (!title) return "Give the task a title.";
  if (title.length > 200) return "Keep the title under 200 characters.";
  if ((input.description?.trim().length ?? 0) > 2000) return "Keep the description under 2,000 characters.";
  const dueDay = input.dueDay ?? DEFAULT_DUE_DAY;
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return "The due day is a working day of the next month, 1 to 31.";
  if (input.autoCheck && !isAutoCheckKey(input.autoCheck)) return "That isn't a check the close knows.";
  return null;
}

export async function listTemplates(opts: { includeInactive?: boolean } = {}) {
  return db.closeTaskTemplate.findMany({
    where: opts.includeInactive ? {} : { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true, title: true, description: true, ownerId: true, dueDay: true, autoCheck: true, sortOrder: true, active: true,
      owner: { select: { id: true, name: true } },
      _count: { select: { tasks: true } },
    },
  });
}

/** Creates or updates a template. The owner must be an active person in this workspace. */
export async function writeTemplate(input: TemplateInput): Promise<{ ok: true; id: string; created: boolean } | { ok: false; error: string }> {
  const problem = templateProblem(input);
  if (problem) return { ok: false, error: problem };
  if (input.ownerId) {
    const owner = await db.user.findFirst({ where: { id: input.ownerId, ...PEOPLE_ONLY, active: true }, select: { id: true } });
    if (!owner) return { ok: false, error: "Choose somebody active in this workspace as the owner." };
  }
  const data = {
    title: input.title.trim(),
    description: input.description?.trim() || null,
    ownerId: input.ownerId || null,
    dueDay: input.dueDay ?? DEFAULT_DUE_DAY,
    autoCheck: (input.autoCheck || null) as AutoCheckKey | null,
    active: input.active ?? true,
  };
  if (input.id) {
    const existing = await db.closeTaskTemplate.findUnique({ where: { id: input.id }, select: { id: true } });
    if (!existing) return { ok: false, error: "That template no longer exists." };
    await db.closeTaskTemplate.update({
      where: { id: input.id },
      data: { ...data, ...(input.sortOrder != null ? { sortOrder: input.sortOrder } : {}) },
    });
    return { ok: true, id: input.id, created: false };
  }
  const last = await db.closeTaskTemplate.aggregate({ _max: { sortOrder: true } });
  const created = await db.closeTaskTemplate.create({
    data: { ...data, sortOrder: input.sortOrder ?? (last._max.sortOrder ?? 0) + 10 },
    select: { id: true },
  });
  return { ok: true, id: created.id, created: true };
}

/**
 * Deletes a template. Months already generated keep their tasks (as one-offs: `templateId` is set
 * null), and the seeding never brings it back.
 */
export async function removeTemplate(id: string): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  const existing = await db.closeTaskTemplate.findUnique({ where: { id }, select: { title: true } });
  if (!existing) return { ok: false, error: "That template no longer exists." };
  await db.closeTaskTemplate.delete({ where: { id } });
  return { ok: true, title: existing.title };
}

/** Puts templates in the order given; any not named keep their place after them. */
export async function reorderTemplateRows(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].slice(0, 500);
  await db.$transaction(async (tx) => {
    for (const [i, id] of unique.entries()) {
      await tx.closeTaskTemplate.updateMany({ where: { id }, data: { sortOrder: (i + 1) * 10 } });
    }
  });
}
