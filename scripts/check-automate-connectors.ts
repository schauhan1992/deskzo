/**
 * check:automate-connectors — Deskzo Automate, Phase 4: the outside connectors (plan of 17 Oct 2026:
 * webhooks in and out, an HTTP API, Slack, Teams, WhatsApp, Google Sheets).
 *
 * Builds a scratch workspace and control plane beside the real database, drives the real store, engine,
 * actions, routes and server actions, and drops both at the end. Every outside call goes to a stand-in
 * on 127.0.0.1 that this script runs; WhatsApp goes to a stand-in provider. Nothing reaches Slack,
 * Teams, Google, Meta or anybody's API.
 *
 *   · the outbound guard: https only, no private or metadata address, a redirect inside refused;
 *   · connections: secrets checked, kept encrypted and never handed back; changed and removed only by
 *     their owner; used by another's workflow only when shared;
 *   · calls out: signed with the workspace's secret, the step's Idempotency-Key on every try, the saved
 *     API's address and headers, GET without a body, 307 keeping the POST and 303 not;
 *   · answers: 4xx fails for good, 5xx is tried again with the same key, a call cut off waits for a
 *     person and is sent once more only when they say so; a test run calls nobody;
 *   · Slack's and Teams' message shapes, and "Send a test";
 *   · WhatsApp through the provider, logged, with the template's values kept in their places;
 *   · Google Sheets: refused without the permission, the row appended as the owner; connecting asks for
 *     it, and a plain reconnect keeps it;
 *   · webhooks in: the address, signatures (right, wrong, stale), signed-only, Idempotency-Key, 60 a
 *     minute, 256 KB, a paused workflow, a new address, and only its own workflow started.
 *
 *   npm run check:automate-connectors
 */
import "dotenv/config";
import Module from "node:module";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { execSync } from "node:child_process";
import { NextRequest } from "next/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { cidrContains, parseCidr, type ParsedIp } from "../src/lib/access/ip";
import { clockFor } from "../src/lib/time/zone";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ─── Who the server actions think is calling ────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
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

// ─── The stand-in: an outside API, Slack, Teams and the Sheets API ──────────────────────────────

type Seen = { method: string; path: string; query: string; headers: http.IncomingHttpHeaders; body: string };
const seen: Seen[] = [];
const hanging: http.ServerResponse[] = [];
let slowHangs = true;
let flakyCalls = 0;
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://stand-in");
    const body = Buffer.concat(chunks).toString("utf8");
    const p = decodeURIComponent(url.pathname);
    seen.push({ method: req.method ?? "", path: p, query: url.search, headers: req.headers, body });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const text = (status: number, said: string) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(said);
    };
    if (p === "/api/slow") {
      if (slowHangs) return void hanging.push(res);
      return json(200, { ok: true, late: true });
    }
    if (p === "/api/flaky") {
      flakyCalls += 1;
      return flakyCalls === 1 ? json(503, { error: "busy" }) : json(200, { ok: true, tries: flakyCalls });
    }
    if (p === "/api/refuse") return text(400, "Bad order number");
    if (p === "/api/r-away") {
      // Another site — a name the stand-in's resolver also points here.
      res.writeHead(307, { location: `http://elsewhere.zzcon.test:${(server.address() as AddressInfo).port}/api/echo-away` });
      return res.end();
    }
    if (p === "/api/r307" || p === "/api/r303" || p === "/api/r-internal") {
      res.writeHead(p === "/api/r307" ? 307 : p === "/api/r303" ? 303 : 302, { location: p === "/api/r307" ? "/api/echo307" : p === "/api/r303" ? "/api/echo303" : `http://10.0.0.1:${(server.address() as AddressInfo).port}/steal` });
      return res.end();
    }
    if (p.startsWith("/api/")) return json(p.endsWith("/orders") ? 201 : 200, { ok: true, name: "Asha", got: body ? parsed(body) : null });
    if (p.startsWith("/slack/")) return p.endsWith("/gone") ? text(404, "no_service") : text(200, "ok");
    if (p.startsWith("/teams/")) {
      res.writeHead(202);
      return res.end();
    }
    if (p.startsWith("/sheets/")) return json(200, { spreadsheetId: "zz", updates: { updatedRange: "Leads!A2:D2", updatedRows: 1 } });
    json(404, { error: "no such stand-in path" });
  });
});

const signatureOf = (secret: string, timestamp: string, body: string) => createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

