/**
 * check:domain-edge — workspaces' own addresses on Cloudflare for SaaS (src/lib/platform/cloudflare-hostnames.ts,
 * and its part in src/lib/platform/domains.ts and lifecycle.ts):
 *
 *   · nothing is asked of Cloudflare while it isn't connected, nor for an address whose records don't check out;
 *   · a waiting address is added once its records check out, stays waiting while Cloudflare confirms it and issues
 *     its certificate — its page says so, with the TXT record Cloudflare asks for — and goes live when it has;
 *   · one already on Cloudflare (added by hand) is picked up rather than added twice, and so is one added meanwhile;
 *   · a live one isn't failed while a certificate is being issued or Cloudflare can't be asked, and is failed once
 *     Cloudflare has given up on it; one deleted on Cloudflare by hand is added again;
 *   · removing it, its expiry and closing its workspace take it off Cloudflare — not while another workspace is
 *     still waiting on it — and what couldn't be removed is left in the audit log;
 *   · the daily sweep puts a waiting one live once its certificate is out;
 *   · every request carries the token and names the zone; Check connection reads the fallback origin.
 *
 * Against the local control plane, with scratch workspaces (prefix "zzedge", removed at the end, pass or fail).
 * DNS is a stub and so is Cloudflare (`globalThis.fetch`): nothing leaves the machine. The Cloudflare settings
 * this run saves are put back as they were.
 */
import "dotenv/config";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
const DAY = 86_400_000;

// ─── DNS, stubbed ────────────────────────────────────────────────────────────────────────────────
const dns = { txt: new Map<string, string[][]>(), cname: new Map<string, string[]>() };
const dnsError = (code: string) => Object.assign(new Error(`query ${code}`), { code });
const fakeResolver = {
  resolveTxt: async (name: string) => dns.txt.get(name) ?? Promise.reject(dnsError("ENOTFOUND")),
  resolveCname: async (name: string) => dns.cname.get(name) ?? Promise.reject(dnsError("ENODATA")),
  resolve4: async () => Promise.reject(dnsError("ENODATA")),
  resolve6: async () => Promise.reject(dnsError("ENODATA")),
};
function publish(host: string, token: string, target: string) {
  dns.txt.set(`_domain-verify.${host}`, [[`domain-verify=${token}`]]);
  dns.cname.set(host, [target]);
}

// ─── Cloudflare, stubbed ─────────────────────────────────────────────────────────────────────────
const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "zzedge-token-0123456789abcdefghijklmnopqrstuv";
type Fake = {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string; validation_records: { txt_name?: string; txt_value?: string; http_url?: string }[]; validation_errors: { message: string }[] };
  ownership_verification: { type: "txt"; name: string; value: string };
  verification_errors: string[];
};
const cf = {
  hostnames: new Map<string, Fake>(),
  calls: [] as { method: string; path: string; auth: string | null; body: unknown }[],
  down: false,
  failDelete: false,
  /** The next add finds the address added meanwhile by somebody else: Cloudflare refuses it as a duplicate. */
  raceOnCreate: false,
  next: 1,
};
function fakeHostname(hostname: string, status = "pending", ssl = "initializing"): Fake {
  const id = `cfh-${String(cf.next++).padStart(4, "0")}`;
  const h: Fake = {
    id,
    hostname,
    status,
    ssl: { status: ssl, validation_records: [{ http_url: `http://${hostname}/.well-known/pki-validation/x.txt` }], validation_errors: [] },
    ownership_verification: { type: "txt", name: `_cf-custom-hostname.${hostname}`, value: `own-${id}` },
    verification_errors: [],
  };
  cf.hostnames.set(id, h);
  return h;
}
const byName = (hostname: string) => [...cf.hostnames.values()].find((h) => h.hostname === hostname) ?? null;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, code: number, message: string) => reply(status, { success: false, errors: [{ code, message }], result: null });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "api.cloudflare.com") throw new Error(`check:domain-edge: unexpected request to ${url.href}`);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  cf.calls.push({ method, path: `${url.pathname}${url.search}`, auth: headers.get("authorization"), body });
  if (cf.down) throw new TypeError("fetch failed");
  const m = url.pathname.match(/^\/client\/v4\/zones\/([^/]+)\/custom_hostnames(?:\/([^/]+))?$/);
  if (!m) return refuse(404, 7003, "Could not route to that path");
  if (headers.get("authorization") !== `Bearer ${TOKEN}`) return refuse(403, 10000, "Authentication error");
  if (m[1] !== ZONE) return refuse(403, 9109, "Unauthorized to access requested resource");
  const id = m[2] ? decodeURIComponent(m[2]) : null;
  if (id === "fallback_origin") return reply(200, { success: true, errors: [], result: { origin: "origin.zzedge.example", status: "active", errors: [] } });
  if (!id && method === "GET") {
    const name = url.searchParams.get("hostname");
    const found = [...cf.hostnames.values()].filter((h) => !name || h.hostname === name);
    return reply(200, { success: true, errors: [], result: found, result_info: { total_count: found.length } });
  }
  if (!id && method === "POST") {
    if (cf.raceOnCreate) {
      cf.raceOnCreate = false;
      fakeHostname(body.hostname, "active", "active");
      return refuse(409, 1406, "Duplicate custom hostname found.");
    }
    if (byName(body.hostname)) return refuse(409, 1406, "Duplicate custom hostname found.");
    return reply(200, { success: true, errors: [], result: fakeHostname(body.hostname) });
  }
  const h = id ? cf.hostnames.get(id) : undefined;
  if (!h) return refuse(404, 1436, "The custom hostname was not found.");
  if (method === "GET") return reply(200, { success: true, errors: [], result: h });
  if (method === "DELETE") {
    if (cf.failDelete) return refuse(500, 1000, "Internal error");
    cf.hostnames.delete(h.id);
    return reply(200, { success: true, errors: [], result: { id: h.id } });
  }
  return refuse(405, 10405, "Method not allowed");
}) as typeof fetch;

