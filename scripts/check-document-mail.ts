/**
 * Emailing documents from people's own Outlook — src/actions/document-mail.ts, src/lib/mail,
 * src/lib/documents/{render-token,render-grant,pdf,email-template}.ts.
 *
 *   · Without a database: render passes (forged, tampered, expired, for another document, for another
 *     path), the wording (fields, fallbacks, typos, recipients' names, HTML escaping, file names),
 *     whose mailbox may be connected, the Microsoft sign-in address (PKCE, scopes), and the sealed
 *     state a connection carries to Microsoft and back.
 *   · Through the real code, against a stand-in Microsoft on a local port: connecting; sending with
 *     the PDF attached to exactly the people ticked; refusing drafts, cancelled and purchase
 *     documents, other customers' contacts, bounced addresses, unknown fields and a missing
 *     permission; refreshing and rotating tokens; a revoked connection marked broken; a retry after
 *     one 401; failures logged with why; nothing sent while viewing as somebody; templates.
 *   · A render pass minted by a send opens exactly one print page, once.
 *   · The real browser turns a page into a PDF — skipped, and said so, if the machine has none.
 *
 * Never talks to Microsoft and never sends mail: every Microsoft address points at a local server
 * this script runs, and the send path's PDF comes from a stand-in. Fixtures are marked Zzdm and
 * removed in a `finally`; document email templates are put back exactly as found.
 *
 *   npm run check:document-mail
 */
import "dotenv/config";
import Module from "node:module";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { PrismaClient, type DocumentEmailTemplate } from "@prisma/client";
import { newRenderToken, printPathDocumentId, verifyRenderToken, RENDER_TTL_MS } from "../src/lib/documents/render-token";
import {
  DEFAULT_TEMPLATES,
  EMAILABLE_TYPES,
  MERGE_FIELDS,
  attachmentName,
  isEmailable,
  mergeTemplate,
  recipientNames,
  toEmailHtml,
  type MergeValues,
} from "../src/lib/documents/email-template";
import { encryptSecret, decryptSecret } from "../src/lib/crypto";

const db = new PrismaClient();
const MAIL = "@zzprobe-docmail.invalid";
const TAG = "Zzdm";
const RUN = Date.now().toString(36);

