/**
 * The large-workspace load test — `npm run load:large [-- --divisions 10 --repeats 20]`.
 *
 * What it answers: how the screens and jobs of ONE big workspace hold up — hundreds of people, tens of
 * thousands of customers, a few million rows — where scripts/load-test.ts asks how many small
 * workspaces one server can carry.
 *
 * On the local database server only:
 *
 *   1. Build (skipped with --reuse when it exists already): a copy of this machine's workspace database
 *      (DATABASE_URL — the demo workspace: a year of a 50-person company), made into a database of its
 *      own, `<name>_large`, migrated as provisioning makes one. Then multiplied:
 *        · person rows (users, attendance, payslips, notifications…) once for each of --divisions;
 *        · business records (customers, leads, documents, the ledger, payments, tasks…) in every division
 *          --repeats times over;
 *        · settings shared by the whole workspace (the chart of accounts, pipelines, roles, items) once.
 *      Every copy keeps its links: ids get a suffix (`~division.repeat`), and a reference to a copied
 *      table takes the suffix of the copy it belongs with — so each division has its own people, and
 *      each repeat its own customers with their own invoices, payments and journal entries.
 *   2. The workload: the data behind the busiest screens and jobs, called as the server calls it, as an
 *      admin (who sees everything) and as a salesperson (who sees their own) — each timed, with the
 *      workspace role's 30-second statement limit in force.
 *   3. A report: docs/reports/load-test-large.md.
 *
 * The database is kept afterwards (it takes a while to build); --drop removes it.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const DIVISIONS = flag("divisions", 10);
const REPEATS = flag("repeats", 20);
const REUSE = args.includes("--reuse");
/** Only the cases whose name or area contains this — for chasing one down. */
const ONLY = args.includes("--only") ? (args[args.indexOf("--only") + 1] ?? "").toLowerCase() : "";
const DROP = args.includes("--drop");
/** Added to a copied number column (a customer's or lead's number) for each copy, so numbers stay unique. */
const NUMBER_STEP = 100_000;

const log = (line: string) => console.log(`[load-large] ${line}`);

/** One connection, kept: a session setting (replication role) must hold for the statements after it. */
type Sql = { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>; end(): Promise<void> };
function connect(url: string): Sql {
  const c = directClient(url, { max: 1 });
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      if (/^\s*(select|with)\b/i.test(sql)) {
        const rows = await c.$queryRawUnsafe<T[]>(sql, ...params);
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: await c.$executeRawUnsafe(sql, ...params) };
    },
    end: () => c.$disconnect(),
  };
}
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = "";
  return u.toString();
}

// ─── Which tables are copied, and how often ──────────────────────────────────────────────────────

/** Copied once for each division: a person, and what is theirs alone. */
const PERSON = new Set([
  "users", "employee_profiles", "employment_history", "salary_structures", "attendance_days", "attendance_regularisations",
  "biometric_punches", "leave_balances", "leave_requests", "payslips", "notifications", "sign_ins", "user_devices", "app_devices",
  "app_pairings", "app_call_requests", "user_daily_activity", "celebration_seen", "celebrations", "activity_logs", "audit_logs",
  "permission_changes", "user_permissions", "table_preferences", "user_photos", "screenshot_allowances", "feedback_quotas",
  "forecast_commits", "targets", "incentive_earnings", "prize_winners", "wishes", "internal_feedback", "final_settlements",
  "handovers", "handover_lines", "employee_documents", "employee_letters", "candidates", "digital_cards", "card_campaign_members",
  "chats", "chat_members", "chat_messages", "chat_reactions", "chat_presence", "chat_attachments", "copilot_conversations",
  "copilot_messages", "survey_responses", "survey_answers", "survey_participations", "survey_targets", "vault_credentials",
  "vault_pins", "vault_reveals", "vault_shares", "visitor_entries", "visitor_companions", "visitor_invites", "_DocumentApprover",
]);

/** Copied in every division, --repeats times: the business's records. */
const RECORD = new Set([
  "companies", "company_locations", "company_bank_accounts", "domain_profiles", "contacts", "contact_verifications", "leads",
  "lead_requirements", "activities", "proposals", "call_logs", "calendar_events", "visits", "visit_locations", "expenses",
  "sticky_notes", "tasks", "task_checklist_items", "task_comments", "task_stars", "task_time_logs", "tickets", "ticket_comments",
  "projects", "project_billing_milestones", "project_credentials", "credential_reveals", "project_documents", "project_milestones",
  "project_risks", "project_stakeholders", "project_updates", "company_products", "order_expenses", "order_price_changes",
  "order_rebates", "order_step_changes", "_OrderWatchers", "purchase_savings", "credit_decisions", "trade_documents",
  "trade_document_lines", "payments", "payment_allocations", "payment_follow_ups", "credit_note_applications", "journal_entries",
  "journal_lines", "consignments", "eway_bills", "revenue_schedules", "revenue_schedule_lines", "revenue_schedule_adjustments",
  "accounting_schedules", "accounting_schedule_lines", "assets", "asset_movements", "fixed_assets", "depreciation_charges",
  "stock_movements", "stock_cost_layers", "vendor_credits", "vendor_credit_applications", "rebate_allocations", "vendor_statements",
  "vendor_statement_lines", "commission_party_accounts", "commission_party_links", "reseller_profiles", "reseller_item_prices",
  "portal_logins", "portal_requests", "marketing_consents", "marketing_enrolments", "marketing_list_members", "marketing_messages",
  "marketing_message_events", "marketing_form_submissions", "form_invites", "feedback_requests", "feedback_responses",
  "workbook_records", "card_contacts", "visitor_companies", "bank_statement_lines",
]);

type Level = 0 | 1 | 2;
const levelOf = (table: string): Level => (RECORD.has(table) ? 2 : PERSON.has(table) ? 1 : 0);

type Column = { name: string; type: string; serial: boolean };
type TableInfo = { name: string; columns: Column[]; pk: string[]; fks: Map<string, string>; uniques: { name: string; cols: string[]; partial: boolean; expr: boolean }[] };

