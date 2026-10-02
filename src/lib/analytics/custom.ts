import { cache } from "react";
import { db } from "@/lib/db";
import { moduleAccessFor } from "@/lib/modules-access";
import { fieldsFor } from "@/lib/custom-fields/server";
import {
  CUSTOM_FIELD_ENTITY_MODULES,
  formatValue,
  isEmptyValue,
  optionLabel,
  readValues,
  type CustomFieldDef,
  type CustomFieldEntityKey,
  type CustomFieldTypeKey,
  type CustomFieldValue,
  type CustomFieldValues,
} from "@/lib/custom-fields/rules";
import { NONE, type CustomFieldReach, type Dimension, type FactSource, type Measure } from "./types";

/**
 * The workspace's own fields, as things a report can be broken down by and added up.
 *
 * A workspace that adds "Region" to its companies (src/lib/custom-fields) will ask for orders by
 * region the next morning. sources.ts cannot declare that — the field is the workspace's, not the
 * product's — so each source names the records its rows reach (`FactSource.customFields`), and this
 * file turns the fields on them into dimensions and measures of the same kind sources.ts declares.
 * Past that point the engine cannot tell them apart: filters, cross-tabs and the warning about rows
 * that add up to more than the total work on them because they work on any dimension. Only what
 * names a dimension — the explorer, the CSV, the printed sheet — has to ask for this source rather
 * than the bare one, which `effectiveSource` below is.
 *
 * ## Built per person
 *
 * From `fieldsFor(entity, userId).visible` and from nothing else, so a retired field never appears
 * and a restricted one only for holders of `fields.seeRestricted`. A field somebody may not see is
 * not a dimension of their report at all: there is no bucket, no filter value and no label that
 * could carry it. A request naming one anyway — an old print link from somebody who can — is refused
 * by src/actions/analytics.ts as naming something the source doesn't offer them, in the same words
 * as a key that never existed, so the refusal says nothing about the field either.
 *
 * ## Keys
 *
 * `cf:<record>:<field key>`, as in "cf:company:region". Built-in keys are plain words and "time" is
 * the date axis, so nothing of the workspace's can shadow either, and an order's "Site code" and its
 * customer's stay apart. A field key is at most 40 characters, so these stay well inside the 60 the
 * Copilot's report tool accepts.
 */

const customKey = (entity: CustomFieldEntityKey, fieldKey: string) => `cf:${entity.toLowerCase()}:${fieldKey}`;

/**
 * The types that make a breakdown. A number or an amount is something to add up rather than to
 * group by — a bucket per distinct amount is a list of amounts — and a paragraph of long text is not
 * a bucket anybody can read, so neither is offered.
 */
const BREAKDOWNS: ReadonlySet<CustomFieldTypeKey> = new Set([
  "TEXT",
  "EMAIL",
  "PHONE",
  "URL",
  "DATE",
  "SELECT",
  "MULTI_SELECT",
  "CHECKBOX",
  "USER",
]);

/** The types that make a "Total …" measure — on the rows' own records only (`CustomFieldReach.own`). */
const TOTALS: ReadonlySet<CustomFieldTypeKey> = new Set(["NUMBER", "MONEY"]);

type ValueReader = (raw: unknown) => CustomFieldValues;

/**
 * Reads a record's stored values, each record once.
 *
 * `readValues` checks every key of the JSON, and the filter panel asks every dimension of every row
 * on every run — twenty fields over fifty thousand orders is a million readings of the same objects.
 * So each JSON object is read the first time a dimension asks, and the reading kept for as long as
 * the object lives. One reader per `effectiveSource`: nothing in it outlasts the report it was made
 * for, and nothing is kept at module level (check:tenancy).
 */