let actor: { id: string; name: string; email: string; role: string } | null = null;
let viewingAs = false;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const fakeSecurity = {
  id: "global",
  microsoftTenantId: "zz-tenant",
  microsoftClientId: "zz-client",
  microsoftClientSecretCipher: encryptSecret("zz-secret"),
  ssoEnabled: true,
};
const substitutes = new Map<string, unknown>([
  [
    load.resolve("../src/lib/session"),
    {
      requireUser: async () => {
        if (!actor) throw new Error("The check called an action without saying who was calling it.");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => (viewingAs ? { user: actor, actor } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody else." : null),
    },
  ],
  [load.resolve("next/cache"), { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }],
  [load.resolve("next/headers"), { headers: async () => new Headers({ host: "localhost:3999" }), cookies: async () => ({ get: () => undefined }) }],
  // The Microsoft app's settings, so the suite never touches the real Security settings row.
  [load.resolve("../src/lib/security-settings"), { getCachedSecuritySettings: async () => fakeSecurity, getSecuritySettings: async () => fakeSecurity }],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

// ─── A stand-in Microsoft ────────────────────────────────────────────────────────────────────────

type Mode = { token: "ok" | "invalid_grant"; me: string; send: "ok" | "fail" | "401-once" };
const mode: Mode = { token: "ok", me: "", send: "ok" };
const seen: { tokenGrants: string[]; sends: Record<string, unknown>[]; sendAuth: string[] } = { tokenGrants: [], sends: [], sendAuth: [] };
let issued = 0;
let unauthorisedOnce = false;

function startFakeMicrosoft(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/zz-tenant/oauth2/v2.0/token" && req.method === "POST") {
        const form = new URLSearchParams(raw);
        seen.tokenGrants.push(form.get("grant_type") ?? "");
        if (form.get("client_secret") !== "zz-secret") return json(401, { error: "invalid_client" });
        if (mode.token === "invalid_grant") return json(400, { error: "invalid_grant", error_description: "AADSTS50173: The provided grant has expired." });
        issued += 1;
        return json(200, { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600, scope: "User.Read Mail.Send openid profile" });
      }
      if (url.pathname === "/v1.0/me" && req.method === "GET") {
        return json(200, { mail: mode.me, userPrincipalName: mode.me, displayName: "Zzdm Sender" });
      }
      if (url.pathname === "/v1.0/me/sendMail" && req.method === "POST") {
        seen.sendAuth.push(req.headers.authorization ?? "");
        if (mode.send === "401-once" && !unauthorisedOnce) {
          unauthorisedOnce = true;
          return json(401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } });
        }
        if (mode.send === "fail") return json(500, { error: { code: "ErrorInternalServerError", message: "The mailbox is temporarily unavailable." } });
        seen.sends.push(JSON.parse(raw));
        res.writeHead(202);
        return res.end();
      }
      json(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────────

let templatesBefore: DocumentEmailTemplate[] = [];

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await db.marketingMessage.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.suppression.deleteMany({ where: { value: { endsWith: MAIL.slice(1) } } });
  await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function restoreTemplates() {
  await db.documentEmailTemplate.deleteMany({});
  for (const t of templatesBefore) await db.documentEmailTemplate.create({ data: t });
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("Render passes");

  const doc = "cmzzdocument0000000000001";
  const other = "cmzzdocument0000000000002";
  const { token, nonce } = newRenderToken(doc);
  ok("a fresh pass is good for its document", verifyRenderToken(token, doc) === nonce);
  ok("…and for no other", verifyRenderToken(token, other) === null);
  const [n, e, s] = token.split(".");
  ok("a tampered signature is refused", verifyRenderToken(`${n}.${e}.${s.slice(0, -2)}AA`, doc) === null);
  ok("a changed expiry is refused", verifyRenderToken(`${n}.${Number(e) + 60_000}.${s}`, doc) === null);
  ok("an expired pass is refused", verifyRenderToken(token, doc, Date.now() + RENDER_TTL_MS + 1000) === null);
  ok("a pass dated far ahead is refused", verifyRenderToken(newRenderToken(doc, Date.now() + 3_600_000).token, doc) === null);
  for (const bad of ["", "x", "a.b.c", `${n}.${e}`, `${n}.${e}.${s}.extra`, "x".repeat(300)]) ok(`garbage is refused (${bad.slice(0, 12) || "empty"})`, verifyRenderToken(bad, doc) === null);
  ok("the print path is recognised", printPathDocumentId(`/documents/${doc}/print`) === doc);
  for (const p of [`/documents/${doc}/print/x`, `/documents/${doc}`, "/documents/../print", `/documents/${doc}/edit`, `/api/documents/${doc}/print`]) {
    ok(`no other path is (${p})`, printPathDocumentId(p) === null);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  section("The wording");

  const full: MergeValues = Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, f.example]));
  for (const t of EMAILABLE_TYPES) {
    const subject = mergeTemplate(DEFAULT_TEMPLATES[t].subject, full);
    const body = mergeTemplate(DEFAULT_TEMPLATES[t].body, full);
    ok(`the built-in ${t.toLowerCase()} wording fills in`, subject.ok && body.ok, !body.ok ? body.error : "");
  }
  const bare = mergeTemplate(DEFAULT_TEMPLATES.INVOICE.body, { ...full, "document.dueDate": null, "sender.phone": null, "recipient.names": "" });
  ok("a missing due date, phone and name fall back", bare.ok && bare.text.includes("the date shown on the invoice") && bare.text.startsWith("Dear Sir/Madam"), !bare.ok ? bare.error : "");
  ok("…and the empty phone leaves no dangling line", bare.ok && !bare.text.endsWith("\n"));
  ok("a value is trimmed in", mergeTemplate("Hi {{customer.name}}", { "customer.name": "  Acme  " }).ok);
  const typo = mergeTemplate("Due {{document.duedate}}", full);
  ok("a misspelt field is caught", !typo.ok && typo.error.includes("document.duedate"));
  const missing = mergeTemplate("Due {{document.dueDate}}", { ...full, "document.dueDate": null });
  ok("a field with no value and no fallback is caught", !missing.ok && missing.error.includes("document.dueDate"));
  ok("a stray brace is caught", !mergeTemplate("Total {{document.total}} }}", full).ok);
  ok("one name", recipientNames(["Rahul Mehta"]) === "Rahul");
  ok("two names", recipientNames(["Rahul Mehta", "Priya Shah"]) === "Rahul and Priya");
  ok("three names", recipientNames(["Rahul Mehta", "Priya Shah", "Amit"]) === "Rahul, Priya and Amit");
  ok("no names", recipientNames([]) === "");
  const html = toEmailHtml('Hello <script>alert("x")</script>\nline two\n\nNew para & more');
  ok("the message is escaped into HTML", !html.includes("<script>") && html.includes("&lt;script&gt;") && html.includes("&amp; more"));
  ok("line breaks and paragraphs survive", html.includes("<br>") && (html.match(/<p /g) ?? []).length === 2);
  ok("the attachment name is file-safe", attachmentName("Tax invoice", "INV/2026-27/0142") === "Tax-invoice-INV-2026-27-0142.pdf");
  ok("a document with no number still gets a name", attachmentName("Proposal", null) === "Proposal-draft.pdf");
  ok("purchase documents are not emailable", !isEmailable("PURCHASE_ORDER") && !isEmailable("BILL") && isEmailable("CREDIT_NOTE"));

  // ─────────────────────────────────────────────────────────────────────────────
  section("Connecting a mailbox");

  const ms = load("../src/lib/mail/microsoft") as typeof import("../src/lib/mail/microsoft");
  const state = load("../src/lib/mail/connect-state") as typeof import("../src/lib/mail/connect-state");
  ok("the mailbox must be the account's own", ms.mailboxFor("A@X.com", { mail: "a@x.com", userPrincipalName: null, displayName: null }) === "a@x.com");
  ok("…matched on the sign-in name too", ms.mailboxFor("a@x.com", { mail: "alias@x.com", userPrincipalName: "A@x.com", displayName: null }) === "A@x.com");
  ok("…and nobody else's", ms.mailboxFor("a@x.com", { mail: "b@x.com", userPrincipalName: "b@x.com", displayName: null }) === null);
  const pair = ms.pkcePair();
  ok("the PKCE challenge is the verifier's SHA-256", pair.challenge === createHash("sha256").update(pair.verifier).digest("base64url"));
  const authUrl = new URL(ms.authorizeUrl({ tenantId: "t", clientId: "c", clientSecret: "s" }, { redirectUri: "https://erp.example/cb", state: "st", challenge: pair.challenge, loginHint: "a@x.com" }));
  ok("the sign-in asks for Mail.Send and a refresh token", /Mail\.Send/.test(authUrl.searchParams.get("scope") ?? "") && /offline_access/.test(authUrl.searchParams.get("scope") ?? ""));
  ok("…with S256 PKCE, the state, and the account", authUrl.searchParams.get("code_challenge_method") === "S256" && authUrl.searchParams.get("state") === "st" && authUrl.searchParams.get("login_hint") === "a@x.com");
  const sealed = state.sealState({ state: "st", verifier: "v", userId: "u", expires: Date.now() + 60_000, next: "/profile" });
  ok("the connect state survives the round trip", state.openState(sealed)?.userId === "u");
  ok("…is refused once expired", state.openState(state.sealState({ state: "st", verifier: "v", userId: "u", expires: Date.now() - 1, next: "/" })) === null);
  ok("…and when tampered with", state.openState(sealed.slice(0, -4) + "AAAA") === null);
  ok("only an in-app path is a place to return to", state.safeNext("https://evil.example") === "/profile" && state.safeNext("//evil.example") === "/profile" && state.safeNext("/documents/x") === "/documents/x");

  // ─────────────────────────────────────────────────────────────────────────────
  section("Through the real code");

  const fake = await startFakeMicrosoft();
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  ms.setTestMicrosoftEndpoints({ login: base, graph: base });
  const pdfModule = load("../src/lib/documents/pdf") as typeof import("../src/lib/documents/pdf");
  const FAKE_PDF = Buffer.from("%PDF-1.4\n% zzdm stand-in\n%%EOF\n");
  const rendered: string[] = [];
  pdfModule.setTestPdfRenderer(async (url) => {
    rendered.push(url);
    return FAKE_PDF;
  });

  await cleanup();
  templatesBefore = await db.documentEmailTemplate.findMany();
  try {
    const mk = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `${name} Zzdm`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: "ZZDM" })) },
        },
      });
    const sender = await mk("Sender", { "documents.view": true, "documents.send": true, "companies.viewAll": true });
    const viewer = await mk("Viewer", { "documents.view": true, "documents.send": false, "companies.viewAll": true });
    const admin = await mk("Admin", { "settings.manage": true });
    const as = (u: { id: string; name: string; email: string; role: string }) => {
      actor = { id: u.id, name: u.name, email: u.email, role: u.role };
    };

    const customer = await db.company.create({ data: { name: `${TAG} Customer ${RUN}`, normalizedName: `${TAG} customer ${RUN}`.toLowerCase(), createdById: sender.id } });
    const elsewhere = await db.company.create({ data: { name: `${TAG} Elsewhere ${RUN}`, normalizedName: `${TAG} elsewhere ${RUN}`.toLowerCase(), createdById: sender.id } });
    const contact = (companyId: string, name: string, email: string | null, extra: Record<string, boolean> = {}) =>
      db.contact.create({ data: { companyId, name, email, ...extra } });
    const rahul = await contact(customer.id, "Rahul Zzdm", `rahul${MAIL}`, { receivesDocuments: true });
    const priya = await contact(customer.id, "Priya Zzdm", `priya${MAIL}`, { isPrimary: true });
    const bounced = await contact(customer.id, "Bounced Zzdm", `bounced${MAIL}`);
    const noMail = await contact(customer.id, "Nomail Zzdm", null);
    const stranger = await contact(elsewhere.id, "Stranger Zzdm", `stranger${MAIL}`);
    await db.suppression.create({ data: { scope: "EMAIL", value: `bounced${MAIL}`, reason: "HARD_BOUNCE" } });

    const docOf = (docType: "INVOICE" | "PROPOSAL" | "PURCHASE_ORDER", status: "ISSUED" | "DRAFT" | "CANCELLED", suffix: string, extra: Record<string, unknown> = {}) =>
      db.tradeDocument.create({
        data: { docNumber: `ZZDM-${RUN}-${suffix}`, docType, direction: docType === "PURCHASE_ORDER" ? "PURCHASE" : "SALES", status, companyId: customer.id, createdById: sender.id, ...extra },
      });
    const invoice = await docOf("INVOICE", "ISSUED", "INV", { dueDate: new Date("2026-10-25T00:00:00Z"), issueDate: new Date("2026-09-25T00:00:00Z") });
    const draft = await docOf("INVOICE", "DRAFT", "DRAFT");
    const cancelled = await docOf("INVOICE", "CANCELLED", "CAN");
    const po = await docOf("PURCHASE_ORDER", "ISSUED", "PO");

    const mail = load("../src/actions/document-mail") as typeof import("../src/actions/document-mail");

    // Preparing.
    as(viewer);
    ok("without documents.send the dialog is refused", !(await mail.prepareDocumentEmail(invoice.id)).ok);
    as(sender);
    for (const [label, d] of [["a draft", draft], ["a cancelled invoice", cancelled], ["a purchase order", po]] as const) {
      ok(`${label} can't be emailed`, !(await mail.prepareDocumentEmail(d.id)).ok);
    }
    const prepared = await mail.prepareDocumentEmail(invoice.id);
    ok("an issued invoice can", prepared.ok, JSON.stringify(prepared).slice(0, 200));
    if (!prepared.ok) throw new Error("cannot continue");
    const verdict = (id: string) => prepared.contacts.find((c) => c.id === id);
    ok("a bounced address is shown as blocked, with why", verdict(bounced.id)?.canReceive === false && /bounced/i.test(verdict(bounced.id)?.blockedBecause ?? ""));
    ok("a contact with no address is shown as blocked", verdict(noMail.id)?.canReceive === false);
    ok("another customer's contact isn't listed", !prepared.contacts.some((c) => c.id === stranger.id));
    ok("whoever receives invoices is ticked", prepared.preselected.join() === rahul.id);
    ok("no mailbox yet", prepared.mailbox.state === "not-connected");
    await db.contact.update({ where: { id: rahul.id }, data: { receivesDocuments: false } });
    const fallback = await mail.prepareDocumentEmail(invoice.id);
    ok("with nobody ticked, the primary contact is", fallback.ok && fallback.preselected.join() === priya.id);
    await db.contact.update({ where: { id: rahul.id }, data: { receivesDocuments: true } });

    const input = (over: Partial<import("../src/actions/document-mail").SendDocumentInput> = {}) => ({
      documentId: invoice.id,
      contactIds: [rahul.id, priya.id],
      subject: DEFAULT_TEMPLATES.INVOICE.subject,
      body: DEFAULT_TEMPLATES.INVOICE.body,
      ...over,
    });
    const notConnected = await mail.sendDocumentEmail(input());
    ok("nothing goes before a mailbox is connected", !notConnected.ok && /Connect your Outlook/.test(notConnected.error));

    // Connecting, as the callback does.
    mode.me = sender.email;
    const app = await ms.microsoftApp();
    ok("the Microsoft app is read from Security settings", app?.clientId === "zz-client");
    const exchanged = await ms.exchangeCode(app!, { code: "zz-code", verifier: pair.verifier, redirectUri: "http://localhost:3999/api/mail/microsoft/callback" });
    ok("a code is exchanged for tokens", exchanged.ok && !!exchanged.tokens.refreshToken);
    if (!exchanged.ok) throw new Error("cannot continue");
    const me = await ms.fetchMe(exchanged.tokens.accessToken);
    const mailbox = ms.mailboxFor(sender.email, me!);
    ok("the mailbox Microsoft reports is the sender's", mailbox === sender.email);
    await ms.saveConnection(sender.id, mailbox!, me!.displayName, { ...exchanged.tokens, refreshToken: exchanged.tokens.refreshToken! });
    const stored = await db.mailConnection.findUnique({ where: { userId: sender.id } });
    ok("the refresh token is stored encrypted", !!stored && stored.refreshTokenCipher !== exchanged.tokens.refreshToken && decryptSecret(stored.refreshTokenCipher) === exchanged.tokens.refreshToken);

    // Refusals.
    ok("a bounced address is refused", !(await mail.sendDocumentEmail(input({ contactIds: [bounced.id] }))).ok);
    ok("another customer's contact is refused", !(await mail.sendDocumentEmail(input({ contactIds: [stranger.id] }))).ok);
    ok("nobody at all is refused", !(await mail.sendDocumentEmail(input({ contactIds: [] }))).ok);
    ok("an unknown field is refused", !(await mail.sendDocumentEmail(input({ body: "Hi {{contact.shoeSize}}" }))).ok);
    ok("a two-line subject is refused", !(await mail.sendDocumentEmail(input({ subject: "One\nTwo" }))).ok);
    ok("a draft is refused at send too", !(await mail.sendDocumentEmail(input({ documentId: draft.id }))).ok);
    as(viewer);
    ok("without documents.send it is refused", !(await mail.sendDocumentEmail(input())).ok);
    as(sender);
    viewingAs = true;
    ok("nothing is sent while viewing as somebody", !(await mail.sendDocumentEmail(input())).ok);
    viewingAs = false;
    ok("none of those reached Outlook", seen.sends.length === 0 && rendered.length === 0, `${seen.sends.length} sends, ${rendered.length} renders`);

    // The send.
    const sent = await mail.sendDocumentEmail(input());
    ok("it sends", sent.ok, JSON.stringify(sent));
    const message = seen.sends[0] as {
      message: { subject: string; body: { contentType: string; content: string }; toRecipients: { emailAddress: { address: string } }[]; attachments: { name: string; contentBytes: string; contentType: string }[] };
      saveToSentItems: boolean;
    };
    ok("to exactly the people ticked", message?.message.toRecipients.map((r) => r.emailAddress.address).sort().join() === [rahul.email, priya.email].sort().join());
    ok("from their own mailbox, saved to Sent Items", message?.saveToSentItems === true && sent.ok && sent.data.from === sender.email);
    ok("the subject is filled in", message?.message.subject === `Tax invoice ${invoice.docNumber} from ${(await load("../src/lib/organisation").getOrganisation()).tradeName || (await load("../src/lib/organisation").getOrganisation()).legalName || (await load("../src/actions/branding").getBranding()).appName}`, message?.message.subject);
    ok("the greeting names who it is going to", message?.message.body.content.includes("Dear Rahul and Priya"));
    ok("the due date is in India time", message?.message.body.content.includes("25 Oct 2026"), message?.message.body.content.slice(0, 300));
    const attachment = message?.message.attachments[0];
    ok("the PDF is attached, named for the document", attachment?.name === `Tax-invoice-ZZDM-${RUN}-INV.pdf` && attachment.contentType === "application/pdf");
    ok("…and is the PDF that was made", !!attachment && Buffer.from(attachment.contentBytes, "base64").equals(FAKE_PDF));

    // The render pass the send minted.
    const renderUrl = new URL(rendered[0] ?? "http://x/");
    const pass = renderUrl.searchParams.get("render");
    const spend = (load("../src/lib/documents/render-grant") as typeof import("../src/lib/documents/render-grant")).spendRenderGrant;
    // On the workspace's own address: a bare loopback would name no workspace to print from.
    const workspaceOrigin = await (load("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve")).tenantOrigin();
    ok("the PDF was printed from this document's print page, on the workspace's address", renderUrl.pathname === `/documents/${invoice.id}/print` && renderUrl.origin === workspaceOrigin, `${renderUrl.origin} vs ${workspaceOrigin}`);
    ok("the pass won't open another document", (await spend(pass, draft.id)) === null);
    ok("the pass opens this one as the sender", (await spend(pass, invoice.id)) === sender.id);
    ok("…once", (await spend(pass, invoice.id)) === null);

    // What was recorded.
    const logged = await db.marketingMessage.findMany({ where: { tradeDocumentId: invoice.id } });
    ok("one log row per person, sent, from their mailbox", logged.length === 2 && logged.every((m) => m.status === "SENT" && m.fromEmail === sender.email && m.sentByUserId === sender.id && m.messageClass === "TRANSACTIONAL"));
    const after = await db.tradeDocument.findUnique({ where: { id: invoice.id }, select: { lastEmailedAt: true } });
    ok("the document knows when it was emailed", !!after?.lastEmailedAt);
    ok("it is audited", (await db.auditLog.count({ where: { userId: sender.id, entityType: "TradeDocument", entityId: invoice.id } })) === 1);
    ok("the history lists it", (await mail.listDocumentEmails(invoice.id)).length === 2);
    ok("no sender refresh was needed with a fresh token", !seen.tokenGrants.includes("refresh_token"));

    // An expired access token: refreshed, and the rotated refresh token kept.
    await db.mailConnection.update({ where: { userId: sender.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    const second = await mail.sendDocumentEmail(input({ contactIds: [rahul.id] }));
    const rotated = await db.mailConnection.findUnique({ where: { userId: sender.id } });
    ok("an expired token is refreshed and the send goes", second.ok && seen.tokenGrants.includes("refresh_token"));
    ok("…and the new refresh token is the one kept", decryptSecret(rotated!.refreshTokenCipher) === `refresh-${issued}`);

    // One 401 from Graph: a fresh token and one more try.
    mode.send = "401-once";
    const retried = await mail.sendDocumentEmail(input({ contactIds: [priya.id] }));
    ok("a 401 is retried once with a fresh token", retried.ok && seen.sendAuth.slice(-2)[0] !== seen.sendAuth.slice(-1)[0]);
    mode.send = "ok";

    // Outlook failing: nothing marked sent, the failure logged with why.
    mode.send = "fail";
    const lastBefore = (await db.tradeDocument.findUnique({ where: { id: invoice.id }, select: { lastEmailedAt: true } }))!.lastEmailedAt;
    const failed = await mail.sendDocumentEmail(input({ contactIds: [rahul.id] }));
    const failedRow = await db.marketingMessage.findFirst({ where: { tradeDocumentId: invoice.id, status: "FAILED" } });
    ok("a refusal from Outlook is reported", !failed.ok && /temporarily unavailable/.test(failed.ok ? "" : failed.error));
    ok("…logged as not sent, with why", failedRow?.error?.includes("temporarily unavailable") === true);
    ok("…and doesn't count as emailed", (await db.tradeDocument.findUnique({ where: { id: invoice.id }, select: { lastEmailedAt: true } }))!.lastEmailedAt?.getTime() === lastBefore?.getTime());
    mode.send = "ok";

    // A revoked connection.
    mode.token = "invalid_grant";
    await db.mailConnection.update({ where: { userId: sender.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    const revoked = await mail.sendDocumentEmail(input({ contactIds: [rahul.id] }));
    ok("a revoked connection stops the send", !revoked.ok);
    ok("…and is marked broken until reconnected", !!(await db.mailConnection.findUnique({ where: { userId: sender.id } }))?.brokenAt);
    const brokenPrep = await mail.prepareDocumentEmail(invoice.id);
    ok("the dialog then asks to reconnect", brokenPrep.ok && brokenPrep.mailbox.state === "broken");
    mode.token = "ok";

    // The profile card.
    viewingAs = true;
    ok("nobody else's connection is shown while viewing as them", (await mail.getMailConnection()) === null);
    viewingAs = false;
    ok("your own is", (await mail.getMailConnection())?.connection?.mailbox === sender.email);
    await mail.disconnectMailbox();
    ok("disconnecting removes it", !(await db.mailConnection.findUnique({ where: { userId: sender.id } })));

    // Templates.
    as(sender);
    ok("without settings.manage the wording can't be changed", !(await mail.saveDocumentEmailTemplate({ docType: "INVOICE", subject: "x", body: "y" })).ok);
    as(admin);
    ok("a misspelt field is refused on save", !(await mail.saveDocumentEmailTemplate({ docType: "INVOICE", subject: "Invoice {{document.numbr}}", body: "Hi" })).ok);
    ok("purchase documents have no template", !(await mail.saveDocumentEmailTemplate({ docType: "PURCHASE_ORDER", subject: "x", body: "y" })).ok);
    ok("a good template saves", (await mail.saveDocumentEmailTemplate({ docType: "INVOICE", subject: "Zzdm {{document.number}}", body: "Zzdm body for {{customer.name}}" })).ok);
    as(sender);
    const custom = await mail.prepareDocumentEmail(invoice.id);
    ok("the dialog uses the saved wording", custom.ok && custom.template.subject === "Zzdm {{document.number}}");
    as(admin);
    await mail.resetDocumentEmailTemplate("INVOICE");
    as(sender);
    const reset = await mail.prepareDocumentEmail(invoice.id);
    ok("resetting goes back to the built-in wording", reset.ok && reset.template.subject === DEFAULT_TEMPLATES.INVOICE.subject);
  } finally {
    actor = null;
    pdfModule.setTestPdfRenderer(null);
    ms.setTestMicrosoftEndpoints(null);
    fake.close();
    await cleanup();
    await restoreTemplates();
    const now = await db.documentEmailTemplate.findMany();
    ok("the document email templates are exactly as found", JSON.stringify(now) === JSON.stringify(templatesBefore));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  section("A real browser making a PDF");

  const browser = pdfModule.findBrowser();
  if (!browser) {
    console.log("  skip  no Chrome, Chromium or Edge on this machine — set PDF_BROWSER_PATH to test it");
  } else {
    const page = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head><style>@page{size:A4;margin:12mm}</style></head><body><h1>Tax invoice ZZDM</h1><p>₹1,18,000.00</p></body></html>");
    });
    await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", () => resolve()));
    try {
      const started = Date.now();
      const pdf = await pdfModule.renderPdf(`http://127.0.0.1:${(page.address() as AddressInfo).port}/`);
      ok("the browser prints a page to a real PDF", pdf.subarray(0, 5).toString("latin1") === "%PDF-" && pdf.length > 1000, `${pdf.length} bytes in ${Date.now() - started} ms with ${browser}`);
    } catch (e) {
      ok("the browser prints a page to a real PDF", false, (e as Error).message);
    } finally {
      page.close();
    }
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll document mail checks passed.");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  await restoreTemplates().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