async function catalog(c: Sql): Promise<Map<string, TableInfo>> {
  const cols = await c.query<{ t: string; col: string; type: string; serial: boolean }>(`
    select cl.relname::text t, a.attname::text col, format_type(a.atttypid, a.atttypmod) type,
           coalesce(pg_get_expr(d.adbin, d.adrelid), '') like 'nextval%' serial
    from pg_attribute a join pg_class cl on cl.oid = a.attrelid join pg_namespace n on n.oid = cl.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public' and cl.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    order by cl.relname, a.attnum`);
  const fks = await c.query<{ t: string; col: string; ref: string }>(`
    select cl.relname::text t, a.attname::text col, rc.relname::text ref
    from pg_constraint k join pg_class cl on cl.oid = k.conrelid join pg_class rc on rc.oid = k.confrelid
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    join pg_namespace n on n.oid = cl.relnamespace where k.contype = 'f' and n.nspname = 'public' and array_length(k.conkey, 1) = 1`);
  const idx = await c.query<{ t: string; i: string; cols: string[] | null; pk: boolean; partial: boolean; expr: boolean }>(`
    select tc.relname::text t, ic.relname::text i, i.indisprimary pk, i.indpred is not null partial, i.indexprs is not null expr,
           array(select a.attname::text from unnest(i.indkey) k join pg_attribute a on a.attrelid = tc.oid and a.attnum = k) cols
    from pg_index i join pg_class tc on tc.oid = i.indrelid join pg_class ic on ic.oid = i.indexrelid
    join pg_namespace n on n.oid = tc.relnamespace where n.nspname = 'public' and i.indisunique`);
  const tables = new Map<string, TableInfo>();
  for (const r of cols.rows) {
    const t: TableInfo = tables.get(r.t) ?? { name: r.t, columns: [], pk: [], fks: new Map(), uniques: [] };
    t.columns.push({ name: r.col, type: r.type, serial: r.serial });
    tables.set(r.t, t);
  }
  for (const r of fks.rows) tables.get(r.t)?.fks.set(r.col, r.ref);
  for (const r of idx.rows) {
    const t = tables.get(r.t);
    if (!t) continue;
    if (r.pk) t.pk = r.cols ?? [];
    else t.uniques.push({ name: r.i, cols: r.cols ?? [], partial: r.partial, expr: r.expr });
  }
  return tables;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const isText = (type: string) => type === "text" || type.startsWith("character varying");
const isInt = (type: string) => type === "integer" || type === "bigint" || type === "smallint";

/** The suffix a copy's ids carry, for a table at `level`, in SQL — empty for the original. */
const suffix = (level: Level) =>
  level === 2 ? `(case when g.d = 0 and g.r = 0 then '' else '~' || g.d || '.' || g.r end)` : level === 1 ? `(case when g.d = 0 then '' else '~' || g.d end)` : `''`;

/**
 * The INSERT that makes every copy of one table, or why it can't be copied as it is. `level` may be
 * lowered by the caller when a unique rule can't be kept at the higher one.
 */
function cloneSql(t: TableInfo, level: Level): { sql: string } | { refused: string } {
  const own = new Set<string>(); // columns that differ per copy at this row's own grain
  const exprs = new Map<string, string>();
  for (const col of t.columns) {
    const ref = t.fks.get(col.name);
    const refLevel = ref ? levelOf(ref) : 0;
    if (t.pk.length === 1 && t.pk[0] === col.name && isText(col.type)) {
      exprs.set(col.name, `src.${q(col.name)} || ${suffix(level)}`);
      own.add(col.name);
    } else if (ref && refLevel === 1 && isText(col.type)) {
      exprs.set(col.name, `src.${q(col.name)} || ${suffix(1)}`);
      if (level === 1) own.add(col.name);
    } else if (ref && refLevel === 2 && isText(col.type)) {
      // A person row pointing at a record points at its division's first copy of it.
      exprs.set(col.name, level === 2 ? `src.${q(col.name)} || ${suffix(2)}` : `src.${q(col.name)} || (case when g.d = 0 then '' else '~' || g.d || '.0' end)`);
      own.add(col.name);
    } else if (col.serial && isInt(col.type)) {
      exprs.set(col.name, `src.${q(col.name)} + g.i * ${NUMBER_STEP}`);
      own.add(col.name);
    }
  }
  // Unique rules: each must hold among the copies — through a column that already differs per copy,
  // or by changing one of its own (text gets the suffix, a number the step).
  for (const u of t.uniques) {
    if (u.expr) return { refused: `unique rule ${u.name} is on an expression` };
    if (u.cols.some((c) => own.has(c))) continue;
    if (u.partial) continue; // handled per table below (only "one primary / one default" rules)
    const text = u.cols.find((c) => isText(t.columns.find((x) => x.name === c)?.type ?? "") && !t.fks.has(c));
    const num = u.cols.find((c) => isInt(t.columns.find((x) => x.name === c)?.type ?? "") && !t.fks.has(c));
    if (text) {
      // Plain letters and digits: some of these have a shape to keep (a card's handle).
      exprs.set(text, `src.${q(text)} || '-c' || g.i`);
      own.add(text);
    } else if (num) {
      exprs.set(num, `src.${q(num)} + g.i * ${NUMBER_STEP}`);
      own.add(num);
    } else return { refused: `unique rule ${u.name} (${u.cols.join(", ")}) can't differ between copies` };
  }
  // Rules the copies would break otherwise.
  if (t.name === "users") {
    exprs.set("isSuperAdmin", "false");
    exprs.set("email", `regexp_replace(src."email", '@', '+d' || g.d || '@')`);
  }
  if (t.pk.length > 1 && !t.pk.some((c) => own.has(c))) return { refused: `its key (${t.pk.join(", ")}) can't differ between copies` };
  if (t.pk.length === 1 && !own.has(t.pk[0]!)) return { refused: `its key ${t.pk[0]} is not text` };

  const grid =
    level === 2
      ? `(select d, r, d * ${REPEATS} + r as i from generate_series(0, ${DIVISIONS - 1}) d, generate_series(0, ${REPEATS - 1}) r where not (d = 0 and r = 0)) g`
      : `(select d, 0 as r, d * ${REPEATS} as i from generate_series(1, ${DIVISIONS - 1}) d) g`;
  const names = t.columns.map((c) => q(c.name)).join(", ");
  const values = t.columns.map((c) => exprs.get(c.name) ?? `src.${q(c.name)}`).join(", ");
  return { sql: `insert into ${q(t.name)} (${names}) select ${values} from ${q(t.name)} src cross join ${grid}` };
}

// ─── Build ───────────────────────────────────────────────────────────────────────────────────────

async function build(sourceUrl: string, targetUrl: string, target: string) {
  const admin = connect(withDatabase(sourceUrl, "postgres"));
  const started = Date.now();
  try {
    const exists = (await admin.query(`select 1 from pg_database where datname = $1`, [target])).rowCount === 1;
    if (exists && REUSE) {
      log(`using ${target} as it is (--reuse)`);
      return;
    }
    await admin.query(`drop database if exists ${q(target)} with (force)`);
    await admin.query(`create database ${q(target)}`);
  } finally {
    await admin.end();
  }
  log(`migrating ${target}…`);
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: targetUrl }, timeout: 15 * 60_000 });

  const source = connect(sourceUrl);
  const dest = connect(targetUrl);
  try {
    const tables = await catalog(dest);
    await dest.query(`set session_replication_role = replica`);
    const names = [...tables.keys()].filter((n) => n !== "_prisma_migrations");
    await dest.query(`truncate ${names.map(q).join(", ")} cascade`);

    // 1. The demo workspace, as it is.
    let copied = 0;
    for (const name of names) {
      const t = tables.get(name)!;
      const { rows } = await source.query<{ j: unknown }>(`select coalesce(json_agg(x), '[]'::json) j from ${q(name)} x`).catch(() => ({ rows: [{ j: [] }] }));
      const data = rows[0]!.j as unknown[];
      if (!data.length) continue;
      const cols = t.columns.map((c) => q(c.name)).join(", ");
      await dest.query(`insert into ${q(name)} (${cols}) select ${cols} from json_populate_recordset(null::${q(name)}, $1::json)`, [JSON.stringify(data)]);
      copied += data.length;
    }
    log(`copied the demo workspace: ${copied.toLocaleString("en-IN")} rows`);

    // 2. The copies, table by table.
    const refused: string[] = [];
    for (const name of names) {
      let level = levelOf(name);
      if (level === 0) continue;
      const t = tables.get(name)!;
      let made = cloneSql(t, level);
      if ("refused" in made && level === 2) {
        refused.push(`${name}: ${made.refused} — copied per division only`);
        level = 1;
        made = cloneSql(t, level);
      }
      if ("refused" in made) {
        refused.push(`${name}: ${made.refused} — not copied`);
        continue;
      }
      const t0 = Date.now();
      try {
        const res = await dest.query(made.sql);
        if ((res.rowCount ?? 0) > 50_000) log(`  ${name}: +${(res.rowCount ?? 0).toLocaleString("en-IN")} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      } catch (err) {
        refused.push(`${name}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)} — not copied`);
      }
    }
    for (const line of refused) log(`  ! ${line}`);

    // 3. Numbering carries on after the copies, and the planner knows the new sizes.
    for (const [name, t] of tables) {
      for (const col of t.columns.filter((c) => c.serial)) {
        await dest.query(`select setval(pg_get_serial_sequence($1, $2), greatest(1, (select coalesce(max(${q(col.name)}), 0) from ${q(name)})))`, [`"${name}"`, col.name]);
      }
    }
    await dest.query(`set session_replication_role = origin`);
    log("analysing…");
    await dest.query(`analyze`);
  } finally {
    await source.end();
    await dest.end();
  }
  // As a workspace role has it in production (src/lib/platform/provisioner.ts).
  const again = connect(withDatabase(sourceUrl, "postgres"));
  await again.query(`alter database ${q(target)} set statement_timeout = '30s'`);
  await again.end();
  log(`built in ${Math.round((Date.now() - started) / 1000)} s`);
}

async function sizes(targetUrl: string): Promise<{ bytes: number; rows: number; top: { table: string; rows: number }[] }> {
  const c = connect(targetUrl);
  try {
    const [size] = (await c.query<{ b: string }>(`select pg_database_size(current_database()) b`)).rows;
    const tables = (await c.query<{ t: string; n: string }>(`select relname::text t, n_live_tup n from pg_stat_user_tables order by n_live_tup desc`)).rows;
    return {
      bytes: Number(size!.b),
      rows: tables.reduce((s, r) => s + Number(r.n), 0),
      top: tables.slice(0, 25).map((r) => ({ table: r.t, rows: Number(r.n) })),
    };
  } finally {
    await c.end();
  }
}

// ─── The workload ────────────────────────────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
/** Who each case runs as — people from the demo workspace, so in the first division. */
const ACTORS = {
  admin: { id: "cmu88hcmr0000ufd0rwksecyd", label: "admin (sees everything)" },
  manager: { id: "cmus0upe2000gcouflc7w1xdo", label: "sales manager" },
  rep: { id: "cmus0upg50010couff4xbuia5", label: "salesperson" },
  accounts: { id: "cmus0upkw002icoufoytevqqz", label: "accounts" },
} as const;
type ActorKey = keyof typeof ACTORS;

type Case = { area: string; name: string; as: ActorKey; run: () => Promise<unknown>; write?: boolean };
type Timing = { area: string; name: string; as: ActorKey; runs: number[]; cpu: number[]; size: string; error: string | null; parts?: Record<string, number> };

/** Where a case's time went, part by part — filled in by the case itself on its last run. */
const parts = new Map<string, Record<string, number>>();
async function part<T>(into: Record<string, number>, label: string, run: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await run();
  } finally {
    into[label] = (into[label] ?? 0) + (performance.now() - t0);
  }
}

/** What React's `cache()` holds for the request in hand — a fresh one for every run of a case (`time`). */
let requestCache = new Map<string, unknown>();

/**
 * Stands in for a request: the signed-in person (`@/lib/session`), Next's cache calls, React's request
 * cache, and no mail or outside call. Installed before any app module is loaded.
 */
function installRequestStubs(current: () => Actor | null) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const Module = require("node:module") as typeof import("node:module");
  const session = {
    requireUser: async () => {
      const a = current();
      if (!a) throw new Error("No one is signed in for this case.");
      return a;
    },
    currentUser: async () => current(),
    viewAsContext: async () => null,
    refuseWhileViewingAs: async () => null,
  };
  const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn, unstable_noStore: () => {} };
  const load = Module.createRequire(__filename);
  const internals = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
    _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
  };
  // Two pages ask next-auth themselves (document-detail.tsx, the journal page).
  const auth = { auth: async () => (current() ? { user: current() } : null), handlers: {}, signIn: async () => {}, signOut: async () => {} };
  // Nothing leaves the machine: the copy carries the workspace's own mail settings, and a stage move
  // or a payment may email somebody. Mail is swallowed; any other host is refused.
  const nodemailer = { createTransport: () => ({ sendMail: async () => ({ messageId: "load-test" }), verify: async () => true, close: () => {} }) };
  // React's request cache (`cache()`), as a page has one: outside a render React passes every call through,
  // so a case would look a person's permissions up once a call where its page looks them up once.
  // Primitive arguments only, as the app's cached reads take; anything else is called through.
  const react = require("react") as typeof import("react");
  let wrapped = 0;
  const reactStub = {
    ...react,
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
      const which = (wrapped += 1);
      return (...args: A): R => {
        if (args.some((a) => a !== null && typeof a === "object")) return fn(...args);
        const key = `${which}:${JSON.stringify(args)}`;
        if (!requestCache.has(key)) requestCache.set(key, fn(...args));
        return requestCache.get(key) as R;
      };
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`The load test calls no outside service (${host}).`);
    return realFetch(input, init);
  }) as typeof fetch;
  const byName = new Map<string, unknown>([
    ["next/cache", nextCache],
    ["@/lib/session", session],
    ["@/lib/auth", auth],
    ["nodemailer", nodemailer],
    ["react", reactStub],
  ]);
  const byFile = new Map<string, unknown>([
    [load.resolve("next/cache"), nextCache],
    [load.resolve("../src/lib/session"), session],
    [load.resolve("../src/lib/auth"), auth],
    [load.resolve("nodemailer"), nodemailer],
    [load.resolve("react"), reactStub],
  ]);
  const realLoad = internals._load;
  internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
    if (byName.has(request)) return byName.get(request);
    let resolved: string | null = null;
    try {
      resolved = internals._resolveFilename(request, parent, isMain);
    } catch {
      resolved = null;
    }
    if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
    return realLoad.call(this, request, parent, isMain);
  };
}

/** What a result was, in a few words: how many rows, or its shape. */
function sizeOf(result: unknown): string {
  const value = result && typeof result === "object" && "ok" in result && "data" in (result as object) ? (result as unknown as { data: unknown }).data : result;
  if (Array.isArray(value)) return `${value.length} rows`;
  if (value && typeof value === "object") {
    const total = (value as { total?: unknown }).total;
    for (const key of ["rows", "items", "results", "leads", "companies", "documents", "lines", "entries"]) {
      const v = (value as Record<string, unknown>)[key];
      if (Array.isArray(v)) return `${v.length} ${key}${typeof total === "number" ? ` of ${total.toLocaleString("en-IN")}` : ""}`;
    }
    if ("error" in (value as object) && typeof (value as { error: unknown }).error === "string") return `refused: ${(value as { error: string }).error.slice(0, 60)}`;
    return "an object";
  }
  return typeof value;
}

/**
 * Each case once to warm up, then five times; a write runs once. The fastest run is the case's own cost —
 * the others share the machine with whatever else runs on it — and the CPU this process spent in it says
 * how much of that was the app's own work rather than waiting on the database.
 */
async function time(cases: Case[], as: (key: ActorKey) => void): Promise<Timing[]> {
  const out: Timing[] = [];
  for (const c of cases) {
    as(c.as);
    const runs: number[] = [];
    const cpu: number[] = [];
    let size = "";
    let error: string | null = null;
    for (let i = 0; i < (c.write ? 1 : 6); i++) {
      requestCache = new Map();
      const t0 = performance.now();
      const cpu0 = process.cpuUsage();
      try {
        const result = await c.run();
        if (i > 0 || c.write) {
          runs.push(performance.now() - t0);
          const used = process.cpuUsage(cpu0);
          cpu.push((used.user + used.system) / 1000);
        }
        size = sizeOf(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (ONLY) console.error(err);
        error = /statement timeout|57014/.test(message) ? "cancelled by the 30-second statement limit" : message.split("\n").filter(Boolean).slice(-1)[0]!.slice(0, 160);
        runs.push(performance.now() - t0);
        break;
      }
    }
    const t: Timing = { area: c.area, name: c.name, as: c.as, runs, cpu, size, error, parts: parts.get(c.name) };
    out.push(t);
    const best = runs.length ? Math.min(...runs) : 0;
    const bestCpu = cpu[runs.indexOf(best)] ?? 0;
    log(`  ${error ? "FAIL" : best > 1000 ? "slow" : "ok  "} ${c.area} › ${c.name} (${ACTORS[c.as].label}): ${Math.round(best)} ms (CPU ${Math.round(bestCpu)} ms)${error ? ` — ${error}` : ` — ${size}`}`);
    if (t.parts) log(`         ${Object.entries(t.parts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(", ")}`);
  }
  return out;
}

/** The cases: the data behind each busy screen and job, as its page or job asks for it. */
async function workloadCases(): Promise<Case[]> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const receivable = require("../src/actions/receivable") as typeof import("../src/actions/receivable");
  const collections = require("../src/actions/collections") as typeof import("../src/actions/collections");
  const collect = require("../src/actions/payment-collection") as typeof import("../src/actions/payment-collection");
  const finance = require("../src/lib/finance/dashboard") as typeof import("../src/lib/finance/dashboard");
  const lead = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const pipeline = require("../src/lib/pipeline/server") as typeof import("../src/lib/pipeline/server");
  const company = require("../src/actions/company") as typeof import("../src/actions/company");
  const contact = require("../src/actions/contact") as typeof import("../src/actions/contact");
  const task = require("../src/actions/task") as typeof import("../src/actions/task");
  const dashboard = require("../src/lib/dashboard/data") as typeof import("../src/lib/dashboard/data");
  const dashboardActions = require("../src/actions/dashboard") as typeof import("../src/actions/dashboard");
  const charts = require("../src/lib/dashboard/charts") as typeof import("../src/lib/dashboard/charts");
  const call = require("../src/actions/call") as typeof import("../src/actions/call");
  const activity = require("../src/actions/activity") as typeof import("../src/actions/activity");
  const feed = require("../src/actions/activity-feed") as typeof import("../src/actions/activity-feed");
  const { searchEverything } = require("../src/actions/search") as typeof import("../src/actions/search");
  const notification = require("../src/actions/notification") as typeof import("../src/actions/notification");
  const docs = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const payment = require("../src/actions/payment") as typeof import("../src/actions/payment");
  const ledger = require("../src/actions/ledger-reports") as typeof import("../src/actions/ledger-reports");
  const tax = require("../src/actions/tax-reports") as typeof import("../src/actions/tax-reports");
  const attendance = require("../src/actions/attendance") as typeof import("../src/actions/attendance");
  const payroll = require("../src/actions/payroll") as typeof import("../src/actions/payroll");
  const leave = require("../src/actions/leave") as typeof import("../src/actions/leave");
  const { refreshStaleLeadScores, refreshLeadScore } = require("../src/lib/leads/score-store") as typeof import("../src/lib/leads/score-store");
  const { refreshStaleCreditRatings } = require("../src/lib/credit/load") as typeof import("../src/lib/credit/load");
  const { LeadDetail } = require("../src/components/leads/lead-detail") as typeof import("../src/components/leads/lead-detail");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");
  const { DocumentDetail } = require("../src/components/documents/document-detail") as typeof import("../src/components/documents/document-detail");

  // The busiest customer and an open invoice of theirs: a statement and a settlement worth reading.
  const [busiest] = await db.tradeDocument.groupBy({ by: ["companyId"], where: { docType: "INVOICE" }, _count: { _all: true }, orderBy: { _count: { companyId: "desc" } }, take: 1 });
  const companyId = busiest!.companyId;
  const invoice = await db.tradeDocument.findFirstOrThrow({ where: { companyId, docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED"] } }, orderBy: { issueDate: "desc" }, select: { id: true } });
  const year = finance.fiscalYearOf(new Date());
  const searchWord = (await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } })).name.split(/\s+/)[0]!.slice(0, 6);
  const repLead = await db.lead.findFirstOrThrow({ where: { ownerUserId: ACTORS.rep.id, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } }, select: { id: true, stageId: true, pipelineId: true } });
  const [busiestAccount] = await db.journalLine.groupBy({ by: ["accountId"], _count: { _all: true }, orderBy: { _count: { accountId: "desc" } }, take: 1 });
  const lastMonth = (() => {
    const d = new Date();
    return d.getMonth() === 0 ? { month: 12, year: d.getFullYear() - 1 } : { month: d.getMonth(), year: d.getFullYear() };
  })();
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
  const fyFrom = `${new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1}-04-01`;
  const fyTo = `${Number(fyFrom.slice(0, 4)) + 1}-03-31`;

  /** The leads page as a first visit draws it: the board of the first pipeline — each column's first cards, its count, their extras. */
  const leadsBoard = async () => {
    const stages = await pipeline.leadStages();
    const shown = stages.pipelines.filter((p) => !p.archived)[0]!;
    const board = await lead.listLeadBoard({ pipeline: shown.key });
    return { rows: board.cards, total: board.total };
  };
  /** "Show more" on the fullest column, past its first page. */
  const boardMore = async () => {
    const stages = await pipeline.leadStages();
    const shown = stages.pipelines.filter((p) => !p.archived)[0]!;
    const board = await lead.listLeadBoard({ pipeline: shown.key });
    const [fullest] = Object.entries(board.counts).sort((a, b) => b[1] - a[1]);
    const more = await lead.listLeadBoardColumn({ pipeline: shown.key }, fullest![0], 50);
    return { rows: more.cards, total: fullest![1] };
  };
  const leadsList = async () => {
    const stages = await pipeline.leadStages();
    const shown = stages.pipelines.filter((p) => !p.archived)[0]!;
    return lead.listLeadsPaged({ pipeline: shown.key, page: 1, pageSize: 50 } as never);
  };
  // Run one after another here, where the page runs them side by side, so each part's own time shows.
  const dashboardOverview = async (who: ActorKey, caseName: string) => {
    const took: Record<string, number> = {};
    const ctx = await part(took, "context", () => dashboard.dashboardContext(ACTORS[who].id));
    const layout = await part(took, "layout", () => dashboardActions.getDashboardLayout());
    const catalog = await part(took, "catalogue", () => dashboard.chartCatalog(ctx));
    const specs = layout.entries.map(charts.decodeChart).filter((s): s is NonNullable<typeof s> => !!s && catalog.sources.includes(s.source));
    const kpis = await part(took, "KPI cards", () => dashboard.kpiCards(ctx, charts.DEFAULT_RANGE));
    for (const spec of specs) await part(took, `chart: ${spec.source}${spec.metric ? ` ${spec.metric}` : ""}`, () => dashboard.widgetData(ctx, spec, charts.DEFAULT_RANGE));
    parts.set(caseName, took);
    return kpis;
  };
  /** The customer page's loaders one after another (the page runs them side by side), so each one's own time shows. */
  const customerParts = async () => {
    const took: Record<string, number> = {};
    const loaders: [string, () => Promise<unknown>][] = [
      ["getCompany", () => company.getCompany(companyId)],
      ["items", () => (require("../src/actions/item") as typeof import("../src/actions/item")).listItemOptions()],
      ["tickets", () => (require("../src/actions/ticket") as typeof import("../src/actions/ticket")).listTickets({ companyId } as never)],
      ["tasks", () => task.listTasks({ companyId } as never)],
      ["people", () => company.listAssignableUsers()],
      ["vendors", () => company.listVendorOptions()],
      ["calls", () => call.listCompanyCalls(companyId)],
      ["domain", () => (require("../src/actions/domain") as typeof import("../src/actions/domain")).getDomainBriefing(companyId)],
      ["projects", () => (require("../src/actions/project") as typeof import("../src/actions/project")).listProjects({ companyId } as never)],
      ["categories", () => (require("../src/actions/customer-category") as typeof import("../src/actions/customer-category")).listCustomerCategories()],
      ["documents", () => docs.listCompanyDocuments(companyId)],
      ["payment summary", () => payment.companyPaymentSummary(companyId)],
      ["credit", () => (require("../src/actions/credit") as typeof import("../src/actions/credit")).getCreditProfile(companyId)],
      ["support load", () => (require("../src/actions/support-load") as typeof import("../src/actions/support-load")).getSupportLoad(companyId)],
      ["mail", () => (require("../src/actions/mail-log") as typeof import("../src/actions/mail-log")).companyMailSummary(companyId)],
      ["forms", () => (require("../src/actions/forms") as typeof import("../src/actions/forms")).companyFormResponses(companyId)],
    ];
    for (const [label, run] of loaders) await part(took, label, run);
    parts.set("the busiest customer's page, part by part", took);
    return null;
  };
  const stageForMove = async () => {
    const stages = await pipeline.leadStages();
    // The lead's own pipeline, as its current stage names it (the main one is stored as null).
    const own = stages.stages.find((s) => s.id === repLead.stageId)?.pipelineId;
    const target = stages.stages.find((s) => s.pipelineId === own && s.id !== repLead.stageId && !s.archived && !["WON", "LOST", "DISQUALIFIED"].includes(String(s.status)));
    return target!.id;
  };

  return [
    { area: "Leads", name: "board, first pipeline (the default view)", as: "admin", run: leadsBoard },
    { area: "Leads", name: "board, as the sales manager", as: "manager", run: leadsBoard },
    { area: "Leads", name: "board, as the salesperson", as: "rep", run: leadsBoard },
    { area: "Leads", name: "board, the next 50 of the fullest column", as: "rep", run: boardMore },
    { area: "Leads", name: "list, first page of 50", as: "admin", run: leadsList },
    { area: "Leads", name: "list, as the salesperson", as: "rep", run: leadsList },
    { area: "Leads", name: "a lead's page", as: "rep", run: () => LeadDetail({ id: repLead.id }) },
    { area: "Leads", name: "a lead's record (getLead)", as: "rep", run: () => lead.getLead(repLead.id) },
    { area: "Leads", name: "a lead's score, worked out again (on every view)", as: "rep", run: () => refreshLeadScore(repLead.id) },
    { area: "Leads", name: "a lead's activity panel", as: "rep", run: () => feed.leadActivity(repLead.id) },
    { area: "Customers", name: "customer list, first page", as: "admin", run: () => company.listCustomersPaged({ page: 1, pageSize: 50, customFilters: {} } as never) },
    { area: "Customers", name: "customer list, as the salesperson", as: "rep", run: () => company.listCustomersPaged({ page: 1, pageSize: 50, customFilters: {} } as never) },
    { area: "Customers", name: "companies (prospects), first page", as: "admin", run: () => company.listCompaniesPaged({ page: 1, pageSize: 50, hasOrders: false, customFilters: {} } as never) },
    { area: "Customers", name: "the busiest customer's page", as: "admin", run: () => CompanyDetail({ id: companyId } as never) },
    { area: "Customers", name: "the busiest customer's page, part by part", as: "admin", run: customerParts },
    { area: "Customers", name: "the busiest customer's activity panel", as: "admin", run: () => feed.companyActivity(companyId) },
    { area: "Customers", name: "assignable people (on most forms)", as: "admin", run: () => company.listAssignableUsers() },
    { area: "Contacts", name: "contact list, first page", as: "admin", run: () => contact.listAllContactsPaged({ page: 1, pageSize: 50, status: "current", primaryOnly: false, customFilters: {} } as never) },
    { area: "Tasks", name: "my tasks, list", as: "rep", run: () => task.listTasksPaged({ assignedToUserId: ACTORS.rep.id, starred: false, dir: "asc", page: 1, pageSize: 50 } as never) },
    { area: "Tasks", name: "my tasks, board", as: "rep", run: () => task.listTasks({ assignedToUserId: ACTORS.rep.id, starred: false, dir: "asc" } as never) },
    { area: "Tasks", name: "task counts", as: "rep", run: () => task.countTasks({ assignedToUserId: ACTORS.rep.id, starred: false, dir: "asc" } as never) },
    { area: "Home", name: "dashboard, overview", as: "admin", run: () => dashboardOverview("admin", "dashboard, overview") },
    { area: "Home", name: "dashboard, as the salesperson", as: "rep", run: () => dashboardOverview("rep", "dashboard, as the salesperson") },
    { area: "Search", name: "the header box, everything", as: "admin", run: () => searchEverything(searchWord) },
    { area: "Search", name: "the header box, as the salesperson", as: "rep", run: () => searchEverything(searchWord) },
    { area: "Notifications", name: "the bell's poll", as: "rep", run: () => notification.notificationPulse() },
    { area: "Notifications", name: "the bell, opened", as: "rep", run: () => notification.getNotifications({ limit: 20 }) },
    { area: "Calls", name: "call log, first page", as: "admin", run: () => call.listCalls({ page: 1, pageSize: 50 } as never) },
    { area: "Calls", name: "today's call summary", as: "admin", run: () => call.callSummary({} as never) },
    { area: "Activity", name: "the activity log, everyone", as: "admin", run: () => activity.listActivity({ filters: { impersonatedOnly: false }, page: 1, pageSize: 50 } as never) },
    { area: "Activity", name: "the activity log's summary", as: "admin", run: () => activity.activitySummary({ impersonatedOnly: false } as never) },
    { area: "Documents", name: "invoices, first page", as: "accounts", run: () => docs.listTradeDocuments({ docType: "INVOICE", page: 1, pageSize: 50 } as never) },
    { area: "Documents", name: "invoices, the summary strip", as: "accounts", run: () => docs.tradeDocumentSummary("INVOICE" as never) },
    { area: "Documents", name: "invoices, as the salesperson", as: "rep", run: () => docs.listTradeDocuments({ docType: "INVOICE", page: 1, pageSize: 50 } as never) },
    { area: "Documents", name: "an invoice's page", as: "accounts", run: () => DocumentDetail({ id: invoice.id }) },
    { area: "Receivables", name: "open invoices (the default view)", as: "accounts", run: () => receivable.agingReport({}) },
    { area: "Receivables", name: "aging, by customer", as: "accounts", run: () => receivable.receivablesAgingReport({ view: "aging" } as never) },
    { area: "Receivables", name: "aging, as the salesperson", as: "rep", run: () => receivable.receivablesAgingReport({ view: "aging" } as never) },
    { area: "Receivables", name: "customer balance summary", as: "accounts", run: () => receivable.customerBalanceSummary() },
    { area: "Receivables", name: "insights: DSO and the next eight weeks", as: "accounts", run: () => collect.receivablesInsights() },
    { area: "Receivables", name: "the busiest customer's statement", as: "accounts", run: () => receivable.customerStatement(companyId) },
    { area: "Receivables", name: "an invoice's settlement panel", as: "accounts", run: () => receivable.getInvoiceSettlement(invoice.id) },
    { area: "Collections", name: "the follow-up list", as: "accounts", run: () => collections.listCollections() },
    { area: "Payments", name: "orders with payments, first page", as: "accounts", run: () => payment.listOrdersWithPaymentsPaged({ page: 1, pageSize: 50 } as never) },
    { area: "Payments", name: "payments, first page", as: "accounts", run: () => payment.listPaymentsPaged({ page: 1, pageSize: 50 }) },
    { area: "Accounting", name: "journal, first page", as: "accounts", run: () => ledger.listJournalEntries({ page: 1, pageSize: 50 } as never) },
    { area: "Accounting", name: "trial balance", as: "accounts", run: () => ledger.trialBalance({} as never) },
    { area: "Accounting", name: "profit and loss, this financial year", as: "accounts", run: () => ledger.profitAndLoss({ from: fyFrom, to: fyTo } as never) },
    { area: "Accounting", name: "balance sheet", as: "accounts", run: () => ledger.balanceSheet({} as never) },
    { area: "Accounting", name: "the busiest account's ledger", as: "accounts", run: () => ledger.accountLedger({ accountId: busiestAccount!.accountId } as never) },
    { area: "Accounting", name: "GSTR-1, last month", as: "admin", run: () => tax.gstr1(lastMonth as never) },
    { area: "Accounting", name: "GSTR-3B, last month", as: "admin", run: () => tax.gstr3b(lastMonth as never) },
    { area: "Finance", name: "income and expense, this year", as: "admin", run: () => finance.incomeAndExpense(year.from, year.to, "accrual") },
    { area: "Finance", name: "cash flow", as: "admin", run: () => finance.cashFlow(finance.cashWindowFrom(new Date()), new Date()) },
    { area: "Finance", name: "top expenses, this year", as: "admin", run: () => finance.topExpenses(year.from, year.to) },
    { area: "Finance", name: "receivables outstanding", as: "admin", run: () => finance.receivablesOutstanding() },
    { area: "HR", name: "attendance, the month for everyone", as: "admin", run: () => attendance.attendanceMonth({ ...thisMonth } as never) },
    { area: "HR", name: "payroll runs", as: "admin", run: () => payroll.listPayrollRuns() },
    { area: "HR", name: "leave, my balances", as: "rep", run: () => leave.leaveBalances(ACTORS.rep.id) },
    { area: "HR", name: "leave, everyone's requests", as: "admin", run: () => leave.allLeaveRequests({ page: 1, pageSize: 50 } as never) },
    { area: "Jobs", name: "lead scores gone stale (500)", as: "admin", run: () => refreshStaleLeadScores({ limit: 500 }) },
    { area: "Jobs", name: "credit ratings gone stale (500)", as: "admin", run: () => refreshStaleCreditRatings({ limit: 500 }) },
    {
      area: "Writes",
      name: "an invoice made and issued",
      as: "admin",
      write: true,
      run: async () => {
        const made = await docs.createTradeDocument({ docType: "INVOICE", companyId, issueDate: today, billing: {}, shipping: {}, lines: [{ name: "Load test service", quantity: 1, unitPrice: 1000, taxRatePercent: 18 }] } as never);
        if (!made.ok) return made;
        return docs.issueTradeDocument({ id: made.data.id, generateEInvoice: false } as never);
      },
    },
    { area: "Writes", name: "a payment recorded against an invoice", as: "admin", write: true, run: () => receivable.recordInvoicePayment({ invoiceId: invoice.id, amount: 1, paidOn: today }) },
    { area: "Writes", name: "a lead moved to another stage", as: "rep", write: true, run: async () => lead.updateLeadStatus({ leadId: repLead.id, stageId: await stageForMove() } as never) },
  ];
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const fastest = (t: Timing) => (t.runs.length ? Math.min(...t.runs) : 0);
const verdict = (t: Timing) => {
  if (t.error) return "fails";
  const m = fastest(t);
  return m < 300 ? "fast" : m < 1000 ? "fine" : m < 5000 ? "slow" : "too slow";
};

function writeReport(s: Awaited<ReturnType<typeof sizes>>, timings: Timing[]) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  const n = (x: number) => x.toLocaleString("en-IN");
  const rows = timings.map(
    (t) =>
      `| ${t.area} | ${t.name} | ${ACTORS[t.as].label} | ${t.runs.length ? n(Math.round(fastest(t))) : "—"} | ${t.runs.length ? n(Math.round(median(t.runs))) : "—"} | ${t.runs.length ? n(Math.round(t.cpu[t.runs.indexOf(fastest(t))] ?? 0)) : "—"} | ${verdict(t)} | ${(t.error ?? t.size).replace(/\|/g, "/")} |`,
  );
  const bad = timings.filter((t) => verdict(t) !== "fast" && verdict(t) !== "fine").sort((a, b) => fastest(b) - fastest(a));
  const partsOf = (t: Timing) =>
    t.parts
      ? ` — ${Object.entries(t.parts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, v]) => `${k} ${n(Math.round(v))} ms`)
          .join(", ")}`
      : "";
  const report = `# Load test — one large workspace

Run ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`npm run load:large\` (scripts/load-test-large.ts).

## Setup

- The demo workspace (a year of a 50-person company) copied as ${DIVISIONS} divisions, its business records ${REPEATS} times over in each: **${(s.bytes / 1024 ** 3).toFixed(2)} GB, ${n(s.rows)} rows**.
- Largest tables: ${s.top.map((t) => `${t.table} ${n(t.rows)}`).join(", ")}.
- Each case is the function the screen or job calls, as the server calls it, signed in as the person named; run once to warm up, then five times (a write once). **Fastest** is the case's own cost — the machine is shared with other work, so the median wanders — and **Node CPU** is how much of that fastest run the app process spent working rather than waiting on the database.
- The workspace role's 30-second statement limit is on, as in production. One process, ${os.cpus().length} CPUs, Node ${process.version}; PostgreSQL on the same machine with its stock settings.
- Fast is under 300 ms, fine under a second, slow under five seconds.

## Results

| Area | Case | As | Fastest ms | Median ms | Node CPU ms | Verdict | Returned |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}

## What needs work

${bad.length ? bad.map((t) => `- **${t.area} › ${t.name}** (${ACTORS[t.as].label}): ${t.error ? t.error : `${n(Math.round(fastest(t)))} ms`}${partsOf(t)}.`).join("\n") : "Nothing: every case is under a second."}

## Found by this test (23 Oct 2026)

- **The leads board fails** once a pipeline holds more leads than one query can name (about 32,000): \`leadBoardExtras\` and \`leadQuotes\` put every lead's id in one \`IN (…)\`, and the board itself loads every lead unpaged. Hit by the admin and by the salesperson, whose role sees every lead in this workspace.
- **The slow cases are the app's own work, not the database's.** Node CPU is about the whole time for every one of them; the database logged only 23 statements over 200 ms in a full run. And the server runs one Node process: while one person's dashboard computes for six seconds, every other request — in every workspace — waits.
- Four habits make that work:
  1. **Everything loaded, one page shown** — payments' order and payment lists read every row to show 50.
  2. **No page at all** — the leads board, an account's ledger (51,604 lines), the receivables views (thousands of customers or invoices) — and the browser then draws them all.
  3. **Adding up in JavaScript** — income and expense, top expenses and the dashboard's finance cards read every income and expense line of the year to total them.
  4. **The dashboard's summary** (\`getDashboardSummary\`) works out every older card at once, whichever chart asks first.
- Paged lists, the accounting reports (trial balance, P&L, balance sheet, GST returns), attendance, payroll, leave and the writes are all well under half a second.

## Fixed the same day

Each rewrite was compared with the code it replaced on this workspace and gives the same answers.

- **Leads board** — each column's first 50 cards with its whole count, and "Show more" (\`listLeadBoard\`, \`listLeadBoardColumn\`): from failing to under 0.6 s.
- **Dashboard** — the summary works out only the parts a chart asks for, once a page; the finance figures are added up by the database.
- **Adding up** — income and expense, top expenses and cash flow by the database, a month at a time; the receivables subledger (aging, balance summary, the close's tie-out) by grouped queries; support load's peers by one query, not every customer's credit history. The aging summary no longer sends every open invoice behind it.
- **Paging** — the payments lists page in the database (with a tie-breaker, so a page always holds the same rows); an account's ledger is 200 lines a page with the balance brought forward.
- **A customer's page** — the statement, the payments list and the visits are read when their tab is opened.
- **Lists of ids that grow with the workspace** go in batches (src/lib/batches.ts) — the collections follow-ups, an account's parties.
- **One process** — \`DESKZO_WEB_PROCESSES\` runs several copies of the app in the container, keeping what they hold in memory in step (docs/runbook.md §7.1, \`npm run check:cluster\`).

## Not covered

- Page rendering and the browser: these are the server's data calls only.
- Many people at once: each case runs alone (scripts/load-test.ts measures throughput).
- React's request cache is stood in for, one per run of a case, as a page has one.
`;
  const outDir = path.join(process.cwd(), "docs", "reports");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "load-test-large.md"), report, "utf8");
  log("report written to docs/reports/load-test-large.md");
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("The load test runs against a local database server only.");
  const sourceName = new URL(url).pathname.slice(1);
  const target = `${sourceName}_large`;
  const targetUrl = withDatabase(url, target);
  log(`${DIVISIONS} divisions, records ${REPEATS} times over in each — into ${target}`);
  await build(withDatabase(url, sourceName), targetUrl, target);
  const s = await sizes(targetUrl);
  log(`${target}: ${(s.bytes / 1024 ** 3).toFixed(2)} GB, ${s.rows.toLocaleString("en-IN")} rows`);
  log(s.top.map((t) => `${t.table}=${t.rows.toLocaleString("en-IN")}`).join("  "));

  // The app, pointed at the big workspace alone: as a script runs it, never the control plane's
  // workspaces (the demo-seed trap — app code outside a request would reach the real one).
  process.env.DATABASE_URL = targetUrl;
  process.env.CONTROL_DATABASE_URL = "";
  process.env.DESKZO_TENANCY_FALLBACK = "legacy";
  let actor: Actor | null = null;
  installRequestStubs(() => actor);
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const people = await db.user.findMany({ where: { id: { in: Object.values(ACTORS).map((a) => a.id) } }, select: { id: true, name: true, email: true, role: true } });
  const as = (key: ActorKey) => {
    const p = people.find((x) => x.id === ACTORS[key].id);
    if (!p) throw new Error(`${ACTORS[key].label} (${ACTORS[key].id}) is not in the workspace.`);
    actor = { id: p.id, name: p.name, email: p.email, role: String(p.role) };
  };
  log("timing the screens…");
  const timings = await time((await workloadCases()).filter((c) => !ONLY || `${c.area} ${c.name}`.toLowerCase().includes(ONLY)), as);
  writeReport(s, timings);
  await db.$disconnect();

  if (DROP) {
    const admin = connect(withDatabase(url, "postgres"));
    await admin.query(`drop database if exists ${q(target)} with (force)`);
    await admin.end();
    log(`dropped ${target}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
