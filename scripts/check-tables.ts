/**
 * That every records table hides the same columns in its header as in its body.
 *
 * This is the one failure mode that matters here, and it is invisible. Guard a `<th>` with
 * `cols.show("vendor")` and forget the matching `<td>` and nothing throws, nothing logs, and the
 * table still renders — every row below simply shifts one cell across, so the vendor column shows
 * quantities and the quantity column shows totals. It looks like corrupt data, it gets reported as
 * a data bug, and somebody spends a day in the database before anyone looks at the JSX.
 *
 * So the header keys and the body keys are extracted and compared, per table. A key on one side and
 * not the other fails the build.
 *
 *   npm run check:tables
 */
import { readFileSync, existsSync } from "node:fs";
import { TABLE_REGISTRY, getTableDefinition } from "../src/lib/tables/registry";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}

/**
 * Which component implements which registered table.
 *
 * Explicit rather than discovered: a table that quietly stops being covered because its file was
 * renamed is exactly what this check exists to catch, and a glob would silently stop looking.
 */
const IMPLEMENTATIONS: Record<string, string> = {
  orders: "src/components/orders/orders-table.tsx",
  leads: "src/components/leads/leads-list-table.tsx",
  renewals: "src/components/renewals/renewals-table.tsx",
  // One component renders four lists, keyed on its `mode` prop. They share a file and therefore a
  // set of guarded cells, but each has its own registry entry and its own stored preference — so
  // the per-file checks below validate against the UNION of the keys those four declare.
  companies: "src/components/companies/companies-table.tsx",
  customers: "src/components/companies/companies-table.tsx",
  vendors: "src/components/companies/companies-table.tsx",
  "commission-parties": "src/components/companies/companies-table.tsx",
  // The same arrangement as the four above, keyed on `docType` rather than `mode`: one component
  // renders all seven document lists. Seven entries rather than one because two of the columns
  // differ by type — see the registry's own note on that.
  "documents:PROPOSAL": "src/components/documents/document-rows.tsx",
  "documents:PROFORMA": "src/components/documents/document-rows.tsx",
  "documents:INVOICE": "src/components/documents/document-rows.tsx",
  "documents:CREDIT_NOTE": "src/components/documents/document-rows.tsx",
  "documents:PURCHASE_ORDER": "src/components/documents/document-rows.tsx",
  "documents:BILL": "src/components/documents/document-rows.tsx",
  "documents:DELIVERY_CHALLAN": "src/components/documents/document-rows.tsx",
};

console.log("\n— The registry —\n");

ok("Every table has a label", TABLE_REGISTRY.every((t) => t.label.length > 0));
ok("Every table has columns", TABLE_REGISTRY.every((t) => t.columns.length > 0));
for (const t of TABLE_REGISTRY) {
  const keys = t.columns.map((c) => c.key);
  ok(`  ${t.key}: no duplicate column key`, new Set(keys).size === keys.length, `${keys.length} columns`);
  ok(
    `  ${t.key}: at least one required column`,
    t.columns.some((c) => c.required),
    "a table where every column can be hidden can be hidden entirely, with no way back except Reset",
  );
  ok(
    `  ${t.key}: every required column is also a default`,
    t.columns.filter((c) => c.required).every((c) => c.default),
    "a required column that is not a default contradicts itself",
  );
  ok(`  ${t.key}: at least one default`, t.columns.some((c) => c.default));
}

console.log("\n— Header and body agree —\n");

/** `cols.show("x")` occurrences, in order, so header and body can be split at <tbody>. */
function showKeys(source: string): string[] {
  const keys: string[] = [];
  const re = /cols\.show\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) keys.push(m[1]!);
  return keys;
}

// Grouped by file: several registered tables can share one component, and the guarded cells in that
// file serve all of them. Checking each table against the file separately would report every other
// table's columns as "undeclared".
const byFile = new Map<string, string[]>();
for (const [tableKey, file] of Object.entries(IMPLEMENTATIONS)) {
  byFile.set(file, [...(byFile.get(file) ?? []), tableKey]);
}

