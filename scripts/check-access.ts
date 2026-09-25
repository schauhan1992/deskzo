/**
 * Where and on what people sign in — addresses, devices, the access gate, sign-ins and their places.
 *
 *   · The rules, without a database: addresses and ranges (IPv4, IPv6, the mapped and port-carrying
 *     spellings proxies send), device types from real browser strings, the gate's decision and the
 *     order of it, network standing, impossible travel, the location permission header.
 *   · Through the real code: the gate registering devices and networks and holding people on them,
 *     approving and revoking devices (which ends sessions), allowing and blocking networks, rules
 *     that would lock their author out, location shared once per sign-in, sign-ins recorded with
 *     their place, ending a session, and `requireUser` refusing a held person — the check that
 *     covers everything the proxy does not see.
 *   · The screens: the access page a held person lands on, the settings tabs, and the profile card.
 *
 * The session and the request are stubbed — who is asking, from which address, on which browser —
 * and nothing else is: the gate, the actions and `requireUser` are the real ones. Everything is
 * named ZZPROBE_ACCESS / Zzprobe and removed in a finally, including the security alerts the probes
 * send to the real admins of this database.
 *
 *   npm run check:access
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { PrismaClient } from "@prisma/client";
import { cidrContains, formatIp, isPrivateIp, normaliseIp, parseCidr, parseIp } from "../src/lib/access/ip";
import { deviceKindFrom, deviceLabel } from "../src/lib/access/device";
import { OPEN_POLICY, decideAccess, haversineKm, impossibleTravel, networkStanding, type AccessFacts, type IpRuleLike } from "../src/lib/access/decide";
import { newDeviceToken, validDeviceToken } from "../src/lib/access/device-token";
import { permissionsPolicyFor } from "../src/lib/security/headers";
import { geoDatabaseInfo, lookupIp } from "../src/lib/access/geo";

// ─── Who is asking, and from where ───────────────────────────────────────────

let actor: { id: string; sid?: string; name: string; email: string } | null = null;
const facts = { inRequest: true, ip: null as string | null, userAgent: null as string | null, mobileHint: null as string | null, deviceToken: null as string | null };
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const at = (ip: string | null, userAgent: string, deviceToken: string | null) => Object.assign(facts, { ip, userAgent, deviceToken, mobileHint: null });

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/auth" || request.endsWith("/lib/auth")) {
    const session = async () => (actor ? { user: { ...actor, role: "PROFILE" } } : null);
    return { auth: session, signOut: async () => {}, signIn: async () => {}, handlers: {} };
  }
  if (request === "@/lib/access/request" || request.endsWith("lib/access/request")) return { requestFacts: async () => ({ ...facts }) };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/settings/security/access",
    };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  // View-as reads its own cookie; nobody here is viewing as anybody.
  if (request === "@/lib/impersonation") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, resolveViewAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = new PrismaClient();
const TAG = "ZZPROBE_ACCESS";
const ROLE = "ZZPROBE_ACCESS_ROLE";
const ADMIN_ROLE = "ZZPROBE_ACCESS_ADMIN";
const MAIL = "@zzprobe-access.invalid";
const TEST_IPS = ["203.0.113.9", "203.0.113.10", "198.51.100.7", "192.0.2.44", "49.36.0.1", "2401:4900::1"];
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const skip = (label: string, why: string) => console.log(`  skip ${label} — ${why}`);
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const probe = { OR: [{ title: { contains: "Zzprobe" } }, { message: { contains: "Zzprobe" } }, { userId: { in: userIds } }] };
  await db.notification.deleteMany({ where: probe });
  await db.activityLog.deleteMany({
    where: { OR: [{ userId: { in: userIds } }, { summary: { contains: "Zzprobe" } }, { summary: { contains: TAG } }] },
  });
  await db.ipRule.deleteMany({ where: { OR: [{ createdById: { in: userIds } }, { label: { startsWith: TAG } }] } });
  await db.networkAddress.deleteMany({ where: { ip: { in: TEST_IPS }, OR: [{ lastUserName: { startsWith: "Zzprobe" } }, { lastUserId: { in: userIds } }] } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  // Devices and sign-ins go with their users (cascade).
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.role.deleteMany({ where: { key: { in: [ROLE, ADMIN_ROLE] } } });
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("Addresses and ranges");

  ok("an IPv4 address reads as itself", formatIp(parseIp("203.0.113.9")!) === "203.0.113.9");
  ok("  with a port glued on by a proxy", normaliseIp("203.0.113.9:51234") === "203.0.113.9");
  ok("  or spelt as IPv4-mapped IPv6", normaliseIp("::ffff:203.0.113.9") === "203.0.113.9");
  ok("IPv6 is compressed the one standard way", normaliseIp("2401:4900:0000:0000:0000:0000:0000:0001") === "2401:4900::1" && normaliseIp("[::1]:3000") === "::1");
  ok("  a zone is dropped, case is folded", normaliseIp("FE80::1%eth0") === "fe80::1");
  ok("rubbish is not an address", [null, "", "999.1.1.1", "1.2.3", "1::2::3", "hello", "12345::"].every((x) => parseIp(x) === null));
  const office = parseCidr("192.168.1.7/24");
  ok("a range with its host bits set is the network it means", office?.text === "192.168.1.0/24");
  ok("  and contains its own addresses, not its neighbours'", cidrContains(office!, parseIp("192.168.1.200")!) && !cidrContains(office!, parseIp("192.168.2.1")!));
  ok("a single address is a /32, and IPv6 ranges work", parseCidr("203.0.113.9")?.text === "203.0.113.9/32" && cidrContains(parseCidr("2401:4900::/32")!, parseIp("2401:4900:abcd::7")!));
  ok("a rule for an IPv4 address matches its mapped spelling too", cidrContains(parseCidr("203.0.113.0/24")!, parseIp("::ffff:203.0.113.77")!));
  ok("families never match each other", !cidrContains(parseCidr("0.0.0.0/0")!, parseIp("::1")!));
  ok("a nonsense range is refused", [parseCidr("10.0.0.0/33"), parseCidr("10.0.0.0/x"), parseCidr("10/8/8")].every((c) => c === null));
  ok("private addresses are recognised — the office LAN, localhost, carrier NAT", ["10.1.2.3", "192.168.0.5", "127.0.0.1", "100.64.1.1", "::1", "fd00::1"].every((a) => isPrivateIp(parseIp(a)!)) && !isPrivateIp(parseIp("49.36.0.1")!));

  // ─────────────────────────────────────────────────────────────────────────────
  section("Devices, from what the browser says");

  ok("a Windows browser is a computer", deviceKindFrom(WINDOWS) === "COMPUTER" && deviceLabel(WINDOWS) === "Chrome on Windows");
  ok("an iPhone is a phone", deviceKindFrom(IPHONE) === "MOBILE" && deviceLabel(IPHONE) === "Safari on iPhone");
  ok("an Android phone is a phone, an Android tablet is a tablet", deviceKindFrom("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36") === "MOBILE" && deviceKindFrom("Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Safari/537.36") === "TABLET");
  ok("an iPad is a tablet", deviceKindFrom("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1") === "TABLET");
  ok("Chrome's mobile hint is believed", deviceKindFrom("Mozilla/5.0 (Linux; Android 10; K) Chrome/140.0.0.0 Safari/537.36 Mobile", "?1") === "MOBILE" && deviceKindFrom("Mozilla/5.0 (X11; Linux x86_64) Chrome/140", "?1") === "MOBILE");
  ok("Edge is not mistaken for Chrome", deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0") === "Edge on Windows");
  const token = newDeviceToken();
  ok("a device token is 256 random bits, and only that shape is accepted", validDeviceToken(token) && token !== newDeviceToken() && !validDeviceToken("short") && !validDeviceToken(`${token}x`));

  // ─────────────────────────────────────────────────────────────────────────────
  section("The decision, and its order");

  const now = new Date("2026-09-24T06:00:00Z");
  const rules: IpRuleLike[] = [
    { cidr: "203.0.113.0/24", action: "ALLOW", label: "Office", roleKeys: [], expiresAt: null },
    { cidr: "203.0.113.66/32", action: "BLOCK", label: "Bad host", roleKeys: [], expiresAt: null },
    { cidr: "198.51.100.0/24", action: "BLOCK", label: "Sales only", roleKeys: ["SALES"], expiresAt: null },
    { cidr: "192.0.2.0/24", action: "ALLOW", label: "Lapsed", roleKeys: [], expiresAt: new Date("2026-09-01T00:00:00Z") },
  ];
  ok("an address in an allowed range is allowed", networkStanding("203.0.113.9", "SALES", rules, now).standing === "ALLOWED");
  ok("  a block inside that range beats the allow", networkStanding("203.0.113.66", "SALES", rules, now).standing === "BLOCKED");
  ok("  a rule for one role leaves the others alone", networkStanding("198.51.100.7", "SALES", rules, now).standing === "BLOCKED" && networkStanding("198.51.100.7", "ACCOUNTS", rules, now).standing === "UNKNOWN");
  ok("  a lapsed rule does nothing", networkStanding("192.0.2.44", "SALES", rules, now).standing === "UNKNOWN");
  ok("  no address at all is unknown, never allowed", networkStanding(null, "SALES", rules, now).standing === "UNKNOWN");

  const base: AccessFacts = {
    sessionEnded: false,
    exempt: false,
    policy: { ...OPEN_POLICY },
    network: { standing: "UNKNOWN", rule: null },
    device: { kind: "COMPUTER", status: "APPROVED" },
    locationShared: false,
  };
  const reason = (f: Partial<AccessFacts>) => {
    const v = decideAccess({ ...base, ...f, policy: { ...base.policy, ...(f.policy ?? {}) } });
    return v.ok ? "OK" : v.reason;
  };
  ok("a role with no rules lets everybody in", reason({}) === "OK");
  ok("an ended session beats everything, even the super admin", reason({ sessionEnded: true, exempt: true }) === "SESSION_ENDED");
  ok("the super admin is held by nothing else", reason({ exempt: true, network: { standing: "BLOCKED", rule: "x" }, device: { kind: "MOBILE", status: "REVOKED" }, policy: { ...OPEN_POLICY, allowMobile: false, requireLocation: true } }) === "OK");
  ok("a blocked network before anything about the device", reason({ network: { standing: "BLOCKED", rule: "x" }, device: { kind: "MOBILE", status: "REVOKED" } }) === "NETWORK_BLOCKED");
  ok("unknown networks: allow, alert, hold, block", [
    reason({ policy: { ...OPEN_POLICY, unknownNetwork: "ALLOW" } }) === "OK",
    reason({ policy: { ...OPEN_POLICY, unknownNetwork: "ALERT" } }) === "OK",
    reason({ policy: { ...OPEN_POLICY, unknownNetwork: "HOLD" } }) === "NETWORK_HELD",
    reason({ policy: { ...OPEN_POLICY, unknownNetwork: "BLOCK" } }) === "NETWORK_NOT_ALLOWED",
    reason({ policy: { ...OPEN_POLICY, unknownNetwork: "BLOCK" }, network: { standing: "ALLOWED", rule: "Office" } }) === "OK",
  ].every(Boolean));
  const alert = decideAccess({ ...base, policy: { ...OPEN_POLICY, unknownNetwork: "ALERT" } });
  ok("  and 'alert' says so, so the gate can tell somebody", alert.ok && alert.alertNewNetwork);
  ok("a device type the role may not use", reason({ device: { kind: "MOBILE", status: "APPROVED" }, policy: { ...OPEN_POLICY, allowMobile: false } }) === "DEVICE_KIND");
  ok("a revoked device is out even on a role that never asked for approval", reason({ device: { kind: "COMPUTER", status: "REVOKED" } }) === "DEVICE_BLOCKED");
  ok("a device waiting, on a role that asks for approval", reason({ device: { kind: "COMPUTER", status: "PENDING" }, policy: { ...OPEN_POLICY, requireDeviceApproval: true } }) === "DEVICE_PENDING");
  ok("  and a never-seen one waits too", reason({ device: { kind: "COMPUTER", status: null }, policy: { ...OPEN_POLICY, requireDeviceApproval: true } }) === "DEVICE_PENDING");
  ok("location is asked for last — never of a device about to be turned away", reason({ device: { kind: "COMPUTER", status: "PENDING" }, policy: { ...OPEN_POLICY, requireDeviceApproval: true, requireLocation: true } }) === "DEVICE_PENDING" && reason({ policy: { ...OPEN_POLICY, requireLocation: true } }) === "LOCATION_NEEDED");
  ok("  and once shared, that's enough", reason({ policy: { ...OPEN_POLICY, requireLocation: true }, locationShared: true }) === "OK");

  const pune = { lat: 18.5204, lng: 73.8567 };
  const delhi = { lat: 28.6139, lng: 77.209 };
  const mumbai = { lat: 19.076, lng: 72.8777 };
  ok("Pune to Delhi is about 1,170 km", Math.abs(haversineKm(pune, delhi) - 1170) < 25, Math.round(haversineKm(pune, delhi)));
  const t0 = new Date("2026-09-24T04:00:00Z");
  ok("Pune, then Delhi twenty minutes later, is impossible travel", impossibleTravel({ ...pune, at: t0 }, { ...delhi, at: new Date(t0.getTime() + 20 * 60_000) })?.minutes === 20);
  ok("  Pune then Delhi six hours later is a flight", impossibleTravel({ ...pune, at: t0 }, { ...delhi, at: new Date(t0.getTime() + 6 * 3_600_000) }) === null);
  ok("  Pune then Mumbai at once is the location database, not travel", impossibleTravel({ ...pune, at: t0 }, { ...mumbai, at: t0 }) === null);

  ok("only the access page may ask for a location", permissionsPolicyFor("/access").includes("geolocation=(self)") && permissionsPolicyFor("/dashboard").includes("geolocation=()") && permissionsPolicyFor("/login").includes("geolocation=()"));

  // ─────────────────────────────────────────────────────────────────────────────
  section("Where an address is");

  const geo = geoDatabaseInfo();
  if (!geo.installed) {
    skip("city lookups", `no location database in ${geo.directory}`);
  } else {
    const mumbaiArea = lookupIp("49.36.0.1");
    ok(`a Jio address is placed in Maharashtra (${geo.type})`, mumbaiArea?.countryCode === "IN" && mumbaiArea.region === "Maharashtra", JSON.stringify(mumbaiArea));
    ok("  an IPv6 address is placed too", lookupIp("2401:4900::1")?.countryCode === "IN");
    ok("  and a private one is not looked up at all", lookupIp("192.168.1.10") === null && lookupIp("::1") === null);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const gate = require("../src/lib/access/gate") as typeof import("../src/lib/access/gate");
  const record = require("../src/lib/access/record") as typeof import("../src/lib/access/record");
  const control = require("../src/actions/access-control") as typeof import("../src/actions/access-control");
  const session = require("../src/lib/session") as typeof import("../src/lib/session");
  const page = (path: string) => (require(path) as { default: (p: unknown) => Promise<ReactElement> }).default;
  const AccessPage = page("../src/app/(auth)/access/page");
  const SettingsPage = page("../src/app/(dashboard)/settings/security/access/page");
  const html = async (el: Promise<ReactElement>) => renderToStaticMarkup((await resolveAsync(await el)) as ReactElement);

  await cleanup();
  try {
    await db.role.createMany({ data: [{ key: ROLE, name: `${TAG} role` }, { key: ADMIN_ROLE, name: `${TAG} admin role` }] });
    const make = (name: string, role: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzprobe ${name}`,
          email: `${name}${MAIL}`,
          role,
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const agent = await make("agent", ROLE, {});
    const approver = await make("approver", "PROFILE", { "access.approveDevices": true });
    const admin = await make("admin", ADMIN_ROLE, { "security.manage": true, "access.viewSignIns": true });
    const as = (u: { id: string; name: string; email: string }, sid?: string) => {
      actor = { id: u.id, name: u.name, email: u.email, sid };
    };
    const officeDesk = newDeviceToken();
    const phone = newDeviceToken();
    const adminDesk = newDeviceToken();
    const evaluate = (u: { id: string }, sid: string | null, token: string | null, ip: string, ua = WINDOWS) =>
      gate.evaluateAccess({ userId: u.id, sid, deviceToken: token, ip, userAgent: ua, mobileHint: null, path: "/dashboard" });

    // ───────────────────────────────────────────────────────────────────────────
    section("Rules for a role");

    as(admin);
    at("203.0.113.10", WINDOWS, adminDesk);
    const tight = { allowMobile: false, allowTablet: true, allowComputer: true, requireDeviceApproval: true, unknownNetwork: "HOLD" as const, requireLocation: true };
    const saved = await control.saveRolePolicy(ROLE, tight);
    ok("an admin sets the agents' role: no phones, approval, hold on unknown networks, location", saved.ok, saved.ok ? "" : saved.error);
    const lockout = await control.saveRolePolicy(ADMIN_ROLE, { ...tight, allowMobile: true, requireDeviceApproval: false, unknownNetwork: "BLOCK", requireLocation: false });
    ok("  but may not set their own role to approved networks only from a network with no rule", !lockout.ok && lockout.error.includes("lock you out"), lockout.ok ? "" : lockout.error);
    ok("  nor allow no devices at all", !(await control.saveRolePolicy(ROLE, { ...tight, allowMobile: false, allowTablet: false, allowComputer: false })).ok);
    as(approver);
    ok("somebody without the security permission can't change rules", !(await control.saveRolePolicy(ROLE, tight)).ok);

    // ───────────────────────────────────────────────────────────────────────────
    section("The gate");

    gate.clearAccessCache();
    const first = await evaluate(agent, "sid-a", officeDesk, "203.0.113.9");
    ok("an agent on a network nobody approved is held", !first.ok && first.reason === "NETWORK_HELD", first.ok ? "ok" : first.reason);
    const seen = await db.networkAddress.findUnique({ where: { ip: "203.0.113.9" } });
    ok("  the address is recorded, marked held and alerted", !!seen?.heldAt && !!seen.alertedAt && seen.lastUserName === "Zzprobe agent");
    ok("  and the security admins were told", (await db.notification.count({ where: { userId: admin.id, type: "SECURITY_ALERT", title: { contains: "new network" } } })) === 1);
    const desk = await db.userDevice.findFirst({ where: { userId: agent.id } });
    ok("  the browser became a device waiting for approval", desk?.status === "PENDING" && desk.kind === "COMPUTER" && desk.label === "Chrome on Windows");
    ok("  and the approvers were told", (await db.notification.count({ where: { userId: approver.id, title: { contains: "waiting for a device" } } })) === 1);
    // Cleared first, as a restarted server or a second process would be: the address remembers it
    // was reported, so nobody is told again.
    gate.clearAccessCache();
    await evaluate(agent, "sid-a", officeDesk, "203.0.113.9");
    ok("  once each — asking again, even after a restart, tells nobody twice", (await db.notification.count({ where: { userId: admin.id, title: { contains: "new network" } } })) === 1);

    as(admin);
    at("203.0.113.10", WINDOWS, adminDesk);
    ok("the admin allows the address from the review list", (await control.allowNetwork("203.0.113.9", `${TAG} Pune office`)).ok);
    ok("  which leaves it off the list to review", !(await control.listNetworks())?.rows.some((r) => r.ip === "203.0.113.9"));
    const second = await evaluate(agent, "sid-a", officeDesk, "203.0.113.9");
    ok("now it is the device that holds them", !second.ok && second.reason === "DEVICE_PENDING", second.ok ? "ok" : second.reason);
    const onPhone = await evaluate(agent, "sid-a", phone, "203.0.113.9", IPHONE);
    ok("  and a phone is refused outright for this role", !onPhone.ok && onPhone.reason === "DEVICE_KIND");

    as(admin);
    ok("the admin, without the approval permission, can't approve it", !(await control.decideDevice(desk!.id, "APPROVE")).ok);
    as(approver);
    ok("the approver approves it", (await control.decideDevice(desk!.id, "APPROVE")).ok);
    ok("  and the agent is told", (await db.notification.count({ where: { userId: agent.id, title: { contains: "was approved" } } })) === 1);
    const third = await evaluate(agent, "sid-a", officeDesk, "203.0.113.9");
    ok("now only the location is missing", !third.ok && third.reason === "LOCATION_NEEDED", third.ok ? "ok" : third.reason);

    at("203.0.113.9", WINDOWS, officeDesk);
    ok("a location at 0,0 is a broken sensor, and refused", !(await record.recordLocation({ userId: agent.id, sid: "sid-a", latitude: 0, longitude: 0, accuracyM: 5 })).ok);
    ok("  so is one off the planet", !(await record.recordLocation({ userId: agent.id, sid: "sid-a", latitude: 91, longitude: 10, accuracyM: 5 })).ok);
    ok("the agent shares where they are", (await record.recordLocation({ userId: agent.id, sid: "sid-a", latitude: 18.5204, longitude: 73.8567, accuracyM: 12 })).ok);
    const fourth = await evaluate(agent, "sid-a", officeDesk, "203.0.113.9");
    ok("  and is in", fourth.ok, fourth.ok ? "" : fourth.reason);
    const nextSession = await evaluate(agent, "sid-b", officeDesk, "203.0.113.9");
    ok("  a new sign-in on the same device asks again — once per sign-in, not once per device", !nextSession.ok && nextSession.reason === "LOCATION_NEEDED");

    as(approver);
    at("192.0.2.44", WINDOWS, adminDesk);
    const approverDesk = await evaluate(approver, null, adminDesk, "192.0.2.44");
    const approverDevice = await db.userDevice.findFirst({ where: { userId: approver.id } });
    ok("a role with no rules gets in, its new device allowed automatically", approverDesk.ok && approverDevice?.status === "APPROVED" && approverDevice.decidedById === null);
    ok("  nobody decides on their own device", !(await control.decideDevice(approverDevice!.id, "REVOKE")).ok);

    // ───────────────────────────────────────────────────────────────────────────
    section("Sign-ins, and ending them");

    as(agent);
    at("49.36.0.1", WINDOWS, officeDesk);
    const sid1 = await record.recordSignIn({ userId: agent.id, provider: "credentials" });
    const row1 = await db.signIn.findUnique({ where: { sid: sid1 } });
    ok("a sign-in is recorded with its address and device", row1?.ip === "49.36.0.1" && row1.deviceId === desk!.id && row1.deviceKind === "COMPUTER");
    ok("  flagged as a new network for this person", !!row1?.flags.includes("NEW_NETWORK"), row1?.flags.join());
    if (geo.installed) {
      ok("  and placed on the map", row1?.region === "Maharashtra" && row1.latitude !== null, `${row1?.city}, ${row1?.region}`);
      await db.signIn.update({ where: { sid: sid1 }, data: { at: new Date(Date.now() - 20 * 60_000) } });
      at("2401:4900::1", WINDOWS, officeDesk);
      const sid2 = await record.recordSignIn({ userId: agent.id, provider: "credentials" });
      const row2 = await db.signIn.findUnique({ where: { sid: sid2 } });
      ok("Mumbai, then Bihar twenty minutes later, is flagged as impossible travel", !!row2?.flags.includes("IMPOSSIBLE_TRAVEL"), row2?.flags.join());
      ok("  logged, and the security admins told", (await db.activityLog.count({ where: { userId: agent.id, kind: "IMPOSSIBLE_TRAVEL" } })) === 1 && (await db.notification.count({ where: { userId: admin.id, title: { contains: "impossible travel" } } })) === 1);
    } else {
      skip("places and impossible travel", "no location database");
    }

    as(admin);
    at("203.0.113.10", WINDOWS, adminDesk);
    const listed = await control.listSignIns({ userId: agent.id });
    ok("someone who may see sign-ins sees them", (listed?.total ?? 0) >= 1);
    as(approver);
    ok("  someone who approves devices does not — location is a separate trust", (await control.listSignIns()) === null);

    // A fresh session for the agent, with location shared, so ending it is the only thing in the way.
    await db.signIn.create({ data: { sid: "sid-c", userId: agent.id, provider: "credentials", deviceId: desk!.id } });
    at("203.0.113.9", WINDOWS, officeDesk);
    await record.recordLocation({ userId: agent.id, sid: "sid-c", latitude: 18.52, longitude: 73.85, accuracyM: 20 });
    ok("the agent's new session is in", (await evaluate(agent, "sid-c", officeDesk, "203.0.113.9")).ok);
    const sessionC = await db.signIn.findUnique({ where: { sid: "sid-c" } });
    as(approver);
    ok("somebody else can't end it without the security permission", !(await control.endSession(sessionC!.id)).ok);
    as(admin);
    ok("the admin ends it", (await control.endSession(sessionC!.id)).ok);
    const ended = await evaluate(agent, "sid-c", officeDesk, "203.0.113.9");
    ok("  and the next request is turned away", !ended.ok && ended.reason === "SESSION_ENDED");

    await db.signIn.create({ data: { sid: "sid-d", userId: agent.id, provider: "credentials", deviceId: desk!.id } });
    as(approver);
    const revoked = await control.decideDevice(desk!.id, "REVOKE", "Laptop reported lost");
    ok("revoking the device ends every session still open on it", revoked.ok && revoked.data.endedSessions >= 1 && !!(await db.signIn.findUnique({ where: { sid: "sid-d" } }))?.endedAt);
    const afterRevoke = await evaluate(agent, "sid-e", officeDesk, "203.0.113.9");
    ok("  and the device is refused from then on", !afterRevoke.ok && afterRevoke.reason === "DEVICE_BLOCKED");

    // ───────────────────────────────────────────────────────────────────────────
    section("Blocking networks");

    as(admin);
    at("203.0.113.10", WINDOWS, adminDesk);
    const blocked = await control.saveIpRule({ cidr: "198.51.100.0/24", action: "BLOCK", label: `${TAG} Blocked range`, roleKeys: [ROLE] });
    ok("the admin blocks a range for the agents' role", blocked.ok);
    ok("  a rule allowing most of the internet is refused", !(await control.saveIpRule({ cidr: "0.0.0.0/1", action: "ALLOW", label: `${TAG} Too wide`, roleKeys: [] })).ok);
    ok("  as is blocking the network the admin is on right now", !(await control.saveIpRule({ cidr: "203.0.113.10", action: "BLOCK", label: `${TAG} Self`, roleKeys: [] })).ok);
    at("198.51.100.7", WINDOWS, phone);
    ok("an agent on the blocked range is refused at the door, before any session", (await record.doorCheck({ id: agent.id, role: ROLE, isSuperAdmin: false })) === "NETWORK_BLOCKED");
    ok("  the approver, on another role, is not", (await record.doorCheck({ id: approver.id, role: "PROFILE", isSuperAdmin: false })) === null);
    ok("  nor is the super admin, whatever the rules say", (await record.doorCheck({ id: agent.id, role: ROLE, isSuperAdmin: true })) === null);

    // ───────────────────────────────────────────────────────────────────────────
    section("requireUser holds what the proxy doesn't see");

    as(agent, "sid-e");
    at("203.0.113.9", WINDOWS, officeDesk);
    let refused = false;
    try {
      await session.requireUser();
    } catch (err) {
      refused = err instanceof session.UnauthorizedError;
    }
    ok("a held person's server action or API call is refused by requireUser", refused);
    ok("  and currentUser treats them as signed out", (await session.currentUser()) === null);
    as(admin);
    at("203.0.113.10", WINDOWS, adminDesk);
    ok("somebody the gate lets in gets through", (await session.requireUser()).id === admin.id);
    await db.user.update({ where: { id: admin.id }, data: { active: false } });
    gate.clearAccessCache();
    let deactivated = false;
    try {
      await session.requireUser();
    } catch {
      deactivated = true;
    }
    ok("a deactivated account's session stops working at once, not when its token expires", deactivated);
    await db.user.update({ where: { id: admin.id }, data: { active: true } });
    gate.clearAccessCache();

    // ───────────────────────────────────────────────────────────────────────────
    section("The screens");

    as(agent, "sid-f");
    at("203.0.113.9", WINDOWS, phone);
    const accessPage = await html(AccessPage({ searchParams: Promise.resolve({ next: "/companies" }) }));
    ok("a held person lands on a page that says why", accessPage.includes("Not on this kind of device") || accessPage.includes("Waiting for this device"), accessPage.slice(0, 200));
    ok("  showing the device and network it is judging", accessPage.includes("203.0.113.9") && accessPage.includes("Chrome on Windows"));
    let bounced = "";
    try {
      as(approver);
      at("192.0.2.44", WINDOWS, adminDesk);
      await html(AccessPage({ searchParams: Promise.resolve({ next: "//evil.example/x" }) }));
    } catch (err) {
      bounced = String(err);
    }
    ok("  somebody not held is sent on — and never to another site", bounced.includes("redirect /dashboard"), bounced);

    as(admin);
    at("203.0.113.10", WINDOWS, adminDesk);
    const rulesTab = await html(SettingsPage({ searchParams: Promise.resolve({ tab: "rules" }) }));
    ok("the settings page shows the rules by role, with the agents' role tightened", rulesTab.includes(`${TAG} role`) && rulesTab.includes("Approved networks only") && rulesTab.includes(`${TAG} Blocked range`));
    const signInsTab = await html(SettingsPage({ searchParams: Promise.resolve({ tab: "sign-ins" }) }));
    ok("  and the sign-ins, with the flags", signInsTab.includes("Zzprobe agent") && signInsTab.includes("New network"));
    as(approver);
    const approverView = await html(SettingsPage({ searchParams: Promise.resolve({ tab: "sign-ins" }) }));
    ok("an approver gets the devices tab and not the sign-ins", approverView.includes("Devices") && !approverView.includes(">Sign-ins<") && !approverView.includes("Zzprobe agent signed"));
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll access checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