function valueReader(): ValueReader {
  const read = new WeakMap<object, CustomFieldValues>();
  return (raw) => {
    if (!raw || typeof raw !== "object") return {};
    let values = read.get(raw);
    if (!values) {
      values = readValues(raw);
      read.set(raw, values);
    }
    return values;
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Which bucket a value falls in, in the words the record's own page uses for it.
 *
 * Empty is "—", the bucket every built-in dimension uses for a row with nothing there, so a report by
 * one of these reads like a report by anything else and "which orders have no site code" is a filter
 * value like any other. Two exceptions, both answers rather than blanks:
 *
 *   · a box nobody ticked is "No" — the form shows it unticked, and that is what it says;
 *   · a date is its month, "2026-03", which sorts as it reads. It is a calendar day ("2026-03-14"),
 *     not an instant, so it is cut to its first seven characters rather than put through a clock.
 *
 * A dropdown reads as its option's label (a retired option's too); a person by name, or as somebody
 * no longer here (`formatValue`); a multi-select as each of its labels, once.
 */
function bucketOf(def: CustomFieldDef, value: CustomFieldValue | undefined, personName: (id: string) => string | undefined): string | string[] {
  if (def.type === "CHECKBOX") return value === true ? "Yes" : "No";
  if (value === undefined || isEmptyValue(value)) return NONE;
  switch (def.type) {
    case "MULTI_SELECT": {
      const chosen = (Array.isArray(value) ? value : [String(value)]).filter((v) => v.trim() !== "");
      if (chosen.length === 0) return NONE;
      // Once each: a list a script wrote twice over, or two options sharing a label, must not put
      // one record in one bucket twice and count its money double where nothing says so.
      return [...new Set(chosen.map((v) => optionLabel(def, v)))];
    }
    case "DATE":
      return typeof value === "string" && DAY.test(value) ? value.slice(0, 7) : String(value);
    default:
      return formatValue(def, value, personName);
  }
}

function dimensionFor<Row>(
  reach: CustomFieldReach<Row>,
  def: CustomFieldDef,
  personName: (id: string) => string | undefined,
  storedValues: ValueReader,
): Dimension<Row> {
  return {
    key: customKey(reach.entity, def.key),
    label: `${reach.noun} · ${def.label}`,
    of: (row) => bucketOf(def, storedValues(reach.values(row))[def.key], personName),
    // A record with two of the options is in both buckets, and the report says so when it happens.
    ...(def.type === "MULTI_SELECT" ? { multi: true } : {}),
    custom: true,
  };
}

function measureFor<Row>(reach: CustomFieldReach<Row>, def: CustomFieldDef, storedValues: ValueReader): Measure<Row> {
  const many = `${reach.noun.toLowerCase()}s`;
  return {
    key: customKey(reach.entity, def.key),
    label: `Total ${def.label}`,
    unit: def.type === "MONEY" ? "currency" : "number",
    value: (row) => {
      const v = storedValues(reach.values(row))[def.key];
      return typeof v === "number" ? v : 0;
    },
    description: `${def.label} added up across the ${many} counted. ${reach.noun}s without one add nothing.`,
    custom: true,
  };
}

/**
 * Everybody's name by id, for a "person" field — removed people included, so an old value still
 * reads as who it was. Loaded whole rather than for the ids in the rows, because a dimension is a
 * plain function of a row and has to have the names before the rows exist; a workspace's people are
 * a few hundred names. Once per request.
 */
const personNames = cache(async (): Promise<Map<string, string>> => {
  const people = await db.user.findMany({ select: { id: true, name: true } });
  return new Map(people.map((p) => [p.id, p.name]));
});

/**
 * The source as one person reports on it: its own dimensions and measures, then the workspace's own
 * fields on the records its rows reach, as far as this person may see them — and a load that brings
 * those fields' values with the rows.
 *
 * Built per request, and cheap: the definitions are read once per request (`definitionsFor`), and a
 * source none of whose records has a field this person can use comes back exactly as it went in.
 */
export async function effectiveSource<Row>(source: FactSource<Row>, userId: string): Promise<FactSource<Row>> {
  const reaches = source.customFields ?? [];
  if (reaches.length === 0) return source;

  const found: { reach: CustomFieldReach<Row>; defs: CustomFieldDef[] }[] = await Promise.all(
    reaches.map(async (reach) => {
      // A product's fields only where the Items module is, as on the settings screen: a field nobody
      // can see on its own record should not surface first as a column of somebody's report.
      const needs = CUSTOM_FIELD_ENTITY_MODULES[reach.entity];
      if (needs && (await moduleAccessFor(userId, needs)) !== "available") return { reach, defs: [] };
      return { reach, defs: (await fieldsFor(reach.entity, userId)).visible };
    }),
  );

  const names = found.some(({ defs }) => defs.some((d) => d.type === "USER")) ? await personNames() : new Map<string, string>();
  const personName = (id: string) => names.get(id);
  const storedValues = valueReader();

  const dimensions: Dimension<Row>[] = [];
  const measures: Measure<Row>[] = [];
  const wanted = new Set<CustomFieldEntityKey>();
  for (const { reach, defs } of found) {
    for (const def of defs) {
      if (BREAKDOWNS.has(def.type)) {
        dimensions.push(dimensionFor(reach, def, personName, storedValues));
        wanted.add(reach.entity);
      } else if (reach.own && TOTALS.has(def.type)) {
        measures.push(measureFor(reach, def, storedValues));
        wanted.add(reach.entity);
      }
    }
  }
  if (wanted.size === 0) return source;

  return {
    ...source,
    measures: [...source.measures, ...measures],
    dimensions: [...source.dimensions, ...dimensions],
    // Only the columns something here reads, so a workspace with fields on its companies alone never
    // has its orders' or products' JSON fetched for a report.
    load: (ctx) => source.load({ ...ctx, customFields: wanted }),
  };
}
