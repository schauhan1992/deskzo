/**
 * What a stranger with the kiosk URL can and cannot do.
 *
 * This is the first thing in the application that writes to the database without a session. The
 * token in the URL is the whole of the authentication, so every assumption the rest of the app
 * makes — that the caller is an employee, that somebody is accountable for the row — is false here.
 *
 * The ways it fails are quiet:
 *
 *   - a deactivated tablet that still answers, so a link taken off a decommissioned device keeps
 *     working;
 *   - a directory that returns emails and phone numbers along with names, which turns a lobby
 *     tablet into a staff contact export;
 *   - a missing rate limit, which turns it into a way to send a colleague four hundred
 *     notifications;
 *   - and an arrival time accepted from the form rather than taken here, which makes the visitor
 *     book a record of what people typed.
 *
 *   npm run check:visitors
 *
 * Everything is created under a reserved prefix and removed again, so this is safe to run against
 * a database with real data in it.
 */
import Module from "node:module";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import type { Role } from "@/lib/roles";
import { db } from "../src/lib/db";
import { generateCode, inviteMessage, isWithinWindow, looksLikeCode, normaliseCode } from "../src/lib/visitors/invite-code";
import { emailRequiredFor, isUsableCompany, looksLikeEmail, normaliseCompany } from "../src/lib/visitors/company-name";

const PREFIX = "ZZVisit";
const EMAIL = "zzvisit.";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

type Actor = { id: string; name: string; email: string; role: Role };
let actor: Actor | null = null;
const actAs = (u: { id: string; name: string; email: string; role: Role }) => {
  actor = { id: u.id, name: u.name, email: u.email, role: u.role };
};

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const sessionStub = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called a signed-in action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const cacheStub = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn };
const substitutes = new Map<string, unknown>([
  [load.resolve("../src/lib/session"), sessionStub],
  [load.resolve("next/cache"), cacheStub],
]);
const realLoad = internals._load;
internals._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

// The public module is loaded the same way, but note that nothing in it calls requireUser — the
// stub is there for the signed-in half of the module, which this check also exercises.
const publicApi = load("../src/actions/visitor-public") as typeof import("../src/actions/visitor-public");
const visitors = load("../src/actions/visitor") as typeof import("../src/actions/visitor");