for (const [file, tableKeys] of byFile) {
  const label = tableKeys.join(", ");

  if (!existsSync(file)) {
    ok(`${label}: ${file} exists`, false, "renamed or deleted — the check would otherwise stop covering it silently");
    continue;
  }

  const source = readFileSync(file, "utf8");
  const bodyStart = source.indexOf("<tbody");
  if (bodyStart === -1) {
    ok(`${label}: has a <tbody>`, false, file);
    continue;
  }

  const headerKeys = new Set(showKeys(source.slice(0, bodyStart)));
  const bodyKeys = new Set(showKeys(source.slice(bodyStart)));

  const headerOnly = [...headerKeys].filter((k) => !bodyKeys.has(k));
  const bodyOnly = [...bodyKeys].filter((k) => !headerKeys.has(k));

  ok(
    `${label}: every guarded header cell has a guarded body cell`,
    headerOnly.length === 0,
    headerOnly.length
      ? `header only: ${headerOnly.join(", ")} — rows below will shift one cell across`
      : `${headerKeys.size} columns paired`,
  );
  ok(
    `${label}: every guarded body cell has a guarded header cell`,
    bodyOnly.length === 0,
    bodyOnly.length ? `body only: ${bodyOnly.join(", ")}` : "",
  );

  // Declared across every table this file serves — a key is legitimate if ANY of them declares it.
  const declared = new Set<string>();
  for (const tableKey of tableKeys) {
    const def = getTableDefinition(tableKey);
    if (!def) {
      ok(`${tableKey} is registered`, false, `${file} claims to implement it, but the registry has no such table`);
      continue;
    }
    for (const c of def.columns) declared.add(c.key);
  }

  const used = new Set([...headerKeys, ...bodyKeys]);
  const undeclared = [...used].filter((k) => !declared.has(k));
  ok(
    `${label}: every key used is declared by at least one of them`,
    undeclared.length === 0,
    undeclared.length ? `undeclared: ${undeclared.join(", ")}` : "",
  );

  // The reverse, per table: a column the picker offers but nothing renders teaches people the
  // feature is broken.
  for (const tableKey of tableKeys) {
    const def = getTableDefinition(tableKey);
    if (!def) continue;
    const unused = def.columns.map((c) => c.key).filter((k) => !used.has(k));
    ok(
      `  ${tableKey}: every declared column is actually rendered`,
      unused.length === 0,
      unused.length ? `declared but never rendered: ${unused.join(", ")}` : `${def.columns.length} columns`,
    );
  }

  /**
   * Any literal number inside the braces, not only a bare one.
   *
   * The narrower `/colSpan=\{(\d+)\}/` could not see `colSpan={eInvoiced ? 10 : 9}`, so it printed
   * "uses cols.count" over a colSpan that was hardcoded twice — a false pass, which is the one
   * result a check must never give. A ternary is exactly how a hardcoded count survives somebody
   * adding a conditional column, so it is the case most worth catching.
   */
  const hardCoded = /colSpan=\{[^}]*\b\d+\b[^}]*\}/.exec(source);
  ok(
    `${label}: no hardcoded colSpan`,
    hardCoded === null,
    hardCoded ? `${hardCoded[0]} should be colSpan={cols.count}` : "uses cols.count",
  );
}

console.log("\n— Coverage —\n");

const unimplemented = TABLE_REGISTRY.filter((t) => !IMPLEMENTATIONS[t.key]).map((t) => t.key);
ok(
  "Every registered table names its component",
  unimplemented.length === 0,
  unimplemented.length
    ? `${unimplemented.join(", ")} — registered, so the picker offers it, but nothing reads the preference`
    : `${TABLE_REGISTRY.length} tables`,
);

console.log(failures === 0 ? "\nAll table checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
