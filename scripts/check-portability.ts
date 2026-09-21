/**
 * That the export layer still describes the whole system.
 *
 * An export layer written once is stale within two releases: a model gets added, nobody remembers
 * the exporter exists, and the gap is invisible until a migration years later comes up short. So
 * every Prisma model must be either drawn from by a canonical entity or explicitly excluded with a
 * reason. Adding a model to the schema and running this is how the decision gets forced.
 *
 * It also checks the properties that make an export re-runnable, which is the difference between a
 * migration you can verify and one you do once and hope.
 *
 *   npm run check:portability
 */
import { readFileSync } from "node:fs";
import { CANONICAL_ENTITIES, COVERED_MODELS, MODEL_DISPOSITIONS, ENTITY_KEYS, getEntity } from "../src/lib/portability/entities";
import { PORTABLE_AREAS, AREA_PERMISSIONS } from "../src/lib/portability/areas";
import { EXPORTERS } from "../src/lib/portability/exporters";
import { getPermissionDefinition } from "../src/lib/permissions";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

const schema = readFileSync("prisma/schema.prisma", "utf8");
const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!);

console.log("\n— Coverage —\n");

ok("The schema parsed", models.length > 90, `${models.length} models`);

const unclassified = models.filter((m) => !COVERED_MODELS.has(m) && !(m in MODEL_DISPOSITIONS));
ok(
  "Every model is exported or explicitly excluded",
  unclassified.length === 0,
  unclassified.length
    ? `undecided: ${unclassified.join(", ")} — add to a canonical entity's sourceModels, or to MODEL_DISPOSITIONS with a reason`
    : `${COVERED_MODELS.size} exported, ${Object.keys(MODEL_DISPOSITIONS).length} excluded`,
);

const phantomCovered = [...COVERED_MODELS].filter((m) => !models.includes(m));
ok(
  "Every exported model still exists in the schema",
  phantomCovered.length === 0,
  phantomCovered.length ? `renamed or deleted: ${phantomCovered.join(", ")}` : "",
);

const phantomExcluded = Object.keys(MODEL_DISPOSITIONS).filter((m) => !models.includes(m));
ok(
  "Every excluded model still exists",
  phantomExcluded.length === 0,
  phantomExcluded.length ? `stale exclusions: ${phantomExcluded.join(", ")}` : "",
);

ok(
  "No model is both exported and excluded",
  [...COVERED_MODELS].every((m) => !(m in MODEL_DISPOSITIONS)),
  "a contradiction that would make the coverage number a lie",
);

ok(
  "Every exclusion states a reason",
  Object.values(MODEL_DISPOSITIONS).every((r) => r.reason.trim().length > 20),
  "an exclusion without a reason is indistinguishable from an oversight",
);

console.log("\n— Keys —\n");

for (const e of CANONICAL_ENTITIES) {
  const names = new Set(e.fields.map((f) => f.name));
  const missing = e.naturalKey.filter((k) => !names.has(k));
  ok(
    `${e.key}: every key component is an exported field`,
    missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : e.naturalKey.join(" | "),
  );

  // A key component that is not required may be null, and a composite key with a null component
  // silently drops out of every reconciliation query instead of failing loudly.
  const nullable = e.naturalKey
    .map((k) => e.fields.find((f) => f.name === k))
    .filter((f) => f && f.required !== true)
    .map((f) => f!.name);
  ok(
    `  ${e.key}: no key component is nullable`,
    nullable.length === 0,
    nullable.length ? `nullable in key: ${nullable.join(", ")} — mark required, or key on something else` : "",
  );

  ok(`  ${e.key}: explains its key`, e.keyNote.trim().length > 30);
}

console.log("\n— References —\n");

for (const e of CANONICAL_ENTITIES) {
  for (const f of e.fields) {
    if (!f.referencesEntity) continue;
    ok(
      `${e.key}.${f.name} points at a real entity`,
      ENTITY_KEYS.includes(f.referencesEntity),
      f.referencesEntity,
    );
  }
}