async function makeUser(name: string, role: Role, departmentId?: string) {
  return db.user.create({
    data: {
      name: `${PREFIX} ${name}`,
      email: `${EMAIL}${name.toLowerCase()}@example.invalid`,
      passwordHash: await bcrypt.hash("x", 4),
      role,
      active: true,
      departmentId: departmentId ?? null,
    },
  });
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { startsWith: EMAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.visitorCompany.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.visitorInvite.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.visitorEntry.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.visitorKiosk.deleteMany({ where: { name: { startsWith: PREFIX } } });
  // Before the users, because the vendor and customer fixtures were created by one of them and
  // the foreign key is not nullable.
  await db.company.deleteMany({ where: { name: { startsWith: PREFIX } } });
  if (ids.length > 0) {
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await db.department.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function main() {
  await cleanup();

  const dept = await db.department.create({ data: { name: `${PREFIX} Accounts` } });
  const admin = await makeUser("Admin", "ADMIN");
  const host = await makeUser("Host", "ACCOUNTS", dept.id);
  const colleague = await makeUser("Colleague", "ACCOUNTS", dept.id);

  actAs(admin);
  const made = await visitors.saveKiosk({ name: `${PREFIX} Main reception` });
  ok("A kiosk is created", made.ok, made.ok ? "" : made.error);
  if (!made.ok) return;

  const kiosk = await db.visitorKiosk.findUniqueOrThrow({ where: { id: made.data.id }, select: { token: true } });
  ok(
    "Its token is long enough to be the whole of the security",
    kiosk.token.length >= 32,
    `${kiosk.token.length} characters — 192 bits, the same as the feedback links`,
  );

  section("What the tablet is given");

  const directory = await publicApi.kioskDirectory(kiosk.token);
  ok("A valid token returns the directory", directory !== null);
  ok(
    "  names and departments only",
    directory !== null &&
      !JSON.stringify(directory).includes(EMAIL) &&
      directory.people.every((p) => Object.keys(p).sort().join() === "departmentId,id,name"),
    directory ? Object.keys(directory.people[0] ?? {}).join(", ") : "",
  );
  ok(
    "  no contact details of any kind leave the building",
    directory !== null && !JSON.stringify(directory).match(/phone|email|designation/i),
    "a lobby tablet must not be a staff contact export",
  );

  ok("A wrong token returns nothing", (await publicApi.kioskDirectory(randomBytes(24).toString("base64url"))) === null);
  ok("  an empty one too", (await publicApi.kioskDirectory("")) === null);

  await db.visitorKiosk.update({ where: { id: made.data.id }, data: { active: false } });
  ok(
    "A deactivated tablet stops answering",
    (await publicApi.kioskDirectory(kiosk.token)) === null,
    "a link taken off a decommissioned device must stop working",
  );
  const deadCheckIn = await publicApi.checkIn({
    token: kiosk.token, purpose: "MEETING", hostUserId: host.id, name: `${PREFIX} Nobody`, phone: "9999999999",
  });
  ok("  and stops accepting sign-ins", !deadCheckIn.ok, deadCheckIn.ok ? "it accepted one" : deadCheckIn.error);
  await db.visitorKiosk.update({ where: { id: made.data.id }, data: { active: true } });

  section("Signing in");

  const before = new Date();
  const signedIn = await publicApi.checkIn({
    token: kiosk.token,
    purpose: "INTERVIEW",
    hostUserId: host.id,
    name: `${PREFIX} Ravi Kumar`,
    phone: "98765 43210",
    company: PREFIX + " Acme Ltd",
    email: "ravi@acme.example",
    photoUnavailable: true,
    companions: [{ name: `${PREFIX} Meera` }],
  });
  ok("A visitor signs in", signedIn.ok, signedIn.ok ? `badge #${signedIn.badgeNo}` : signedIn.error);
  if (!signedIn.ok) return;
  ok("  and is told who they're seeing", signedIn.hostName === host.name, signedIn.hostName ?? "");

  const entry = await db.visitorEntry.findFirstOrThrow({
    where: { name: { startsWith: `${PREFIX} Ravi` } },
    include: { companions: true },
  });
  ok(
    "The arrival time was taken by the system, not the form",
    entry.checkedInAt >= before && entry.checkedInAt <= new Date(),
    "a self-reported arrival time is not a record of anything",
  );
  ok("  the companion came with them", entry.companions.length === 1 && entry.companions[0]!.name.includes("Meera"));
  ok("  they are marked as in the building", entry.status === "IN");
  ok(
    "  and the department was inferred from the host",
    entry.departmentId === dept.id,
    "so a fire list still works when nobody picked a team",
  );

  const told = await db.notification.findFirst({ where: { userId: host.id, type: "VISITOR_ARRIVED" } });
  ok("The host is told", told !== null, told?.title);
  ok(
    "  and nobody else is",
    (await db.notification.count({ where: { userId: colleague.id } })) === 0,
    "a named host is a direct message, not a department announcement",
  );

  section("What a stranger with the URL cannot do");

  const noHost = await publicApi.checkIn({
    token: kiosk.token, purpose: "MEETING", name: `${PREFIX} Nobody`, phone: "9999999999",
  });
  ok("Sign in without saying who they're seeing", !noHost.ok, noHost.ok ? "it accepted one" : noHost.error);

  const noName = await publicApi.checkIn({
    token: kiosk.token, purpose: "MEETING", hostUserId: host.id, name: "", phone: "9999999999",
  });
  ok("  or without a name", !noName.ok, noName.ok ? "" : noName.error);

  const noPhone = await publicApi.checkIn({
    token: kiosk.token, purpose: "MEETING", hostUserId: host.id, name: `${PREFIX} X`, phone: "12",
  });
  ok("  or without a reachable number", !noPhone.ok, noPhone.ok ? "" : noPhone.error);

  // The one that turns a lobby tablet into a way to flood somebody's notifications.
  let accepted = 0;
  for (let i = 0; i < 10; i++) {
    const r = await publicApi.checkIn({
      token: kiosk.token, purpose: "MEETING", hostUserId: host.id,
      name: `${PREFIX} Flood ${i}`, phone: "9000000000",
      company: PREFIX + " Floodco", email: "flood@example.com", photoUnavailable: true,
    });
    if (r.ok) accepted += 1;
  }
  ok(
    "Ten sign-ins in a second are rate limited",
    accepted < 10,
    `${accepted} of 10 accepted — otherwise the URL is a way to send somebody four hundred notifications`,
  );

  section("The book");

  actAs(admin);
  const book = await visitors.listVisitors({ status: "ALL" });
  ok("An admin can read it", book !== null && book.length > 0, `${book?.length} entries`);

  const onSite = await visitors.visitorsOnSite();
  ok("  and see who is still in the building", onSite !== null && onSite.length > 0, `${onSite?.length} on site`);

  const out = await visitors.checkOut(entry.id);
  ok("Signing somebody out works", out.ok, out.ok ? "" : out.error);
  const twice = await visitors.checkOut(entry.id);
  ok("  and cannot be done twice", !twice.ok, twice.ok ? "" : twice.error);

  // Yesterday's visitor who never signed out.
  const yesterday = new Date(Date.now() - 36 * 3600_000);
  await db.visitorEntry.create({
    data: { name: `${PREFIX} Forgot`, phone: "9000000001", hostUserId: host.id, checkedInAt: yesterday, status: "IN" },
  });
  const closed = await visitors.closeStaleVisits();
  ok(
    "Yesterday's un-signed-out visitors are closed off",
    closed.ok && closed.data.closed >= 1,
    closed.ok ? `${closed.data.closed} closed` : closed.error,
  );
  const abandoned = await db.visitorEntry.findFirstOrThrow({ where: { name: `${PREFIX} Forgot` } });
  ok(
    "  marked as never signed out, not as signed out",
    abandoned.status === "ABANDONED",
    "nobody actually saw them leave, and the book should not claim otherwise",
  );

  actAs(colleague);
  ok("Somebody without the permission cannot read the book", (await visitors.listVisitors()) === null);
  ok("  and cannot set up a tablet", (await visitors.listKiosks()) === null);


  // Rotation happens at the end of this file, so everything below uses the token as it stands now.
  const liveToken = (await db.visitorKiosk.findUniqueOrThrow({ where: { id: made.data.id }, select: { token: true } })).token;


  section("Company names, without a database");

  ok("Case and punctuation are ignored", normaliseCompany("Acme Ltd.") === normaliseCompany("acme ltd"));
  ok(
    "  legal suffixes are stripped, both of them",
    normaliseCompany("Acme Pvt Ltd") === "acme",
    normaliseCompany("Acme Pvt Ltd"),
  );
  ok(
    "  but a name that is only a suffix survives",
    normaliseCompany("Ltd") === "ltd",
    "stripping it would leave the empty string, which collides with everything",
  );
  ok(
    "Two genuinely different firms stay apart",
    normaliseCompany("Sharma Industries") !== normaliseCompany("Sharma Solutions"),
    "a normaliser that is too keen merges companies that have nothing to do with each other",
  );
  ok("A name too short to be one is refused", !isUsableCompany(" a "));

  ok("A plausible email passes", looksLikeEmail("ravi@acme.co.in"));
  ok("  one with no domain does not", !looksLikeEmail("ravi@acme"));
  ok("  nor one with no at-sign", !looksLikeEmail("ravi.acme.com"));
  ok("  nor an empty one", !looksLikeEmail("   "));

  // The flood test above deliberately tripped the per-minute limiter, and it counts rows rather
  // than time. Clearing its entries puts the desk back in service — the limiter itself was
  // already asserted, and leaving it tripped would fail everything below for the wrong reason.
  await db.visitorEntry.deleteMany({ where: { name: { startsWith: PREFIX + " Flood" } } });

  section("What a walk-in must now provide");

  const noCompany = await publicApi.checkIn({
    token: kiosk.token, purpose: "MEETING", hostUserId: host.id,
    name: PREFIX + " NoCo", phone: "9000000002", email: "a@b.com", photoUnavailable: true,
  });
  ok("Company is required", !noCompany.ok, noCompany.ok ? "it accepted one" : noCompany.error);

  const noEmail = await publicApi.checkIn({
    token: kiosk.token, purpose: "MEETING", hostUserId: host.id,
    name: PREFIX + " NoMail", phone: "9000000003", company: PREFIX + " Northwind", photoUnavailable: true,
  });
  ok("  email too", !noEmail.ok, noEmail.ok ? "it accepted one" : noEmail.error);

  const badEmail = await publicApi.checkIn({
    token: kiosk.token, purpose: "MEETING", hostUserId: host.id,
    name: PREFIX + " BadMail", phone: "9000000004", company: PREFIX + " Northwind",
    email: "not-an-address", photoUnavailable: true,
  });
  ok("  and it has to look like one", !badEmail.ok, badEmail.ok ? "" : badEmail.error);

  ok(
    "  a courier is not asked for one",
    !emailRequiredFor("DELIVERY") &&
      emailRequiredFor("MEETING") &&
      emailRequiredFor("INTERVIEW") &&
      emailRequiredFor("VENDOR"),
    "demanding one produces a@a.com forty times a week, which is worse than an empty column",
  );

  const delivery = await publicApi.checkIn({
    token: kiosk.token, purpose: "DELIVERY", hostUserId: host.id,
    name: PREFIX + " Courier", phone: "9000000008", company: PREFIX + " Blue Dart",
    photoUnavailable: true,
  });
  ok("  and can sign in without one", delivery.ok, delivery.ok ? "" : delivery.error);

  const deliveryNoCompany = await publicApi.checkIn({
    token: kiosk.token, purpose: "DELIVERY", hostUserId: host.id,
    name: PREFIX + " Courier2", phone: "9000000009", photoUnavailable: true,
  });
  ok(
    "  but still has to say which company",
    !deliveryNoCompany.ok,
    deliveryNoCompany.ok ? "it accepted one" : deliveryNoCompany.error,
  );

  const deliveryBadEmail = await publicApi.checkIn({
    token: kiosk.token, purpose: "DELIVERY", hostUserId: host.id,
    name: PREFIX + " Courier3", phone: "9000000010", company: PREFIX + " Blue Dart",
    email: "rubbish", photoUnavailable: true,
  });
  ok(
    "  and an address they do volunteer still has to be one",
    !deliveryBadEmail.ok,
    deliveryBadEmail.ok ? "it accepted rubbish" : deliveryBadEmail.error,
  );

  const noPhoto = await publicApi.checkIn({
    token: kiosk.token, purpose: "MEETING", hostUserId: host.id,
    name: PREFIX + " NoPic", phone: "9000000005", company: PREFIX + " Northwind", email: "a@b.com",
  });
  ok(
    "A photo is required",
    !noPhoto.ok,
    noPhoto.ok ? "it accepted one" : noPhoto.error,
  );

  const cameraOut = await publicApi.checkIn({
    token: kiosk.token, purpose: "MEETING", hostUserId: host.id,
    name: PREFIX + " CamOut", phone: "9000000006", company: PREFIX + " Northwind Traders Ltd",
    email: "cam@northwind.example", photoUnavailable: true,
  });
  ok(
    "  unless the camera genuinely is not there",
    cameraOut.ok,
    cameraOut.ok ? "" : cameraOut.error,
  );
  const camEntry = await db.visitorEntry.findFirstOrThrow({ where: { name: PREFIX + " CamOut" } });
  ok(
    "  and the record says so rather than looking like a skipped step",
    (camEntry.note ?? "").includes("camera unavailable"),
    camEntry.note ?? "(no note)",
  );

  section("The company list learns");

  const listed = await db.visitorCompany.findFirst({ where: { normalizedName: normaliseCompany(PREFIX + " Northwind Traders Ltd") } });
  ok("A new company is remembered", listed !== null, listed?.name);
  ok("  with its first spelling kept", listed?.name === PREFIX + " Northwind Traders Ltd", listed?.name);

  // The same firm, spelled differently, must find the existing row.
  await publicApi.checkIn({
    token: kiosk.token, purpose: "MEETING", hostUserId: host.id,
    name: PREFIX + " Second Visitor", phone: "9000000007", company: (PREFIX + " northwind traders").toLowerCase(),
    email: "two@northwind.example", photoUnavailable: true,
  });
  // Matched on the substring, not on normaliseCompany("Northwind") — that yields "northwind",
  // while both spellings above normalise to "northwind traders". The assertion is that there is
  // one row for the firm, whatever it is keyed on.
  const again = await db.visitorCompany.findMany({ where: { normalizedName: { contains: (PREFIX + " northwind traders").toLowerCase() } } });
  ok(
    "  a different spelling does not add a second row",
    again.length === 1,
    again.length + " row(s) — this is the whole reason the list is worth keeping",
  );
  ok("  and the visit count went up", again[0].visitCount === 2, String(again[0].visitCount));

  const searchHit = await publicApi.searchVisitorCompanies(kiosk.token, PREFIX + " North");
  ok("The tablet can search it", searchHit.length === 1 && searchHit[0].name === PREFIX + " Northwind Traders Ltd", JSON.stringify(searchHit));
  ok(
    "  one letter returns nothing",
    (await publicApi.searchVisitorCompanies(kiosk.token, "n")).length === 0,
    "a single character per keystroke is enumeration with extra steps",
  );
  ok(
    "  an empty query returns nothing",
    (await publicApi.searchVisitorCompanies(kiosk.token, "")).length === 0,
  );
  ok(
    "  and a bad token returns nothing",
    (await publicApi.searchVisitorCompanies("not-a-token", PREFIX + " North")).length === 0,
  );

  section("Vendors brought across");

  actAs(admin);
  await db.company.create({
    data: {
      name: PREFIX + " Supplier Pvt Ltd",
      normalizedName: (PREFIX + " supplier pvt ltd").toLowerCase(),
      relationshipType: "VENDOR",
      createdById: admin.id,
    },
  });
  const customer = await db.company.create({
    data: {
      name: PREFIX + " Big Customer",
      normalizedName: (PREFIX + " big customer").toLowerCase(),
      relationshipType: "CLIENT",
      createdById: admin.id,
    },
  });

  const imported = await visitors.importVendorCompanies();
  ok("Vendors come across", imported.ok && imported.data.added >= 1, imported.ok ? String(imported.data.added) : imported.error);
  ok(
    "  and customers do not",
    (await db.visitorCompany.count({ where: { normalizedName: normaliseCompany(customer.name) } })) === 0,
    "a tablet anybody can type into must never become a way to read the client book",
  );
  ok(
    "  the vendor is now offered at the desk",
    (await publicApi.searchVisitorCompanies(kiosk.token, PREFIX + " Supp")).length === 1,
  );

  const reimported = await visitors.importVendorCompanies();
  ok(
    "Running it again adds nothing",
    reimported.ok && reimported.data.added === 0,
    reimported.ok ? reimported.data.added + " added the second time" : reimported.error,
  );

  section("Merging duplicates");

  const dupe = await db.visitorCompany.create({
    data: { name: PREFIX + " Northwind Group", normalizedName: normaliseCompany(PREFIX + " Northwind Group"), visitCount: 3 },
  });
  const keep = again[0];
  const merged = await visitors.mergeVisitorCompanies(dupe.id, keep.id);
  ok("Two entries fold together", merged.ok, merged.ok ? merged.data.moved + " visits moved" : merged.error);
  ok("  the duplicate is gone", (await db.visitorCompany.findUnique({ where: { id: dupe.id } })) === null);
  ok(
    "  and its visits were added on",
    (await db.visitorCompany.findUniqueOrThrow({ where: { id: keep.id } })).visitCount === 5,
  );
  const intoItself = await visitors.mergeVisitorCompanies(keep.id, keep.id);
  ok("  merging something into itself is refused", !intoItself.ok, intoItself.ok ? "" : intoItself.error);

  actAs(colleague);
  ok("Somebody without the permission cannot manage the list", (await visitors.listVisitorCompanies()) === null);
  actAs(admin);

  section("Invite codes, without a database");

  const sample = generateCode();
  ok("A code is eight characters", sample.length === 8, sample);
  ok(
    "  from an alphabet with no lookalikes in it",
    !/[O0I1L]/.test(sample) && looksLikeCode(sample),
    "somebody reads this off a phone and types it on a tablet — every O/0 pair is a support call",
  );
  ok("  and two codes differ", generateCode() !== generateCode());
  ok("  lowercase and spacing are forgiven", normaliseCode(" abcd-2345 ") === "ABCD2345", normaliseCode(" abcd-2345 "));
  ok("  a short one is refused before anything is looked up", !looksLikeCode("ABC123"));
  ok("  and one containing an excluded letter too", !looksLikeCode("ABCD234O"));

  const due = new Date("2026-09-22T14:30:00.000Z");
  ok("A code works on the day", isWithinWindow(due, new Date("2026-09-22T09:00:00.000Z")));
  ok(
    "  and the following morning",
    isWithinWindow(due, new Date("2026-09-23T09:00:00.000Z")),
    "a meeting that moved should not turn somebody away at the door",
  );
  ok("  not the day before", !isWithinWindow(due, new Date("2026-09-21T23:00:00.000Z")));
  ok(
    "  and not two days later",
    !isWithinWindow(due, new Date("2026-09-24T09:00:00.000Z")),
    "a code live for a week is a code worth stealing",
  );

  section("Pre-registering a visitor");

  actAs(admin);
  const soon = new Date(Date.now() + 3600_000);
  const invited = await visitors.createInvite({
    hostUserId: host.id,
    purpose: "MEETING",
    name: PREFIX + " Anita Desai",
    phone: "98111 22233",
    company: PREFIX + " Northwind",
    expectedAt: soon.toISOString().slice(0, 16),
    expectedCompanions: 2,
  });
  ok("An invitation is created", invited.ok, invited.ok ? invited.data.code : invited.error);
  if (!invited.ok) return;

  ok(
    "  the host is told somebody booked for them",
    (await db.notification.count({ where: { userId: host.id, type: "VISITOR_EXPECTED" } })) === 1,
  );

  const message = inviteMessage({
    name: "Anita", code: invited.data.code, hostName: host.name, companyName: "Wroffy",
    expectedAt: soon, formatWhen: (d) => d.toDateString(),
  });
  ok("The shareable message carries the code", message.includes(invited.data.code));
  ok(
    "  and never the kiosk link",
    !message.includes("/kiosk") && !message.includes(liveToken),
    "the code is useless without standing at the desk; the tablet link is a staff-directory credential",
  );

  section("Arriving on an invitation");

  const wrongCode = await publicApi.lookupInvite(liveToken, "ZZZZ9999");
  ok("A wrong code finds nothing", !wrongCode.ok, wrongCode.ok ? "it resolved" : wrongCode.error);

  const found = await publicApi.lookupInvite(liveToken, invited.data.code.toLowerCase());
  ok("The real code resolves, even typed in lowercase", found.ok, found.ok ? found.name : found.error);
  ok(
    "  and returns only enough to confirm it is them",
    found.ok && Object.keys(found).sort().join() === "expectedCompanions,hostName,name,ok,purpose",
    found.ok ? Object.keys(found).join(", ") : "",
  );
  ok(
    "  never their phone number or email",
    found.ok && !JSON.stringify(found).includes("98111"),
    "a short code on an unauthenticated endpoint must not be a way to harvest contact details",
  );

  const arrived = await publicApi.checkInWithInvite({ token: liveToken, code: invited.data.code, photoUnavailable: true });
  ok("They sign in with it", arrived.ok, arrived.ok ? "badge #" + arrived.badgeNo : arrived.error);

  const consumed = await db.visitorInvite.findFirstOrThrow({ where: { code: invited.data.code } });
  ok("  the invitation is marked arrived", consumed.status === "ARRIVED");
  ok("  and points at the visit it became", consumed.entryId !== null);
  const fromInvite = await db.visitorEntry.findUniqueOrThrow({ where: { id: consumed.entryId ?? "" } });
  ok(
    "  the details came from the invitation, not the tablet",
    fromInvite.company === PREFIX + " Northwind" && fromInvite.phone === "98111 22233",
    "which is the whole point — they gave these to their host already",
  );

  const reused = await publicApi.checkInWithInvite({ token: liveToken, code: invited.data.code, photoUnavailable: true });
  ok("A code cannot be used twice", !reused.ok, reused.ok ? "IT LET THEM IN AGAIN" : reused.error);

  section("Guessing at codes");

  // A run of wrong codes, which is what somebody working through the keyspace looks like.
  let lockedAt = 0;
  for (let i = 1; i <= 12; i++) {
    const r = await publicApi.lookupInvite(liveToken, "ZZZZ" + String(1000 + i));
    if (!r.ok && r.error.includes("Too many") && lockedAt === 0) lockedAt = i;
  }
  ok(
    "The desk stops answering after a run of wrong codes",
    lockedAt > 0 && lockedAt <= 10,
    "locked out at attempt " + lockedAt,
  );

  // A genuine visitor arriving after somebody else's typos must not be turned away.
  await db.visitorKiosk.update({ where: { id: made.data.id }, data: { failedLookups: 0, failedSince: null } });
  const second = await visitors.createInvite({
    hostUserId: host.id, name: PREFIX + " Second", expectedAt: new Date().toISOString().slice(0, 16),
  });
  if (second.ok) {
    await publicApi.lookupInvite(liveToken, "ZZZZ8888");
    const good = await publicApi.lookupInvite(liveToken, second.data.code);
    ok("  a correct code clears the counter", good.ok, good.ok ? "" : good.error);
    const kioskNow = await db.visitorKiosk.findUniqueOrThrow({ where: { id: made.data.id } });
    ok("  so one typo cannot lock out the next visitor", kioskNow.failedLookups === 0);
  }

  {
    /**
     * The same run of guesses, against the endpoint that *writes*.
     *
     * The throttle lived only on `lookupInvite`, so it protected the read-only screen and nothing
     * else: a guesser skipping straight to `checkInWithInvite` got unlimited attempts at the same
     * keyspace, and a hit there does not merely confirm a code — it signs that person in, prints
     * them a badge and tells the host they have arrived.
     */
    await db.visitorKiosk.update({ where: { id: made.data.id }, data: { failedLookups: 0, failedSince: null } });

    let blockedAt = 0;
    for (let i = 1; i <= 12; i++) {
      const r = await publicApi.checkInWithInvite({ token: liveToken, code: "YYYY" + String(2000 + i), photoUnavailable: true });
      if (!r.ok && r.error.includes("Too many") && blockedAt === 0) blockedAt = i;
    }
    ok("Signing in stops answering after a run of wrong codes too", blockedAt > 0 && blockedAt <= 10, "blocked at attempt " + blockedAt);

    // And nobody got in along the way.
    const strays = await db.visitorEntry.count({ where: { kioskId: made.data.id, name: { startsWith: "YYYY" } } });
    ok("  and no guess ever signed anybody in", strays === 0, strays + " entries");

    await db.visitorKiosk.update({ where: { id: made.data.id }, data: { failedLookups: 0, failedSince: null } });
  }

  section("Cancelling and expiring");

  actAs(admin);
  const third = await visitors.createInvite({
    hostUserId: host.id, name: PREFIX + " Third", expectedAt: new Date().toISOString().slice(0, 16),
  });
  if (third.ok) {
    const cancelled = await visitors.cancelInvite(third.data.id);
    ok("An invitation can be cancelled", cancelled.ok, cancelled.ok ? "" : cancelled.error);
    const dead = await publicApi.lookupInvite(liveToken, third.data.code);
    ok("  and its code stops working immediately", !dead.ok, dead.ok ? "it still resolved" : dead.error);
  }

  const alreadyHere = await visitors.cancelInvite(consumed.id);
  ok("Somebody already here cannot be un-invited", !alreadyHere.ok, alreadyHere.ok ? "" : alreadyHere.error);

  await db.visitorInvite.create({
    data: {
      code: generateCode(), hostUserId: host.id, name: PREFIX + " NoShow",
      expectedAt: new Date(Date.now() - 5 * 86400000),
    },
  });
  const swept = await visitors.expireStaleInvites();
  ok("Old invitations are swept up", swept.ok && swept.data.expired >= 1, swept.ok ? String(swept.data.expired) : swept.error);

  section("Rotating a link");

  actAs(admin);
  const rotated = await visitors.rotateKioskToken(made.data.id);
  ok("The link can be rotated", rotated.ok, rotated.ok ? "" : rotated.error);
  ok(
    "  and the old one stops working immediately",
    (await publicApi.kioskDirectory(kiosk.token)) === null,
    "the only remedy for a link that has gone somewhere unexpected is a different link",
  );
  ok(
    "  while the new one works",
    rotated.ok && (await publicApi.kioskDirectory(rotated.data.token)) !== null,
  );

  console.log(failures === 0 ? "\nAll visitor checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await db.$disconnect();
  });
