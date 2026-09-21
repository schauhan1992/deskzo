import { CallerAllocationMethod, WorkbookMode, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import type { WorkbookFilters } from "@/lib/workspace/filters";
import { findUser, optionalUserRef } from "./lookups";
import {
  createRow,
  diff,
  errorRow,
  updateRow,
  RowReader,
  type FieldChange,
  type Importer,
  type ImportContext,
  type Resolved,
} from "./types";

/**
 * Saved calling and prospecting lists.
 *
 * ## Matching is weaker here than anywhere else in the system, and that has a cost
 *
 * Every other importable entity has a stable key — CON-000123, a normalised company name, a unique
 * column. `Workbook` has none: `name` is not unique, and not unique per owner either. So a row is
 * matched on its Name together with its Owner, which is a description of a list rather than a key
 * to it. The consequence, stated plainly: two lists called "Renewals 90 days" owned by the same
 * person are indistinguishable to this importer, and a row naming them is refused rather than
 * applied to whichever turned up first. With the Owner cell left blank a row matches on name alone
 * across everybody, and is refused the moment more than one list answers to it.
 *
 * A second consequence of matching on the owner's name: the Owner column goes through the same
 * active-user lookup as everywhere else, so a list belonging to somebody who has since left the
 * company exports fine and will not import. That is the honest failure — the alternative is
 * guessing which departed account a name meant.
 *
 * ## The filter set is validated, never merely parsed
 *
 * `filters` is a JSON DSL (src/lib/workspace/filters.ts) and `buildWhere` deliberately ignores keys
 * it does not recognise, so that an old list degrades to a broader one instead of erroring. That
 * tolerance is right inside the app and catastrophic at the front door: a misspelt filter key would
 * be accepted here, dropped there, and the list would quietly widen. An empty filter set matches
 * every marketable company in the database, and handing that to a caller as "your list" is the one
 * failure this area must not have. So every key is checked against `WorkbookFilters` and every value
 * against that key's shape, and anything unrecognised is an error row naming the key.
 *
 * `FILTER_KINDS` below is typed `Record<keyof WorkbookFilters, ...>` on purpose: adding a filter to
 * filters.ts without describing it here is a compile error rather than a hole in the validation.
 * The key lookup is an own-property test rather than `known[key]`, because `known["constructor"]`
 * and `known["__proto__"]` answer from `Object.prototype` — truthy, so a bare index would wave those
 * keys through as recognised filters carrying any value at all.
 *
 * ## Somebody else's list gets the same lock it has on its own screen
 *
 * A shared list is visible to everybody and editable only by whoever built it (`saveWorkbook`,
 * `deleteWorkbook`, `assignWorkbook` and `startCallingActivity` all say so, and `workspace.manageAny`
 * is the override). Import is a different door into the same house: without the same check, anybody
 * holding `data.importCrm` could rewrite the filters behind another person's calling list — which is
 * the widening failure described above, arrived at from the side.
 *
 * The check is on the *change*, not on the row. An exported file carries every shared list, most of
 * them other people's, and handing it straight back alters none of them — those rows resolve to no
 * differences and stay skips. Only a row that would actually move something on a list somebody else
 * owns needs the key, which is what keeps the round trip intact.
 *
 * ## What this importer deliberately will not do
 *
 * - **Change Mode.** Turning a list into a calling activity is `startCallingActivity`: it freezes
 *   the matching companies into records, splits them between the callers and raises each caller's
 *   task. Writing the word COLD_CALLING into a column does none of that and leaves a campaign with
 *   nothing in it — and one that can never be started properly, because the code refuses to start an
 *   activity twice. A Mode cell that disagrees with the list is an error row saying so.
 * - **Re-allocate a started activity.** Once the rows are frozen, `allocationMethod` records how
 *   they were actually split. Changing the word would not move a single record, so a file that tries
 *   is refused rather than left describing something that never happened.
 * - **Remove an assignee.** The Assignees cell adds people; deleting a name from it does nothing.
 *   An assignment is not just a row — it carries whatever task was raised for that person and the
 *   notification they were sent — so taking one away is a deliberate act on the list's own screen,
 *   not a side effect of somebody tidying a spreadsheet. The people a row *adds* are told, the same
 *   way `assignWorkbook` tells them: a list nobody knows about is a list nobody works, and an
 *   assignment that arrives silently is worse than none because the list looks staffed.
 * - **Move a deadline that has already been handed out.** Due sets the activity's own date; the
 *   per-assignee dates and the callers' tasks are not moved with it.
 *
 * Records and Created are exported for information and ignored on the way in. They are listed in
 * `templateColumns` only so that a file straight out of the exporter comes back without every row
 * being flagged for unknown columns.
 */

// ─── The filter DSL, checked ────────────────────────────────────────────────────────────────────

type FilterKind = "strings" | "number" | "boolean" | "yesno" | "isoDate";

const FILTER_KINDS: Record<keyof WorkbookFilters, FilterKind> = {
  relationshipType: "strings",
  stage: "strings",
  industryId: "strings",
  category: "strings",
  companyType: "strings",
  source: "strings",
  tags: "strings",
  city: "strings",
  state: "strings",
  employeeMin: "number",
  employeeMax: "number",
  hasWebsite: "yesno",
  ownerUserId: "strings",
  assignedToUserId: "strings",
  unowned: "boolean",
  hasOrders: "yesno",
  orderBusinessType: "strings",
  orderStatus: "strings",
  billedMin: "number",
  billedMax: "number",
  hasOutstanding: "boolean",
  itemId: "strings",
  brandId: "strings",
  productFamilyId: "strings",
  itemType: "strings",
  productExcludes: "boolean",
  renewalWithinDays: "number",
  renewalExpired: "boolean",
  leadStatus: "strings",
  hasOpenLead: "boolean",
  allLeadsLost: "boolean",
  neverHadLead: "boolean",
  noCallInDays: "number",
  createdFrom: "isoDate",
  createdTo: "isoDate",
  emailProvider: "strings",
  webPlatform: "strings",
  spoofable: "boolean",
  notScanned: "boolean",
  includeResellerManaged: "boolean",
};

function kindProblem(kind: FilterKind, value: unknown): string | null {
  switch (kind) {
    case "strings":
      // An empty array is allowed: filters.ts treats it as "don't narrow on this", which is what a
      // half-built filter looks like and is not an error.
      return Array.isArray(value) && value.every((v) => typeof v === "string")
        ? null
        : `must be a list of text values, like ["LEAD","PROSPECT"].`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "must be a number.";
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false.";
    case "yesno":
      return value === "yes" || value === "no" ? null : `must be "yes" or "no".`;
    case "isoDate":
      // buildWhere hands these straight to `new Date()`, which reads 01/02/2026 as January — so the
      // unambiguous form is the only one accepted rather than the preferred one.
      return typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(new Date(value).getTime())
        ? null
        : "must be a date written as YYYY-MM-DD.";
    default:
      // Unreachable while `kind` comes from FILTER_KINDS, and a refusal rather than a fall-through
      // because the alternative is `undefined` — which reads as "no problem" at the call site and
      // would accept the value unchecked.
      return "isn't a filter this importer knows how to read.";
  }
}

function parseFilters(raw: string): Resolved<WorkbookFilters> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "Filters isn't valid JSON. Copy the cell from an export rather than typing it by hand." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `Filters must be a JSON object, like {"stage":["LEAD"]}. Use {} for a list with no filters.` };
  }

  const known = FILTER_KINDS as Record<string, FilterKind | undefined>;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Own properties only. `known["constructor"]` and `known["toString"]` come back from
    // Object.prototype and are truthy, so a plain index would accept `{"constructor": 1}` as a
    // recognised filter and then skip the shape check with a `kind` that is a function.
    const kind = Object.prototype.hasOwnProperty.call(FILTER_KINDS, key) ? known[key] : undefined;
    if (!kind) {
      return {
        error: `Filters has no filter called "${key}". The ones that exist are: ${Object.keys(FILTER_KINDS).join(", ")}.`,
      };
    }
    if (value === null) {
      return { error: `Filters: "${key}" is null. Leave the key out altogether to stop filtering on it.` };
    }
    const problem = kindProblem(kind, value);
    if (problem) return { error: `Filters: "${key}" ${problem}` };
  }

  return { value: parsed as WorkbookFilters };
}