async function main() {
  const india = clockFor("Asia/Kolkata");

  // ─── Scratch databases ──────────────────────────────────────────────────────────────────────
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace and control plane");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so scratch databases may be made beside it", local, host);
  if (!local) throw new Error("not a local database");

  const real = directClient(url, { max: 1 });
  const snapshot = async () =>
    JSON.stringify(
      await Promise.all([
        real.automationConnection.count().catch(() => -1),
        real.automationWebhook.count().catch(() => -1),
        real.automationEvent.count({ where: { type: "webhook" } }).catch(() => -1),
        real.mailConnection.findMany({ select: { userId: true, scopes: true }, orderBy: { userId: "asc" } }).catch(() => []),
      ]),
    );
  const realBefore = await snapshot();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const names = { a: `${realName}_autocon_a`, control: `${realName}_autocon_ctl` };
  const admin = directClient(withDatabase(url, "postgres"));
  let close: (() => Promise<void>) | null = null;
  try {
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    const started = Date.now();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.a}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, names.a) }, timeout: 10 * 60_000 });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.control}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: withDatabase(url, names.control) }, timeout: 5 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.TENANT_DB_ZZCON_A = withDatabase(url, names.a);
    process.env.CONTROL_DATABASE_URL = withDatabase(url, names.control);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    close = async () => {
      await closeAllClients();
      await closeControlDb();
    };
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const engine = require("../src/lib/automate/engine") as typeof import("../src/lib/automate/engine");
    const store = require("../src/lib/automate/store") as typeof import("../src/lib/automate/store");
    const { actionByKey } = require("../src/lib/automate/registry") as typeof import("../src/lib/automate/registry");
    const { builderCatalog } = require("../src/lib/automate/catalog") as typeof import("../src/lib/automate/catalog");
    const outbound = require("../src/lib/automate/outbound") as typeof import("../src/lib/automate/outbound");
    const connections = require("../src/lib/automate/connections") as typeof import("../src/lib/automate/connections");
    const webhooks = require("../src/lib/automate/webhooks") as typeof import("../src/lib/automate/webhooks");
    const { spreadsheetId } = require("../src/lib/automate/actions/outside") as typeof import("../src/lib/automate/actions/outside");
    const actions = require("../src/actions/automate") as typeof import("../src/actions/automate");
    const hookRoute = require("../src/app/api/automate/hooks/[token]/route") as typeof import("../src/app/api/automate/hooks/[token]/route");
    const connectRoute = require("../src/app/api/mail/[provider]/connect/route") as typeof import("../src/app/api/mail/[provider]/connect/route");
    const { SafeFetchError, isBlockedAddress } = require("../src/lib/net/safe-fetch") as typeof import("../src/lib/net/safe-fetch");
    const { encryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
    const google = require("../src/lib/mail/google") as typeof import("../src/lib/mail/google");
    const workplace = require("../src/lib/workplace/settings") as typeof import("../src/lib/workplace/settings");
    const { providerByKey } = require("../src/lib/marketing/providers") as typeof import("../src/lib/marketing/providers");
    type Outbound = import("../src/lib/marketing/providers/types").OutboundMessage;
    /* eslint-enable @typescript-eslint/no-require-imports */

    const A = (await registry.tenantBySlug("zzcon-a"))!;
    ok("the registry knows the workspace", !!A);
    const inA = <T,>(work: () => Promise<T>) => runAsTenant(A, work);

    // ─── Fixtures ───────────────────────────────────────────────────────────────────────────────
    const person = (email: string, role: string, extra: Record<string, unknown> = {}) =>
      inA(() => db.user.create({ data: { name: email.split("@")[0]!, email, passwordHash: "!", role, ...extra }, select: { id: true, name: true, email: true, role: true } }));
    const ownerUser = await person("zzowner@zzcon.invalid", "ADMIN", { isSuperAdmin: true });
    const colleagueUser = await person("zzcolleague@zzcon.invalid", "ADMIN");
    const owner = ownerUser.id;
    const as = (u: typeof ownerUser) => {
      actor = { id: u.id, name: u.name, email: u.email!, role: u.role };
    };
    const acme = await inA(() =>
      db.company.create({ data: { name: "ZZ Acme", normalizedName: "zz acme", createdById: owner, ownerUserId: owner, locations: { create: { label: "Head Office", isPrimary: true } } }, select: { id: true } }),
    );
    const silent = await inA(() => db.company.create({ data: { name: "ZZ Silent", normalizedName: "zz silent", createdById: owner, ownerUserId: owner }, select: { id: true } }));
    const asha = await inA(() => db.contact.create({ data: { companyId: acme.id, name: "Asha ZZ", email: "asha@zzcon.invalid", phone: "+91 98000 00011", isPrimary: true }, select: { id: true } }));
    const gone = await inA(() => db.contact.create({ data: { companyId: acme.id, name: "Gone ZZ", phone: "+91 98000 00012", leftAt: new Date() }, select: { id: true } }));
    await inA(() => db.contact.create({ data: { companyId: silent.id, name: "No Phone ZZ", email: "nophone@zzcon.invalid" } }));
    const deal = await inA(() => db.lead.create({ data: { companyId: acme.id, contactId: asha.id, title: "ZZ deal", ownerUserId: owner, createdByUserId: owner, source: "OTHER" }, select: { id: true } }));

    const publish = (ownerId: string, name: string, d: unknown) =>
      inA(async () => {
        const w = await store.createWorkflow({ name, ownerUserId: ownerId, createdById: ownerId, draft: d as import("../src/lib/automate/definition").Definition });
        const published = await store.publishWorkflow(w.id, ownerId);
        if (!published.ok) throw new Error(`${name}: ${published.error} ${JSON.stringify(published.problems ?? [])}`);
        return w.id;
      });
    const drain = () =>
      inA(async () => {
        for (let i = 0; i < 40; i++) {
          await engine.workTenant({ budgetMs: 15_000 });
          const due = (await db.automationRun.count({ where: { status: "QUEUED", runAfter: { lte: new Date() } } })) + (await db.automationEvent.count({ where: { matchedAt: null } }));
          if (!due) break;
        }
      });
    const manual = (steps: unknown[]) => ({ schema: 1, trigger: { type: "manual" }, steps });
    const runOf = (runId: string) => inA(() => db.automationRun.findUnique({ where: { id: runId }, select: { id: true, status: true, error: true, runAfter: true, attempts: true } }));
    const stepsOf = (runId: string) => inA(() => db.automationRunStep.findMany({ where: { runId }, orderBy: { startedAt: "asc" }, select: { stepId: true, status: true, outputSummary: true, error: true, errorKind: true } }));
    /** Publishes a one-off manual workflow, runs it as far as it goes, and says how it went. */
    const runOnce = async (name: string, steps: unknown[], by = owner) => {
      const id = await publish(by, name, manual(steps));
      const started = await inA(() => store.startManualRun(id, by));
      if (!started.ok) throw new Error(`${name}: ${started.error}`);
      await drain();
      const run = (await runOf(started.data.runId))!;
      return { workflowId: id, runId: run.id, status: run.status, error: run.error ?? "", steps: await stepsOf(run.id) };
    };
    const notes = (userId: string) => inA(() => db.notification.findMany({ where: { userId, type: "WORKFLOW_MESSAGE" }, select: { title: true } }).then((n) => n.map((x) => x.title)));
    const since = (from: number) => seen.slice(from);
    const header = (s: Seen | undefined, name: string) => {
      const v = s?.headers[name];
      return Array.isArray(v) ? v.join(",") : (v ?? null);
    };

    // ─── The guard, as it is in production ─────────────────────────────────────────────────────
    section("The outbound guard, unchanged");
    const refusal = async (target: string) => {
      try {
        await inA(() => outbound.outboundFetch({ key: "zz:guard" }, { method: "POST", url: target, body: "{}" }));
        return "fetched";
      } catch (err) {
        return err instanceof SafeFetchError ? err.code : String(err);
      }
    };
    ok("a private address is refused", (await refusal("https://10.0.0.1/hook")) === "blocked-address");
    ok("  the cloud metadata address too", (await refusal("https://169.254.169.254/latest/meta-data")) === "blocked-address");
    ok("  and this machine", (await refusal("https://127.0.0.1/admin")) === "blocked-address");
    ok("http is refused: Automate calls https only", (await refusal("http://8.8.8.8/")) === "bad-url");
    ok("  and a port other than 443", (await refusal("https://8.8.8.8:8443/")) === "bad-port");
    const before = seen.length;
    const toInside = await runOnce("ZZ call inside", [{ id: "call", type: "action", action: "http.request", input: { url: "https://127.0.0.1/api/echo", body: { x: 1 } } }]);
    ok("a workflow's call to an inside address fails for good, and nothing is reached", toInside.status === "FAILED" && toInside.steps[0]?.errorKind === "PERMANENT" && seen.length === before && toInside.error.includes("not a public address"), `${toInside.status} ${toInside.error}`);

    // From here, the stand-in: https://hooks.slack.com/… and the rest are sent to it, and 127.0.0.1 is let through.
    const loopback = parseCidr("127.0.0.1/32")!;
    const standIn = {
      protocols: ["http:"] as const,
      ports: [port],
      timeoutMs: 1_500,
      resolve: async () => ["127.0.0.1"],
      blocked: (ip: ParsedIp) => !cidrContains(loopback, ip) && isBlockedAddress(ip),
      rewrite: (u: string) =>
        u
          .replace(/^https:\/\/hooks\.slack\.com\//, `${base}/slack/`)
          .replace(/^https:\/\/teams\.zzcon\.test\//, `${base}/teams/`)
          .replace(/^https:\/\/api\.zzcon\.test\//, `${base}/api/`)
          .replace(/^https:\/\/sheets\.zzcon\.test\//, `${base}/sheets/`),
    };
    outbound.setTestOutbound(standIn);
    google.setTestGoogleEndpoints({ sheets: "https://sheets.zzcon.test" });

    // ─── Connections ────────────────────────────────────────────────────────────────────────────
    section("Connections: checked, encrypted, never handed back");
    as(ownerUser);
    const SLACK = "https://hooks.slack.com/services/T0ZZ/B0ZZ/zzSlackSecretPath";
    const notSlack = await inA(() => actions.saveAutomationConnection({ provider: "slack", name: "ZZ sales", shared: false, secret: { url: "https://example.com/hook" } }));
    ok("a Slack address that isn't Slack's is refused", !notSlack.ok && notSlack.error.includes("hooks.slack.com"), notSlack.ok ? "" : notSlack.error);
    const notHttps = await inA(() => actions.saveAutomationConnection({ provider: "http", name: "ZZ ERP", shared: false, secret: { url: "http://api.zzcon.test/v1" } }));
    ok("an API address that isn't https is refused", !notHttps.ok && notHttps.error.includes("https://"), notHttps.ok ? "" : notHttps.error);
    const badHeader = await inA(() => actions.saveAutomationConnection({ provider: "http", name: "ZZ ERP", shared: false, secret: { url: "https://api.zzcon.test/v1", headers: { "Bad Header": "x" } } }));
    ok("  and a header name with a space", !badHeader.ok, badHeader.ok ? "" : badHeader.error);
    const slack = await inA(() => actions.saveAutomationConnection({ provider: "slack", name: "ZZ sales", shared: false, secret: { url: SLACK } }));
    const api = await inA(() => actions.saveAutomationConnection({ provider: "http", name: "ZZ ERP", shared: false, secret: { url: "https://api.zzcon.test/v1/", headers: { Authorization: "Bearer zz-api-key-123" } } }));
    const slackGone = await inA(() => actions.saveAutomationConnection({ provider: "slack", name: "ZZ old channel", shared: false, secret: { url: "https://hooks.slack.com/services/T0ZZ/B0ZZ/gone" } }));
    if (!slack.ok || !api.ok || !slackGone.ok) throw new Error(`connections: ${JSON.stringify([slack, api, slackGone])}`);
    const slackRow = await inA(() => db.automationConnection.findUnique({ where: { id: slack.data.id }, select: { credentialsCipher: true, scopes: true, ownerUserId: true } }));
    ok("Slack and an outside API saved, as their owner's", slackRow?.ownerUserId === owner);
    ok("  the address is stored encrypted — not in the clear — with only its host beside it", !!slackRow?.credentialsCipher && !slackRow.credentialsCipher.includes("zzSlackSecretPath") && slackRow.scopes[0] === "hooks.slack.com", slackRow?.scopes.join(","));
    const page = await inA(() => actions.getAutomationConnections());
    const pageText = JSON.stringify(page);
    ok("the Connections page gets the list with hosts, and no address, key or cipher", page.connections.length === 3 && pageText.includes("api.zzcon.test") && !pageText.includes("zzSlackSecretPath") && !pageText.includes("zz-api-key-123") && !pageText.includes("credentialsCipher"));
    ok("  and no signing secret until asked for", !pageText.includes(await inA(() => outbound.automateSigningSecret())));
    const revealed = await inA(() => actions.revealAutomationSigningSecret());
    const signingSecret = await inA(() => outbound.automateSigningSecret());
    ok("asked for, the signing secret is the workspace's own", revealed.ok && revealed.data.secret === signingSecret && signingSecret.length === 40);
    const renamed = await inA(() => actions.saveAutomationConnection({ id: slack.data.id, provider: "slack", name: "ZZ sales wins", shared: false }));
    const afterRename = await inA(() => db.automationConnection.findUnique({ where: { id: slack.data.id }, select: { credentialsCipher: true, name: true } }));
    ok("a change with no new address keeps the saved one", renamed.ok && afterRename?.name === "ZZ sales wins" && afterRename.credentialsCipher === slackRow?.credentialsCipher);

    as(colleagueUser);
    const teams = await inA(() => actions.saveAutomationConnection({ provider: "teams", name: "ZZ ops", shared: false, secret: { url: "https://teams.zzcon.test/workflows/zz-teams-hook" } }));
    const theirEdit = await inA(() => actions.saveAutomationConnection({ id: slack.data.id, provider: "slack", name: "Hijacked", shared: true }));
    const theirDelete = await inA(() => actions.deleteAutomationConnection(slack.data.id));
    ok("a colleague adds their own Teams channel", teams.ok, teams.ok ? "" : teams.error);
    ok("  but can't change or remove somebody else's connection", !theirEdit.ok && !theirDelete.ok && (await inA(() => db.automationConnection.count({ where: { id: slack.data.id, name: "ZZ sales wins" } }))) === 1);
    if (!teams.ok) throw new Error(teams.error);
    as(ownerUser);
    const catalogBefore = await inA(() => builderCatalog(owner));
    ok("the builder offers the owner their own connections, not a colleague's unshared one", catalogBefore.connections.some((c) => c.id === slack.data.id) && !catalogBefore.connections.some((c) => c.id === teams.data.id));
    const slackField = catalogBefore.actions.find((a) => a.key === "slack.post")?.fields.find((f) => f.name === "connectionId");
    ok("  a Slack step's channel is a connection picker for Slack", slackField?.kind === "connection" && slackField.provider === "slack", JSON.stringify(slackField));
    ok("  and 'An outside app calls its webhook address' is a trigger, under Outside apps", catalogBefore.triggers.some((t) => t.type === "webhook" && t.group === "Outside apps"));

    // ─── Calls out ──────────────────────────────────────────────────────────────────────────────
    section("Calling an outside API");
    let mark = seen.length;
    const posted = await runOnce("ZZ post", [
      { id: "call", type: "action", action: "http.request", input: { url: "https://api.zzcon.test/echo", body: { lead: "ZZ", n: 2 } } },
      { id: "tell", type: "action", action: "notify.person", input: { title: "ZZ answer {{steps.call.output.body.name}} {{steps.call.output.status}}" } },
    ]);
    const call = since(mark)[0];
    const stamp = header(call, "x-deskzo-timestamp") ?? "";
    ok("a POST goes out with its body as JSON", posted.status === "SUCCEEDED" && call?.method === "POST" && call.path === "/api/echo" && isDeepStrictEqual(parsed(call.body), { lead: "ZZ", n: 2 }) && header(call, "content-type") === "application/json", `${posted.status} ${posted.error} ${JSON.stringify({ m: call?.method, p: call?.path, b: call?.body, t: header(call, "content-type") })}`);
    ok("  carrying the step's Idempotency-Key", header(call, "idempotency-key") === `${posted.runId}:call`, header(call, "idempotency-key"));
    ok("  signed: the hex HMAC of 'timestamp.body' with the workspace's secret, the time now", header(call, "x-deskzo-signature") === signatureOf(signingSecret, stamp, call?.body ?? "") && Math.abs(Date.now() / 1000 - Number(stamp)) < 60);
    ok("  and its answer is there for the next step", (await notes(owner)).includes("ZZ answer Asha 200"), (await notes(owner)).join(" | "));

    mark = seen.length;
    const unsigned = await runOnce("ZZ unsigned", [{ id: "call", type: "action", action: "http.request", input: { url: "https://api.zzcon.test/echo", body: "plain words", sign: false } }]);
    ok("unsigned when the step says so; text sent as it is", unsigned.status === "SUCCEEDED" && header(since(mark)[0], "x-deskzo-signature") === null && since(mark)[0]?.body === "plain words");

    mark = seen.length;
    const saved = await runOnce("ZZ saved API", [{ id: "call", type: "action", action: "http.request", input: { connectionId: api.data.id, path: "/orders", method: "PUT", headers: { "X-Source": "Deskzo" }, body: { id: 7 } } }]);
    const savedCall = since(mark)[0];
    ok("a saved API: its base address and the step's path, the method asked for", saved.status === "SUCCEEDED" && savedCall?.method === "PUT" && savedCall.path === "/api/v1/orders", `${saved.status} ${saved.error} ${savedCall?.path}`);
    ok("  its saved headers, and the step's own", header(savedCall, "authorization") === "Bearer zz-api-key-123" && header(savedCall, "x-source") === "Deskzo");
    const apiRow = await inA(() => db.automationConnection.findUnique({ where: { id: api.data.id }, select: { lastUsedAt: true, lastError: true } }));
    ok("  and the connection says when it was last used", !!apiRow?.lastUsedAt && apiRow.lastError === null);

    mark = seen.length;
    const read = await runOnce("ZZ read", [{ id: "call", type: "action", action: "http.request", input: { url: "https://api.zzcon.test/customer", method: "GET", body: { ignored: true } } }]);
    const readCall = since(mark)[0];
    ok("a GET carries no body", read.status === "SUCCEEDED" && readCall?.method === "GET" && readCall.body === "" && JSON.stringify(read.steps[0]?.outputSummary).includes("Asha"), `${read.status} ${read.error}`);

    mark = seen.length;
    const refused = await runOnce("ZZ refused", [{ id: "call", type: "action", action: "http.request", input: { url: "https://api.zzcon.test/refuse", body: { n: 1 } } }]);
    ok("a 4xx answer fails the run for good, saying what came back", refused.status === "FAILED" && refused.error.includes("It answered 400: Bad order number") && since(mark).length === 1, refused.error);
    ok("  and leaves no 'under way' mark behind", (await inA(() => db.automationEffect.count({ where: { runId: refused.runId } }))) === 0);

    mark = seen.length;
    const flaky = await runOnce("ZZ flaky", [{ id: "call", type: "action", action: "http.request", input: { url: "https://api.zzcon.test/flaky", body: { n: 1 } } }]);
    const flakyRun = await runOf(flaky.runId);
    ok("a 5xx answer is tried again later, not failed", flaky.status === "QUEUED" && !!flakyRun?.runAfter && flakyRun.runAfter.getTime() > Date.now() && flaky.steps[0]?.errorKind === "TRANSIENT", `${flaky.status} ${flaky.error}`);
    await inA(() => db.automationRun.update({ where: { id: flaky.runId }, data: { runAfter: new Date() } }));
    await drain();
    const flakyCallsSeen = since(mark).filter((s) => s.path === "/api/flaky");
    ok("  and the second try goes through, with the same Idempotency-Key", (await runOf(flaky.runId))?.status === "SUCCEEDED" && flakyCallsSeen.length === 2 && header(flakyCallsSeen[0], "idempotency-key") === header(flakyCallsSeen[1], "idempotency-key"));

    mark = seen.length;
    const slow = await runOnce("ZZ slow", [{ id: "call", type: "action", action: "http.request", input: { url: "https://api.zzcon.test/slow", body: { n: 1 } } }]);
    ok("a call cut off with no answer waits for a person, and isn't sent again by itself", slow.status === "NEEDS_ATTENTION" && since(mark).length === 1, `${slow.status} ${slow.error}`);
    ok("  saying it isn't known whether it was done — once", (slow.error.match(/isn't known/g) ?? []).length === 1, slow.error);
    slowHangs = false;
    const retried = await inA(() => store.retryRun(slow.runId));
    await drain();
    const slowCalls = since(mark).filter((s) => s.path === "/api/slow");
    ok("  a person says try again: it goes once more, with the same key, and finishes", retried.ok && (await runOf(slow.runId))?.status === "SUCCEEDED" && slowCalls.length === 2 && header(slowCalls[0], "idempotency-key") === header(slowCalls[1], "idempotency-key"));

    mark = seen.length;
    const inside = await runOnce("ZZ redirected inside", [{ id: "call", type: "action", action: "http.request", input: { url: "https://api.zzcon.test/r-internal", body: { n: 1 } } }]);
    ok("a redirect to an inside address is refused for good", inside.status === "FAILED" && inside.steps[0]?.errorKind === "PERMANENT" && inside.error.includes("not a public address") && since(mark).length === 1, inside.error);

    mark = seen.length;
    const keyed = { authorization: "Bearer zz-key", "x-api-key": "zz-key-2", "content-type": "application/json" };
    await inA(() => outbound.outboundFetch({ key: "zz:r307" }, { method: "POST", url: "https://api.zzcon.test/r307", body: "x=1", headers: keyed }));
    await inA(() => outbound.outboundFetch({ key: "zz:r303" }, { method: "POST", url: "https://api.zzcon.test/r303", body: "x=1" }));
    await inA(() => outbound.outboundFetch({ key: "zz:away" }, { method: "POST", url: "https://api.zzcon.test/r-away", body: "{}", headers: keyed, sign: true }));
    const r307 = since(mark).find((s) => s.path === "/api/echo307");
    const r303 = since(mark).find((s) => s.path === "/api/echo303");
    const away = since(mark).find((s) => s.path === "/api/echo-away");
    ok("a 307 is followed with the POST and its body; a 303 as a GET without one", r307?.method === "POST" && r307.body === "x=1" && r303?.method === "GET" && r303.body === "");
    ok("  on the same site the key goes along", header(r307, "authorization") === "Bearer zz-key" && header(r307, "x-api-key") === "zz-key-2");
    ok(
      "  sent to another site, the call loses its keys and signature, keeping its body and Idempotency-Key",
      away?.method === "POST" && away.body === "{}" && header(away, "authorization") === null && header(away, "x-api-key") === null && header(away, "x-deskzo-signature") === null && header(away, "content-type") === "application/json" && header(away, "idempotency-key") === "zz:away",
      JSON.stringify(away?.headers),
    );

    mark = seen.length;
    const draftId = await inA(async () =>
      (await store.createWorkflow({ name: "ZZ test only", ownerUserId: owner, createdById: owner, draft: manual([{ id: "call", type: "action", action: "http.request", input: { url: "https://api.zzcon.test/echo", body: { n: 1 } } }]) as import("../src/lib/automate/definition").Definition })).id,
    );
    const tested = await inA(() => store.testDraft(draftId, owner, true));
    const testedSteps = tested.ok ? await stepsOf(tested.data.runId) : [];
    ok("a test run — even with the safe steps done for real — calls nobody, and says what it would send", tested.ok && since(mark).length === 0 && JSON.stringify(testedSteps).includes("Would POST https://api.zzcon.test/echo"), JSON.stringify(testedSteps).slice(0, 200));

    // ─── Slack and Teams ────────────────────────────────────────────────────────────────────────
    section("Slack and Teams");
    mark = seen.length;
    const toSlack = await runOnce("ZZ to Slack", [{ id: "post", type: "action", action: "slack.post", input: { connectionId: slack.data.id, title: "Won", text: "ZZ deal is ours" } }]);
    const slackCall = since(mark)[0];
    ok("posted to the saved Slack webhook, the title in bold", toSlack.status === "SUCCEEDED" && slackCall?.path === "/slack/services/T0ZZ/B0ZZ/zzSlackSecretPath" && slackCall.body === JSON.stringify({ text: "*Won*\nZZ deal is ours" }), `${toSlack.status} ${toSlack.error}`);
    ok("  not signed (Slack doesn't read it), but with the step's key", header(slackCall, "x-deskzo-signature") === null && header(slackCall, "idempotency-key") === `${toSlack.runId}:post`);
    const theirs = await runOnce("ZZ to their Teams", [{ id: "post", type: "action", action: "teams.post", input: { connectionId: teams.data.id, text: "Hello" } }]);
    ok("a colleague's Teams channel, not shared: refused for good", theirs.status === "FAILED" && theirs.error.includes("isn't shared"), theirs.error);
    as(colleagueUser);
    await inA(() => actions.saveAutomationConnection({ id: teams.data.id, provider: "teams", name: "ZZ ops", shared: true }));
    as(ownerUser);
    mark = seen.length;
    const toTeams = await runOnce("ZZ to shared Teams", [{ id: "post", type: "action", action: "teams.post", input: { connectionId: teams.data.id, title: "Ticket closed", text: "ZZ printer fixed" } }]);
    const card = parsed(since(mark)[0]?.body ?? "") as { type?: string; attachments?: { contentType?: string; content?: { type?: string; body?: { text?: string }[] } }[] };
    ok("shared, it posts: an Adaptive Card message, title then text", toTeams.status === "SUCCEEDED" && card.type === "message" && card.attachments?.[0]?.contentType === "application/vnd.microsoft.card.adaptive" && card.attachments[0].content?.type === "AdaptiveCard" && card.attachments[0].content.body?.[0]?.text === "Ticket closed" && card.attachments[0].content.body[1]?.text === "ZZ printer fixed", `${toTeams.status} ${toTeams.error}`);
    ok("  and the builder now offers it to the owner too", (await inA(() => builderCatalog(owner))).connections.some((c) => c.id === teams.data.id));
    const wrongKind = await inA(() => connections.connectionFor(owner, teams.data.id, "slack").then(() => "used", (err: Error) => err.message));
    ok("a Teams connection can't be used as a Slack one", wrongKind.includes("isn't there"), wrongKind);

    // The worker stopped after the post: the step is run again and must not post twice.
    const twice = await publish(owner, "ZZ twice", manual([{ id: "end", type: "stop", outcome: "succeeded" }]));
    const twiceRun = await inA(() => store.startManualRun(twice, owner));
    if (!twiceRun.ok) throw new Error(twiceRun.error);
    const ctx = { actorId: owner, workflowId: twice, workflowName: "ZZ twice", runId: twiceRun.data.runId, stepId: "post", key: `${twiceRun.data.runId}:post`, depth: 0, clock: india };
    const slackPost = actionByKey("slack.post")!;
    const input = slackPost.input.parse({ connectionId: slack.data.id, text: "ZZ once only" });
    mark = seen.length;
    await inA(() => slackPost.run(ctx, input));
    await inA(() => slackPost.run(ctx, input));
    ok("a post step tried twice posts once", since(mark).length === 1);

    mark = seen.length;
    const test = await inA(() => actions.testAutomationConnection(slack.data.id));
    ok("'Send a test' posts a test message", test.ok && since(mark)[0]?.body.includes("A test from Deskzo Automate"), test.ok ? "" : test.error);
    const testGone = await inA(() => actions.testAutomationConnection(slackGone.data.id));
    const goneRow = await inA(() => db.automationConnection.findUnique({ where: { id: slackGone.data.id }, select: { lastError: true } }));
    ok("  to a removed Slack webhook: says what Slack answered, and the row shows it", !testGone.ok && testGone.error.includes("404: no_service") && !!goneRow?.lastError?.includes("no_service"), testGone.ok ? "" : testGone.error);

    // ─── WhatsApp ───────────────────────────────────────────────────────────────────────────────
    section("WhatsApp");
    const waStep = (input: Record<string, unknown>) => [{ id: "wa", type: "action", action: "whatsapp.send", input: { template: "order_update", parameters: ["Asha", "ORD-1"], ...input } }];
    const noProvider = await runOnce("ZZ WhatsApp, no provider", waStep({ to: "lead_contact", leadId: deal.id }));
    ok("with no WhatsApp provider set up: refused for good, saying where to set one up", noProvider.status === "FAILED" && noProvider.error.includes("No WhatsApp provider") && noProvider.steps[0]?.errorKind === "PERMANENT", noProvider.error);
    const waSent: Outbound[] = [];
    providerByKey.zzwa = {
      key: "zzwa",
      label: "ZZ WhatsApp stand-in",
      kind: "WHATSAPP",
      needs: [],
      send: async (message) => {
        waSent.push(message);
        return { ok: true, providerMessageId: `zzwa-${waSent.length}` };
      },
      verify: async () => ({ ok: true, detail: "stand-in" }),
    };
    await inA(() => db.messagingProvider.create({ data: { key: "zzwa", label: "ZZ WhatsApp stand-in", kind: "WHATSAPP", enabled: true, priority: 1, classes: ["TRANSACTIONAL"] } }));
    const wa = await runOnce("ZZ WhatsApp", waStep({ to: "lead_contact", leadId: deal.id, parameters: ["Asha", "ORD-1\nfor delivery"] }));
    ok("the lead's contact gets the template through the provider", wa.status === "SUCCEEDED" && waSent.length === 1 && waSent[0]!.to === "+91 98000 00011" && waSent[0]!.subject === "order_update", `${wa.status} ${wa.error}`);
    ok("  its values one a line, in order — a line break inside one flattened, not a new value", waSent[0]?.html === "Asha\nORD-1 for delivery", JSON.stringify(waSent[0]?.html));
    const logged = await inA(() => db.marketingMessage.findFirst({ where: { channel: "WHATSAPP", contactId: asha.id }, select: { status: true, subject: true, toPhone: true, messageClass: true } }));
    ok("  and logged with Marketing's messages", logged?.status === "SENT" && logged.subject === "order_update" && logged.messageClass === "TRANSACTIONAL" && !!logged.toPhone);
    const blankValue = await runOnce("ZZ WhatsApp blank", waStep({ to: "contact", contactId: asha.id, parameters: ["Asha", "  "] }));
    ok("a blank value is refused before anything is sent — it would shift the rest", blankValue.status === "FAILED" && blankValue.error.includes("{{2}}") && waSent.length === 1, blankValue.error);
    const left = await runOnce("ZZ WhatsApp left", waStep({ to: "contact", contactId: gone.id }));
    ok("a contact who has left isn't messaged", left.status === "FAILED" && left.error.includes("left") && waSent.length === 1, left.error);
    const noPhone = await runOnce("ZZ WhatsApp no phone", waStep({ to: "company_contact", companyId: silent.id }));
    ok("a customer with nobody on a phone number: refused", noPhone.status === "FAILED" && noPhone.error.includes("phone") && waSent.length === 1, noPhone.error);

    // ─── Google Sheets ──────────────────────────────────────────────────────────────────────────
    section("Google Sheets");
    ok("a spreadsheet's id is read from its address, or taken as it is", spreadsheetId("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0") === "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" && spreadsheetId("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789") === "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" && spreadsheetId("budget") === null);
    await inA(async () => {
      await db.workplaceSettings.create({ data: { id: "global", googleClientId: "zz-google-client", googleClientSecretCipher: await encryptSecret("zz-google-secret"), googleMail: true } });
      workplace.invalidateWorkplaceSettingsCache();
    });
    const SHEET = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit";
    const sheetStep = [{ id: "row", type: "action", action: "sheets.append", input: { spreadsheet: SHEET, sheet: "Leads", values: ["Asha", 2, null, { a: 1 }] } }];
    const noMailbox = await runOnce("ZZ Sheets, no mailbox", sheetStep);
    ok("without Google connected: refused for good, saying where to connect it", noMailbox.status === "FAILED" && noMailbox.error.includes("Automate › Connections"), noMailbox.error);
    const GMAIL_ONLY = "openid email https://www.googleapis.com/auth/gmail.send";
    await inA(async () =>
      db.mailConnection.create({
        data: { userId: owner, provider: "GOOGLE", mailbox: "zzowner@zzcon.invalid", refreshTokenCipher: await encryptSecret("zz-refresh"), accessTokenCipher: await encryptSecret("zz-google-token"), accessTokenExpiresAt: new Date(Date.now() + 3_600_000), scopes: GMAIL_ONLY },
      }),
    );
    const noScope = await runOnce("ZZ Sheets, no permission", sheetStep);
    ok("  a Google mailbox without the Sheets permission: refused too", noScope.status === "FAILED" && noScope.error.includes("hasn't connected Google Sheets"), noScope.error);
    ok("  and the Connections page says it isn't connected", !(await inA(() => actions.getAutomationConnections())).sheets.connected);
    await inA(() => db.mailConnection.update({ where: { userId: owner }, data: { scopes: `${GMAIL_ONLY} ${google.GOOGLE_SHEETS_SCOPE}` } }));
    mark = seen.length;
    const appended = await runOnce("ZZ Sheets", sheetStep);
    const sheetCall = since(mark)[0];
    ok("with it: a row appended to the named tab, as the owner", appended.status === "SUCCEEDED" && sheetCall?.method === "POST" && sheetCall.path === "/sheets/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/values/'Leads'!A1:append" && header(sheetCall, "authorization") === "Bearer zz-google-token", `${appended.status} ${appended.error} ${sheetCall?.path}`);
    ok("  entered as typed, as new rows", sheetCall?.query === "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS", sheetCall?.query);
    ok("  the values as cells: blanks empty, data as JSON", sheetCall?.body === JSON.stringify({ values: [["Asha", 2, "", '{"a":1}']] }), sheetCall?.body);
    ok("  and the range it landed in, for the next step", JSON.stringify(appended.steps[0]?.outputSummary).includes("Leads!A2:D2"));
    ok("the Connections page says Sheets is connected", (await inA(() => actions.getAutomationConnections())).sheets.connected);
    const notASheet = await runOnce("ZZ Sheets, not a sheet", [{ id: "row", type: "action", action: "sheets.append", input: { spreadsheet: "my budget", values: ["x"] } }]);
    ok("an address that isn't a spreadsheet's is refused", notASheet.status === "FAILED" && notASheet.error.includes("isn't a Google spreadsheet"), notASheet.error);

    section("Connecting Google with Sheets");
    const scopeAsked = async (query: string) => {
      const res = await inA(() => connectRoute.GET(new NextRequest(`http://zzcon-a.localhost/api/mail/google/connect?${query}`), { params: Promise.resolve({ provider: "google" }) }));
      return new URL(res.headers.get("location") ?? "about:blank").searchParams.get("scope") ?? "";
    };
    as(colleagueUser);
    ok("'Connect Google with Sheets' asks Google for the mailbox and Sheets", (await scopeAsked("purpose=sheets&next=/automate/connections")).split(" ").includes(google.GOOGLE_SHEETS_SCOPE));
    ok("  a plain mailbox connection doesn't", !(await scopeAsked("next=/profile")).includes("spreadsheets"));
    as(ownerUser);
    ok("  but reconnecting a mailbox that has Sheets keeps it — Google would drop it otherwise", (await scopeAsked("next=/profile")).split(" ").includes(google.GOOGLE_SHEETS_SCOPE));

    // ─── Webhooks in ────────────────────────────────────────────────────────────────────────────
    section("A workflow started by an outside app");
    const onHook = await publish(owner, "ZZ hook one", { schema: 1, trigger: { type: "webhook" }, steps: [{ id: "tell", type: "action", action: "notify.person", input: { title: "ZZ hook {{trigger.body.name}}" } }] });
    const otherHook = await publish(owner, "ZZ hook two", { schema: 1, trigger: { type: "webhook" }, steps: [{ id: "tell", type: "action", action: "notify.person", input: { title: "ZZ other {{trigger.body.name}}" } }] });
    const hook = await inA(() => actions.workflowWebhook(onHook));
    if (!hook.ok) throw new Error(hook.error);
    const token = hook.data.address.split("/").pop()!;
    const hookRow = await inA(() => db.automationWebhook.findFirst({ where: { workflowId: onHook }, select: { id: true, tokenHash: true } }));
    ok("its address is the workspace's own, with an unguessable token", /^https?:\/\/[^/]+\/api\/automate\/hooks\/[A-Za-z0-9_-]{40}$/.test(hook.data.address), hook.data.address);
    ok("  only the token's hash is stored", !!hookRow && hookRow.tokenHash !== token && !JSON.stringify(hookRow).includes(token));
    ok("  asked for again, the same address and secret", (await inA(() => webhooks.ensureWebhook(onHook))).address === hook.data.address);

    const call_ = (t: string, body: string, headers: Record<string, string> = {}, contentType = "application/json", now?: Date) =>
      inA(() => webhooks.receiveWebhook({ token: t, body, contentType, headers: new Headers(headers), query: new URLSearchParams("src=zz"), now }));
    const first = await call_(token, JSON.stringify({ name: "Asha", amount: 1200 }));
    await drain();
    const oneRuns = await inA(() => db.automationRun.count({ where: { workflowId: onHook } }));
    const twoRuns = await inA(() => db.automationRun.count({ where: { workflowId: otherHook } }));
    ok("a call is answered 202, and starts its workflow — and only that one", first.status === 202 && oneRuns === 1 && twoRuns === 0, `${first.status} ${oneRuns} ${twoRuns}`);
    ok("  which reads what was sent", (await notes(owner)).includes("ZZ hook Asha"));
    const event = await inA(() => db.automationEvent.findFirst({ where: { type: "webhook" }, orderBy: { occurredAt: "desc" }, select: { payload: true } }));
    const payload = event?.payload as { workflowId?: string; query?: { src?: string }; headers?: { signed?: boolean } } | undefined;
    ok("  the event names the workflow, with the query and that it wasn't signed", payload?.workflowId === onHook && payload.query?.src === "zz" && payload.headers?.signed === false);
    ok("  and the builder offers the fields it carried", (await inA(() => webhooks.webhookOf(onHook)))?.sampleKeys.join(",") === "name,amount");
    const form = await call_(token, "name=Ravi&city=Pune", {}, "application/x-www-form-urlencoded");
    const formEvent = await inA(() => db.automationEvent.findFirst({ where: { type: "webhook" }, orderBy: { occurredAt: "desc" }, select: { payload: true } }));
    ok("a form's fields are read as data too", form.status === 202 && isDeepStrictEqual((formEvent?.payload as { body?: unknown }).body, { name: "Ravi", city: "Pune" }), `${form.status} ${JSON.stringify(formEvent?.payload)}`);

    const secret = hook.data.secret;
    const nowS = () => String(Math.floor(Date.now() / 1000));
    const signedBody = JSON.stringify({ name: "Signed" });
    const ts = nowS();
    const good = await call_(token, signedBody, { "x-deskzo-timestamp": ts, "x-deskzo-signature": signatureOf(secret, ts, signedBody) });
    ok("a rightly signed call is taken, and marked signed", good.status === 202 && ((await inA(() => db.automationEvent.findFirst({ where: { type: "webhook" }, orderBy: { occurredAt: "desc" }, select: { payload: true } })))?.payload as { headers?: { signed?: boolean } }).headers?.signed === true);
    const wrong = await call_(token, signedBody, { "x-deskzo-timestamp": ts, "x-deskzo-signature": signatureOf("not-the-secret", ts, signedBody) });
    ok("  a wrong signature: 401", wrong.status === 401 && String(wrong.body.error).includes("doesn't match"));
    const old = String(Math.floor(Date.now() / 1000) - 600);
    const stale = await call_(token, signedBody, { "x-deskzo-timestamp": old, "x-deskzo-signature": signatureOf(secret, old, signedBody) });
    ok("  a right signature ten minutes old: 401", stale.status === 401 && String(stale.body.error).includes("5 minutes"));
    const half = await call_(token, signedBody, { "x-deskzo-timestamp": ts });
    ok("  a timestamp without a signature: 401", half.status === 401);
    const changed = await call_(token, JSON.stringify({ name: "Changed" }), { "x-deskzo-timestamp": ts, "x-deskzo-signature": signatureOf(secret, ts, signedBody) });
    ok("  a body changed after signing: 401", changed.status === 401);

    as(ownerUser);
    await inA(() => actions.setWorkflowWebhookSigned(onHook, true));
    const unsignedNow = await call_(token, JSON.stringify({ name: "Plain" }));
    const ts2 = nowS();
    const signedNow = await call_(token, signedBody, { "x-deskzo-timestamp": ts2, "x-deskzo-signature": signatureOf(secret, ts2, signedBody) });
    ok("set to take only signed calls: an unsigned one is refused, a signed one taken", unsignedNow.status === 401 && signedNow.status === 202);
    await inA(() => actions.setWorkflowWebhookSigned(onHook, false));

    const eventsNow = () => inA(() => db.automationEvent.count({ where: { type: "webhook" } }));
    const countBefore = await eventsNow();
    const once1 = await call_(token, JSON.stringify({ name: "Order" }), { "idempotency-key": "order-1042" });
    const once2 = await call_(token, JSON.stringify({ name: "Order" }), { "idempotency-key": "order-1042" });
    ok("the same Idempotency-Key again: answered 200, recorded once", once1.status === 202 && once2.status === 200 && once2.body.duplicate === true && (await eventsNow()) === countBefore + 1);
    const racing = await Promise.all([call_(token, "{}", { "idempotency-key": "order-1043" }), call_(token, "{}", { "idempotency-key": "order-1043" })]);
    ok("  two calls with one key at the same moment: one taken, one a duplicate", racing.map((r) => r.status).sort().join(",") === "200,202" && (await eventsNow()) === countBefore + 2, racing.map((r) => r.status).join(","));

    const big = await call_(token, JSON.stringify({ blob: "x".repeat(webhooks.HOOK_LIMITS.bodyBytes) }));
    ok("a body over 256 KB: 413", big.status === 413);
    ok("an address that isn't one: 404, a malformed one too", (await call_("A".repeat(40), "{}")).status === 404 && (await call_("abc", "{}")).status === 404);

    await inA(() => db.automationEvent.createMany({ data: Array.from({ length: webhooks.HOOK_LIMITS.perMinute }, (_, i) => ({ type: "webhook", recordType: "webhook", recordId: `${hookRow!.id}:zz-burst-${i}`, payload: { workflowId: onHook }, matchedAt: new Date() })) }));
    const limited = await call_(token, "{}");
    ok("past 60 calls in a minute: 429, with Retry-After", limited.status === 429 && limited.headers?.["retry-after"] === "60");
    await inA(() => db.automationEvent.deleteMany({ where: { recordId: { startsWith: `${hookRow!.id}:zz-burst-` } } }));

    await inA(() => db.automationWorkflow.update({ where: { id: onHook }, data: { status: "PAUSED" } }));
    ok("a paused workflow's address: 409", (await call_(token, "{}")).status === 409);
    await inA(() => db.automationWorkflow.update({ where: { id: onHook }, data: { status: "ACTIVE" } }));
    const manualFlow = await publish(owner, "ZZ manual with an address", manual([{ id: "end", type: "stop", outcome: "succeeded" }]));
    const manualHook = await inA(() => webhooks.ensureWebhook(manualFlow));
    ok("an address on a workflow that doesn't start from a webhook: 409", (await call_(manualHook.address.split("/").pop()!, "{}")).status === 409);

    await inA(() => actions.setWorkflowWebhookSigned(onHook, true));
    const renewed = await inA(() => actions.workflowWebhook(onHook, true));
    if (!renewed.ok) throw new Error(renewed.error);
    const newToken = renewed.data.address.split("/").pop()!;
    const ts3 = nowS();
    ok("a new address: the old one stops at once", (await call_(token, "{}")).status === 404 && newToken !== token && renewed.data.secret !== secret);
    ok("  the new one works, with a new secret, and still takes only signed calls", renewed.data.requireSignature && (await call_(newToken, signedBody, { "x-deskzo-timestamp": ts3, "x-deskzo-signature": signatureOf(renewed.data.secret, ts3, signedBody) })).status === 202);
    await inA(() => actions.setWorkflowWebhookSigned(onHook, false));

    section("The webhook route");
    const params = { params: Promise.resolve({ token: newToken }) };
    const viaRoute = await inA(() => hookRoute.POST(new NextRequest(renewed.data.address, { method: "POST", body: JSON.stringify({ name: "Route" }), headers: { "content-type": "application/json" } }), params));
    ok("a POST is answered 202, as JSON, not to be cached", viaRoute.status === 202 && (await viaRoute.json()).accepted === true && viaRoute.headers.get("cache-control") === "no-store");
    const declared = await inA(() => hookRoute.POST(new NextRequest(renewed.data.address, { method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": String(300 * 1024) } }), params));
    ok("  a body said to be over 256 KB is refused before it is read", declared.status === 413);
    const undeclared = await inA(() => hookRoute.POST(new NextRequest(renewed.data.address, { method: "POST", body: "x".repeat(300 * 1024), headers: { "content-type": "text/plain" } }), params));
    ok("  and one that doesn't say its length is cut off at 256 KB", undeclared.status === 413);
    const asGet = await hookRoute.GET();
    ok("  a GET: 405, saying to POST", asGet.status === 405 && asGet.headers.get("allow") === "POST");
    await drain();
    ok("every call taken started the workflow; none started the other", (await notes(owner)).includes("ZZ hook Route") && (await inA(() => db.automationRun.count({ where: { workflowId: otherHook } }))) === 0);
  } finally {
    outboundReset();
    for (const res of hanging) res.destroy();
    server.closeAllConnections();
    server.close();
    if (close) await close().catch(() => undefined);
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}`, err));
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_database WHERE datname IN (${Object.values(names).map((n) => `'${n}'`).join(", ")})`);
    ok("every scratch database dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot();
  await real.$disconnect();
  ok("its connections, webhook addresses, webhook events and mailboxes are as they were", realAfter === realBefore);

  console.log(failures === 0 ? `\nAll ${passes} Automate connector checks passed.\n` : `\n${failures} check(s) failed (${passes} passed).\n`);
  if (failures > 0) process.exitCode = 1;
}

/** Puts the outbound guard back as it is in production, if the suite got as far as changing it. */
function outboundReset() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("../src/lib/automate/outbound") as typeof import("../src/lib/automate/outbound")).setTestOutbound(null);
  } catch {
    /* never loaded */
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