console.log("\n— The fields whose loss changes meaning —\n");

/**
 * Hand-picked rather than derived, because each is a specific thing that goes wrong.
 * These are the findings the portability audit surfaced; the check stops them being dropped later.
 */
const MUST_CARRY: [string, string, string][] = [
  ["account", "relationshipType", "one table holds clients, vendors, resellers and commission agents — without it a target merges suppliers into the customer list"],
  ["account", "managedByReseller", "a contractual do-not-contact flag; losing it means marketing to people you may not"],
  ["account", "owner", "the account manager, which every scoped view resolves against"],
  ["order", "fullTermUnitPrice", "distinct from what a mid-term addition was charged; losing it under-bills every renewal"],
  ["order", "renewedFrom", "without it every renewal looks like new business"],
  ["order", "parentOrder", "co-terminated addons collapse into unrelated orders without it"],
  ["payment", "allocations", "a payment with no allocation is an unexplained receipt"],
  ["consent", "source", "the DPDP Act wants the consent artefact, not a boolean"],
];

for (const [entityKey, fieldName, why] of MUST_CARRY) {
  const e = getEntity(entityKey);
  const f = e?.fields.find((x) => x.name === fieldName);
  ok(`${entityKey}.${fieldName} is carried and required`, f?.required === true, f ? why : "FIELD MISSING ENTIRELY");
}

console.log("\n— Secrets —\n");

const neverExport = CANONICAL_ENTITIES.flatMap((e) =>
  e.fields.filter((f) => f.sensitivity === "never").map((f) => `${e.key}.${f.name}`),
);
ok("Credentials are marked as never exportable", neverExport.length >= 2, neverExport.join(", "));

// A field whose name looks like a secret but carries no marking is the dangerous case.
const suspicious = CANONICAL_ENTITIES.flatMap((e) =>
  e.fields
    .filter((f) => /password|secret|cipher|token/i.test(f.name) && f.sensitivity !== "never")
    .map((f) => `${e.key}.${f.name}`),
);
ok(
  "No credential-shaped field is unmarked",
  suspicious.length === 0,
  suspicious.length ? `unmarked: ${suspicious.join(", ")}` : "",
);

console.log("\n— Areas and permissions —\n");

ok(
  "Every area names real permissions",
  AREA_PERMISSIONS.every((p) => getPermissionDefinition(p) !== undefined),
  AREA_PERMISSIONS.filter((p) => !getPermissionDefinition(p)).join(", ") || `${AREA_PERMISSIONS.length} keys`,
);

const areaKeys = new Set(PORTABLE_AREAS.map((a) => a.key));
const orphanEntities = CANONICAL_ENTITIES.filter((e) => !areaKeys.has(e.area)).map((e) => `${e.key}->${e.area}`);
ok(
  "Every entity belongs to an export area",
  orphanEntities.length === 0,
  orphanEntities.length ? orphanEntities.join(", ") : `${CANONICAL_ENTITIES.length} entities across ${areaKeys.size} areas`,
);

ok(
  "Every import-refused area explains why",
  PORTABLE_AREAS.filter((a) => a.importPermission === null).every((a) => (a.importRefusedBecause ?? "").length > 40),
  "an absent option with no explanation reads as a missing feature",
);

// An area with no exporter downloads a file containing nothing, which reads as "you have no data"
// rather than "this was never built" — the worst of both, because nobody reports it as a bug.
const missingExporters = PORTABLE_AREAS.filter((a) => !(a.key in EXPORTERS)).map((a) => a.key);
ok(
  "Every area has an exporter",
  missingExporters.length === 0,
  missingExporters.length
    ? `${missingExporters.join(", ")} would download an empty file`
    : `${PORTABLE_AREAS.length} areas`,
);

console.log(failures === 0 ? "\nAll portability checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