/**
 * Key order is an artefact of whoever last saved the list, not part of what it means, so it is
 * sorted away before two filter sets are compared. Without this, re-importing a file the exporter
 * wrote would report a Filters change on every run for ever.
 */
function canonicalFilters(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "{}";
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

// ─── Reading a row ──────────────────────────────────────────────────────────────────────────────

const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

const sorted = (names: string[]) => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

type ExistingWorkbook = {
  id: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  ownerName: string;
  shared: boolean;
  mode: WorkbookMode;
  allocationMethod: CallerAllocationMethod;
  dueAt: Date | null;
  startedAt: Date | null;
  filters: unknown;
  /** Already sorted, so that comparing an untouched cell costs nothing and never false-positives. */
  assigneeNames: string[];
};

type ResolvedWorkbook = {
  name: string;
  /** Only set when the Owner cell carried a name; never written on an update — see below. */
  ownerUserId?: string;
  ownerName?: string;
  description?: string;
  shared?: boolean;
  mode?: WorkbookMode;
  allocationMethod?: CallerAllocationMethod;
  dueAt?: Date;
  filters?: WorkbookFilters;
  /** People to add. Anybody already on the list is excluded, so applying twice adds nothing twice. */
  addAssigneeIds: string[];
  /** The full set after this row, sorted — what the preview reports and what apply converges on. */
  assigneeNames: string[];
  existing: ExistingWorkbook | null;
  /**
   * For an update: what actually differs. Empty on a create, and on an update empty means the row
   * is a skip. Computed here rather than in `plan` so that the preview, the authority check and the
   * writer are all reading one answer — `apply` writing a field the preview never mentioned is the
   * exact drift this contract exists to stop.
   */
  changes: FieldChange[];
};

async function resolve(
  row: Record<string, string>,
  ctx: ImportContext,
): Promise<Resolved<ResolvedWorkbook>> {
  const r = new RowReader(row);
  const name = r.text("Name");
  if (!name) return { error: "Name is required." };

  const shared = r.boolean("Shared");
  const mode = r.enum("Mode", WorkbookMode);
  const allocationMethod = r.enum("Allocation", CallerAllocationMethod);
  const dueAt = r.date("Due");
  if (r.error) return { error: r.error };

  const owner = await optionalUserRef("Owner", r.text("Owner"));
  if ("error" in owner) return { error: owner.error };

  // Name and owner together, matched case-insensitively because "renewals 90 days" and
  // "Renewals 90 days" are one list that somebody typed twice, not two.
  const candidates = await db.workbook.findMany({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(owner.value ? { ownerUserId: owner.value.id } : {}),
    },
    include: {
      owner: { select: { name: true } },
      assignees: { select: { user: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Narrowed again in memory, and not out of superstition: `mode: "insensitive"` is rendered on
  // PostgreSQL as ILIKE, where `%` and `_` in the *value* are wildcards rather than literals. List
  // names are typed by people — "Q1_2026", "Renewals 90%" — so the query can answer with lists that
  // merely look alike. It over-matches and never under-matches (a pattern always matches its own
  // literal text), which makes an exact comparison here safe as well as necessary: without it a row
  // for "Q1_2026" silently rewrites "Q1-2026", or is refused for colliding with a list it does not
  // name. Costs nothing if a future connector renders the comparison some other way.
  const wanted = name.toLowerCase();
  const matches = candidates.filter((m) => m.name.toLowerCase() === wanted);

  if (matches.length > 1) {
    return {
      error: owner.value
        ? `${owner.value.name} has more than one list called "${name}", and a list is matched on its name and owner alone — there is nothing finer to tell them apart. Rename one on its own screen first.`
        : `More than one list is called "${name}" (${matches.map((m) => m.owner.name).join(", ")}). Fill in Owner to say which one this row means.`,
    };
  }

  const found = matches[0];
  const existing: ExistingWorkbook | null = found
    ? {
        id: found.id,
        name: found.name,
        description: found.description,
        ownerUserId: found.ownerUserId,
        ownerName: found.owner.name,
        shared: found.shared,
        mode: found.mode,
        allocationMethod: found.allocationMethod,
        dueAt: found.dueAt,
        startedAt: found.startedAt,
        filters: found.filters,
        assigneeNames: sorted(found.assignees.map((a) => a.user.name)),
      }
    : null;

  if (mode && existing && mode !== existing.mode) {
    return {
      error: `This list is ${existing.mode} and import can't change that. Starting a calling activity freezes the matching companies into records and raises each caller's task — do it from the list's own screen.`,
    };
  }
  if (mode === WorkbookMode.COLD_CALLING && !existing) {
    return {
      error: `A new list is created as a saved list. Start the calling activity from its own screen afterwards, so the companies are frozen into records and the callers get their tasks — importing the word COLD_CALLING would leave a campaign with nothing in it.`,
    };
  }

  if (allocationMethod && existing?.startedAt && allocationMethod !== existing.allocationMethod) {
    return {
      error: `This activity has already started and its companies are split between the callers as ${existing.allocationMethod}. Changing the word here would not move one of them — re-share it from the list's own screen instead.`,
    };
  }

  const filtersCell = r.text("Filters");
  let filters: WorkbookFilters | undefined;
  if (filtersCell) {
    const parsed = parseFilters(filtersCell);
    if ("error" in parsed) return { error: parsed.error };
    filters = parsed.value;
  } else if (!existing) {
    // A blank cell means "leave this alone" everywhere, and a new list has nothing to leave alone.
    // Defaulting to {} would hand a caller every company in the database, so it is refused. An
    // explicit {} is allowed: that is somebody saying it on purpose rather than a gap in a file.
    return {
      error: `Filters is required when creating a list. A list with no filters matches every company in the database, so it has to be asked for explicitly — put {} in the cell if that is really what you want.`,
    };
  }

  // Assignees the row names but the list does not already have. A name already on the list is
  // passed over without a lookup, deliberately: somebody who has since been deactivated still
  // appears in the export, and re-importing an untouched file must not fail because of them.
  const existingIds = new Set(found?.assignees.map((a) => a.user.id) ?? []);
  const existingNames = existing?.assigneeNames ?? [];
  const addAssigneeIds: string[] = [];
  const addAssigneeNames: string[] = [];

  for (const token of splitNames(r.text("Assignees"))) {
    if (existingNames.some((n) => n.toLowerCase() === token.toLowerCase())) continue;
    const user = await findUser(token);
    if (!user) {
      return {
        error: `No active user matches "${token}" (Assignees). Use full names or email addresses separated by semicolons.`,
      };
    }
    if (existingIds.has(user.id) || addAssigneeIds.includes(user.id)) continue;
    addAssigneeIds.push(user.id);
    addAssigneeNames.push(user.name);
  }

  const description = r.text("Description") || undefined;
  const assigneeNames = sorted([...existingNames, ...addAssigneeNames]);

  // Every field that `apply` writes, and nothing it does not — the two lists have to be the same one
  // or the preview describes a write that never happens, or hides one that does.
  const changes: FieldChange[] = existing
    ? ([
        diff("Name", existing.name, name),
        description ? diff("Description", existing.description, description) : null,
        shared !== undefined ? diff("Shared", existing.shared, shared) : null,
        allocationMethod ? diff("Allocation", existing.allocationMethod, allocationMethod) : null,
        // Compared to the day, because that is the precision the file carries — and `apply` writes
        // Due only when this change is present, so nothing moves at a precision nobody was shown.
        dueAt ? diff("Due", dateOnly(existing.dueAt), dateOnly(dueAt)) : null,
        // The whole filter set, as JSON, rather than a readable "3 filters". A summary would compare
        // equal for two different sets, the row would be reported as a skip, and the new filters
        // would never land — the exact drift this design exists to stop.
        filters ? diff("Filters", canonicalFilters(existing.filters), canonicalFilters(filters)) : null,
        diff("Assignees", existing.assigneeNames.join("; "), assigneeNames.join("; ")),
        // Owner is half the match key, so it can never differ on a row that matched. A list is moved
        // to a different owner on its own screen: ownership decides who may redefine it.
      ].filter((c): c is FieldChange => c !== null))
    : [];

  // The lock the list's own screen has. Only a row that would move something needs it, so an
  // exported file — which carries everybody's shared lists — still hands back as a page of skips.
  if (
    existing &&
    changes.length > 0 &&
    ctx.actorUserId &&
    existing.ownerUserId !== ctx.actorUserId &&
    !(await can(ctx.actorUserId, "workspace.manageAny"))
  ) {
    return {
      error: `"${existing.name}" belongs to ${existing.ownerName}, and a list is only editable by whoever built it. Duplicate it from the workspace screen to make your own version, or ask them to make the change.`,
    };
  }

  return {
    value: {
      name,
      ownerUserId: owner.value?.id,
      ownerName: owner.value?.name,
      description,
      shared,
      mode,
      allocationMethod,
      dueAt,
      filters,
      addAssigneeIds,
      assigneeNames,
      existing,
      changes,
    },
  };
}

/**
 * Semicolons if there are any, commas otherwise. A person's name is one free-text field and the odd
 * one has a comma in it, so the exporter writes semicolons and a file it wrote splits correctly;
 * a hand-typed comma list still works.
 */
function splitNames(raw: string): string[] {
  if (!raw) return [];
  return (raw.includes(";") ? raw.split(";") : raw.split(","))
    .map((t) => t.trim())
    .filter(Boolean);
}

export const workspaceImporter: Importer = {
  templateColumns: [
    "Name",
    "Description",
    "Owner",
    "Shared",
    "Mode",
    "Allocation",
    "Due",
    "Filters",
    "Assignees",
    "Records",
    "Created",
  ],

  async plan(row, line, ctx) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) return errorRow(line, row.Name ?? "", resolved.error);
    const w = resolved.value;
    const key = w.ownerName ? `${w.ownerName} / ${w.name}` : w.name;

    if (!w.existing) {
      return createRow(line, key, w.name, {
        Name: w.name,
        Description: w.description,
        // Named explicitly when the cell is blank, because the fallback is a real decision: the
        // owner is the only person who can edit the list afterwards.
        Owner: w.ownerName ?? "(whoever runs this import)",
        Shared: w.shared,
        Mode: w.mode,
        Allocation: w.allocationMethod,
        Due: w.dueAt,
        Filters: canonicalFilters(w.filters),
        Assignees: w.assigneeNames.join("; "),
      });
    }

    return updateRow(line, key, w.name, w.changes);
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) throw new Error(resolved.error);
    const w = resolved.value;

    // Due is carried at day precision in the file but stored as an instant, so writing it back on
    // every touched row would quietly move a deadline set to a time — a change the preview, which
    // compares days, would have reported as nothing at all. Written only when the day itself moved.
    const dueMoved = w.dueAt !== undefined && (!w.existing || w.changes.some((c) => c.field === "Due"));

    const data = {
      name: w.name,
      ...(w.description ? { description: w.description } : {}),
      ...(w.shared !== undefined ? { shared: w.shared } : {}),
      ...(w.allocationMethod ? { allocationMethod: w.allocationMethod } : {}),
      ...(dueMoved ? { dueAt: w.dueAt } : {}),
      ...(w.filters ? { filters: w.filters as Prisma.InputJsonValue } : {}),
    };

    let workbookId: string;
    if (w.existing) {
      await db.workbook.update({ where: { id: w.existing.id }, data });
      workbookId = w.existing.id;
    } else {
      const created = await db.workbook.create({
        data: {
          ...data,
          // resolve() refuses a blank Filters cell on a create, so this is never the empty set by
          // accident — only when the file asked for it.
          filters: (w.filters ?? {}) as Prisma.InputJsonValue,
          ...(w.mode ? { mode: w.mode } : {}),
          // Falling back to whoever ran the import: a workbook must have an owner, and the owner is
          // the only person who can edit it afterwards.
          ownerUserId: w.ownerUserId ?? ctx.actorUserId,
        },
        select: { id: true },
      });
      workbookId = created.id;
    }

    if (w.addAssigneeIds.length > 0) {
      await db.workbookAssignee.createMany({
        data: w.addAssigneeIds.map((userId) => ({
          workbookId,
          userId,
          assignedByUserId: ctx.actorUserId,
        })),
        skipDuplicates: true,
      });

      // The same thing `assignWorkbook` does, for the same reason: work that arrives without anybody
      // being told is work nobody does, and the list meanwhile reads as staffed. `notifyUser`
      // swallows its own failures, so a notification that cannot be written never fails the row.
      for (const userId of w.addAssigneeIds) {
        await notifyUser({
          userId,
          type: "TASK_ASSIGNED",
          title: "A list was assigned to you",
          message: `${w.name} — ready to work`,
          link: `/workspace/${workbookId}`,
        });
      }
    }
  },
};