async function main() {
  const controlUrl = process.env.CONTROL_DATABASE_URL;
  if (!controlUrl || !process.env.PLATFORM_MASTER_KEY) throw new Error("CONTROL_DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(controlUrl).hostname)) throw new Error("check:domain-edge runs against a local control plane only.");

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
  const domains = require("../src/lib/platform/domains") as typeof import("../src/lib/platform/domains");
  const rules = require("../src/lib/platform/domain-rules") as typeof import("../src/lib/platform/domain-rules");
  const edge = require("../src/lib/platform/cloudflare-hostnames") as typeof import("../src/lib/platform/cloudflare-hostnames");
  const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const lifecycle = require("../src/lib/platform/lifecycle") as typeof import("../src/lib/platform/lifecycle");
  const { indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const control = controlDb();
  mailer.setTestPlatformMailer(async () => {});
  domains.setTestDomainResolver(fakeResolver);

  const PREFIX = "zzedge-";
  const KEYS = ["cloudflare.zoneId", "cloudflare.apiToken"];
  const before = await control.platformSetting.findMany({ where: { key: { in: KEYS } } });

  async function cleanup() {
    const tenants = await control.tenant.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } });
    const ids = tenants.map((t) => t.id);
    await control.platformAuditLog.deleteMany({ where: { OR: [{ tenantId: { in: ids } }, { actor: "check:domain-edge" }] } });
    await control.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  async function restoreSettings() {
    for (const key of KEYS) {
      const was = before.find((r) => r.key === key);
      if (was) await control.platformSetting.update({ where: { key }, data: { value: was.value, secretCipher: was.secretCipher, updatedBy: was.updatedBy } });
      else await control.platformSetting.deleteMany({ where: { key } });
    }
  }

  await cleanup();
  try {
    const make = async (key: string) => {
      const t = await control.tenant.create({
        data: { slug: `${PREFIX}${key}`, name: `Zz Edge ${key.toUpperCase()}`, status: "ACTIVE", keyBundleCipher: "pending", ownerEmail: `owner@${key}.zzedge.example` },
        select: { id: true, slug: true },
      });
      return { ...t, target: rules.routingTarget(t.slug) };
    };
    const A = await make("a");
    const B = await make("b");
    const C = await make("c");
    const add = async (t: { id: string }, host: string, opts: { createdAt?: Date } = {}) =>
      control.tenantDomain.create({
        data: { tenantId: t.id, host, kind: "CUSTOM", status: "PENDING", verifyToken: `tok-${t.id}-${host}`, addedBy: "check", ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) },
        select: { id: true, host: true, verifyToken: true },
      });
    const row = (id: string) => control.tenantDomain.findUniqueOrThrow({ where: { id }, select: { id: true, host: true, status: true, failingSince: true, lastCheckError: true, edge: true, verifyToken: true } });
    const view = async (t: { id: string }, host: string) => (await domains.workspaceDomains(t.id)).domains.find((d) => d.host === host)!;
    const check = (id: string, now = new Date()) => domains.checkDomain(id, { now, actor: "check:domain-edge" });
    const callsSince = (n: number) => cf.calls.slice(n);

    // ─── Not connected ───────────────────────────────────────────────────────────────────────────
    section("Not connected");
    await settings.setSetting("cloudflare.zoneId", null, "check");
    await settings.setSecret("cloudflare.apiToken", null, "check");
    ok("no zone and no token: not connected", (await edge.cloudflareConfig()) === null);
    const plain = await add(A, "plain.zzedge-a.example");
    publish(plain.host, plain.verifyToken!, A.target);
    const plainCheck = await check(plain.id);
    ok("an address whose records check out goes live as before", plainCheck.outcome === "verified" && plainCheck.domain?.status === "ACTIVE", plainCheck);
    ok("  and Cloudflare is never asked", cf.calls.length === 0, cf.calls);
    ok("  its page says Live, with no certificate line", (await view(A, plain.host)).statusText === "Live" && (await view(A, plain.host)).certificate === null);

    // ─── Connected ───────────────────────────────────────────────────────────────────────────────
    await settings.setSetting("cloudflare.zoneId", ZONE, "check");
    await settings.setSecret("cloudflare.apiToken", TOKEN, "check");
    ok("connected: the zone and the sealed token read back", JSON.stringify(await edge.cloudflareConfig()) === JSON.stringify({ zoneId: ZONE, token: TOKEN }));

    section("A waiting address");
    const erp = await add(A, "erp.zzedge-a.example");
    let mark = cf.calls.length;
    const noRecords = await check(erp.id);
    ok("its records not in place: waiting, and Cloudflare isn't asked", noRecords.outcome === "waiting" && callsSince(mark).length === 0, callsSince(mark));
    publish(erp.host, erp.verifyToken!, A.target);
    mark = cf.calls.length;
    const first = await check(erp.id);
    const added = callsSince(mark).find((c) => c.method === "POST");
    ok("records in place: it is added to Cloudflare", !!added && (added.body as { hostname?: string }).hostname === erp.host, callsSince(mark));
    ok("  validated over HTTP, with a DV certificate and TLS 1.2 at least", JSON.stringify((added?.body as { ssl?: unknown })?.ssl) === JSON.stringify({ method: "http", type: "dv", settings: { min_tls_version: "1.2" } }));
    ok("  every request with the token, to the zone", callsSince(mark).every((c) => c.auth === `Bearer ${TOKEN}` && c.path.startsWith(`/client/v4/zones/${ZONE}/custom_hostnames`)), callsSince(mark));
    ok("  but it stays waiting until Cloudflare has issued its certificate", first.outcome === "waiting" && first.domain?.status === "PENDING", first);
    const stored = edge.edgeOf((await row(erp.id)).edge);
    ok("  what Cloudflare said is kept on the row", stored?.id === byName(erp.host)?.id && stored?.status === "pending", stored);
    ok("  the problem says it is being confirmed, in words that name no product", /being confirmed for HTTPS/.test(first.problems.join(" ")) && !/cloudflare/i.test(first.problems.join(" ")), first.problems);
    let v = await view(A, erp.host);
    ok("  its page: 'Records found — HTTPS certificate being issued'", v.statusText === "Records found — HTTPS certificate being issued" && v.certificate === "issuing", v.statusText);
    ok("  with Cloudflare's TXT record under its own two", v.records.length === 3 && v.records[2].name === `_cf-custom-hostname.${erp.host}`, v.records);

    byName(erp.host)!.status = "active";
    byName(erp.host)!.ssl.status = "pending_validation";
    const second = await check(erp.id);
    ok("confirmed, the certificate on its way: still waiting", second.outcome === "waiting" && /certificate for erp\.zzedge-a\.example is being issued/.test(second.problems.join(" ")), second.problems);
    v = await view(A, erp.host);
    ok("  Cloudflare's TXT record no longer asked for", v.records.length === 2, v.records);

    byName(erp.host)!.ssl.status = "active";
    mark = cf.calls.length;
    const third = await check(erp.id);
    ok("certificate issued: live", third.outcome === "verified" && third.domain?.status === "ACTIVE" && third.problems.length === 0, third);
    ok("  read by its id, never added twice", callsSince(mark).every((c) => c.method === "GET") && cf.calls.filter((c) => c.method === "POST").length === 1, callsSince(mark));
    v = await view(A, erp.host);
    ok("  its page says Live, the certificate issued, no problems kept", v.statusText === "Live" && v.certificate === "issued" && v.problems.length === 0, v);

    section("Already on Cloudflare");
    const byHand = await add(B, "byhand.zzedge-b.example");
    fakeHostname(byHand.host, "active", "active");
    publish(byHand.host, byHand.verifyToken!, B.target);
    mark = cf.calls.length;
    const handCheck = await check(byHand.id);
    ok("added by hand: picked up by name, not added again, and live at once", handCheck.outcome === "verified" && !callsSince(mark).some((c) => c.method === "POST"), callsSince(mark));
    const racer = await add(B, "race.zzedge-b.example");
    publish(racer.host, racer.verifyToken!, B.target);
    cf.raceOnCreate = true;
    const raced = await check(racer.id);
    ok("added meanwhile (Cloudflare refuses a duplicate): that one is it", raced.outcome === "verified" && edge.edgeOf((await row(racer.id)).edge)?.id === byName(racer.host)?.id, raced);

    section("A live address");
    let live = byName(erp.host)!;
    cf.down = true;
    const down = await check(erp.id);
    cf.down = false;
    ok("Cloudflare unreachable: still live, not failing", down.outcome === "live" && (await row(erp.id)).failingSince === null, down);
    ok("  said so", /couldn't be read just now/.test(down.problems.join(" ")), down.problems);
    ok("  and what Cloudflare said last is kept", edge.edgeOf((await row(erp.id)).edge)?.ssl === "active");
    live.ssl.status = "pending_validation";
    const renewing = await check(erp.id);
    ok("its certificate being issued again: still live, not failing", renewing.outcome === "live" && (await row(erp.id)).failingSince === null, renewing);
    ok("  its page says so", (await view(A, erp.host)).statusText === "Live — HTTPS certificate being issued");
    live.ssl.status = "validation_timed_out";
    live.ssl.validation_errors = [{ message: "caa_error: blocked by CAA record" }];
    const gaveUp = await check(erp.id);
    ok("Cloudflare gave up on its certificate: failing", gaveUp.outcome === "failing-started" && !!(await row(erp.id)).failingSince, gaveUp);
    ok("  with Cloudflare's reason", /couldn't be issued \(caa_error: blocked by CAA record\)/.test(gaveUp.problems.join(" ")), gaveUp.problems);
    ok("  the console's line says it couldn't be issued", (await view(A, erp.host)).certificate === "failed");
    cf.hostnames.delete(live.id);
    mark = cf.calls.length;
    const readded = await check(erp.id);
    const fresh = byName(erp.host);
    ok("deleted on Cloudflare by hand: added again", !!fresh && fresh.id !== live.id && callsSince(mark).some((c) => c.method === "POST"), callsSince(mark));
    ok("  and, its certificate on the way, it is no longer failing", readded.outcome === "recovered" && (await row(erp.id)).failingSince === null, readded);
    live = fresh!;

    section("Waiting, with Cloudflare unreachable");
    const later = await add(A, "later.zzedge-a.example");
    publish(later.host, later.verifyToken!, A.target);
    cf.down = true;
    const unreachable = await check(later.id);
    cf.down = false;
    ok("stays waiting, and says why", unreachable.outcome === "waiting" && /couldn't be read just now/.test(unreachable.problems.join(" ")), unreachable);

    section("Removing");
    mark = cf.calls.length;
    await domains.removeDomain(erp.id, A.id);
    ok("removed from the workspace: removed from Cloudflare", !byName(erp.host) && callsSince(mark).some((c) => c.method === "DELETE" && c.path.endsWith(`/custom_hostnames/${live.id}`)), callsSince(mark));
    const shared = "shared.zzedge-shared.example";
    const aShared = await add(A, shared);
    const bShared = await add(B, shared);
    publish(shared, aShared.verifyToken!, A.target);
    await check(aShared.id);
    ok("two workspaces waiting on one address: on Cloudflare once A's records check out", !!byName(shared));
    await domains.removeDomain(aShared.id, A.id);
    ok("  A removes theirs: kept on Cloudflare, B still waits on it", !!byName(shared));
    await domains.removeDomain(bShared.id, B.id);
    ok("  B removes theirs too: gone from Cloudflare", !byName(shared));
    cf.failDelete = true;
    const stuck = byName(byHand.host)!;
    await domains.removeDomain(byHand.id, B.id);
    cf.failDelete = false;
    const left = await control.platformAuditLog.findFirst({ where: { tenantId: B.id, action: "tenant.domain.edge-left" }, select: { detail: true } });
    ok("Cloudflare refusing the removal: the address is still removed, and left in the audit log", !!left && (left.detail as { host?: string }).host === byHand.host && !!cf.hostnames.get(stuck.id), left);

    section("The daily sweep");
    const stale = await add(B, "stale.zzedge-b.example", { createdAt: new Date(Date.now() - 15 * DAY) });
    fakeHostname(stale.host);
    const waitingOn = await add(B, "soon.zzedge-b.example");
    publish(waitingOn.host, waitingOn.verifyToken!, B.target);
    await check(waitingOn.id);
    ok("an address waiting on its certificate", (await row(waitingOn.id)).status === "PENDING" && !!byName(waitingOn.host));
    byName(waitingOn.host)!.status = "active";
    byName(waitingOn.host)!.ssl.status = "active";
    const sweep = await domains.domainSweep(new Date(), { only: [A.id, B.id], resolver: fakeResolver });
    ok("the sweep removes one unproved for 14 days — from Cloudflare too", sweep.expired === 1 && !byName(stale.host), sweep);
    ok("  and puts the one whose certificate is out live", (await row(waitingOn.id)).status === "ACTIVE", sweep);
    ok("  nothing failed", sweep.failed.length === 0, sweep.failed);

    section("Closing a workspace");
    const closing = await add(C, "erp.zzedge-c.example");
    publish(closing.host, closing.verifyToken!, C.target);
    await check(closing.id);
    ok("C's address on Cloudflare", !!byName(closing.host));
    await lifecycle.deprovisionTenant(C.id, "script:check:domain-edge", { finalBackup: false });
    ok("closed: its addresses gone, from Cloudflare too", !byName(closing.host) && (await control.tenantDomain.count({ where: { tenantId: C.id } })) === 0);

    section("Check connection, and the words");
    const cfg = (await edge.cloudflareConfig())!;
    const conn = await edge.cloudflareConnection(cfg);
    ok("the fallback origin, its state and the zone's count", conn.fallbackOrigin === "origin.zzedge.example" && conn.fallbackStatus === "active" && conn.hostnames === cf.hostnames.size, conn);
    const wrong = await edge.cloudflareConnection({ zoneId: ZONE, token: "not-the-token-0123456789abcdefghij" }).then(
      () => "",
      (err: unknown) => (err instanceof edge.CloudflareError ? err.message : String(err)),
    );
    ok("a wrong token: Cloudflare's own refusal", wrong === "Cloudflare: Authentication error", wrong);
    const sample = edge.edgeState({ id: "x", hostname: "a.b.example", status: "moved", ssl: { status: "active" } });
    ok("moved away: failed, and said so", edge.edgeFailed(sample) && /no longer points here/.test(edge.edgeProblems(sample, "a.b.example")[0]));
    ok("nothing stored reads as none", edge.edgeOf(null) === null && edge.edgeOf({ status: "x" }) === null);
    ok("the console's words", rules.withCertificate("Live", "ACTIVE", "issuing") === "Live — HTTPS certificate being issued" && rules.withCertificate("Stopped — records not found", "BROKEN", "issuing") === "Stopped — records not found");
    ok("status text on a clock still reads as before", rules.domainStatusText({ status: "ACTIVE", failingSince: null }, indiaClock).label === "Live");
    ok("the token is a secret, the zone id a plain setting", (settings.SECRET_KEYS as readonly string[]).includes("cloudflare.apiToken") && (settings.PLAIN_KEYS as readonly string[]).includes("cloudflare.zoneId") && !(settings.GATEWAY_SECRET_KEYS as readonly string[]).includes("cloudflare.apiToken"));
  } finally {
    await cleanup();
    await restoreSettings();
    globalThis.fetch = realFetch;
    domains.setTestDomainResolver(null);
    mailer.setTestPlatformMailer(null);
    await closeControlDb();
  }

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll domain-edge checks passed.");
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
