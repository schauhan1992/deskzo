/**
 * Where an emailed document goes out from (owner, 15 Oct 2026 — src/lib/documents/mail-route*.ts).
 *
 *   · The company's choice — each person's mailbox, the company's mail server, or their mailbox if
 *     connected and the company's otherwise — and Deskzo's own mail when nothing it names is set up.
 *   · Through the company's mail server: every recipient, a copy to the sender, the sender's name over
 *     the server's address, replies to the sender, and the PDF — checked on the wire, against a fake
 *     SMTP server, and in what Resend and Elastic Email are asked to send.
 *   · Through Deskzo: the "Workspace documents" mail type, the same in the sender's and company's name.
 *   · Only somebody who changes organisation settings changes the choice.
 *
 *   npm run check:document-mail-routes
 */
import "dotenv/config";
import Module from "node:module";
import net from "node:net";
import { directClient } from "../src/lib/tenancy/direct-client";
import { chooseSender, isDocumentSendMode, senderDisplayName } from "../src/lib/documents/mail-route-labels";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe Routes", email: `routes${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zzprobe-routes.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

/** A mail server that accepts anything and remembers it: just enough SMTP for nodemailer. */
function fakeSmtp(): Promise<{ port: number; close: () => void; mails: { from: string; rcpt: string[]; data: string }[] }> {
  const mails: { from: string; rcpt: string[]; data: string }[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current = { from: "", rcpt: [] as string[], data: "" };
    let auth: "user" | "pass" | null = null;
    socket.write("220 zz.fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            mails.push(current);
            current = { from: "", rcpt: [], data: "" };
            socket.write("250 queued\r\n");
          } else current.data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          continue;
        }
        if (auth === "user") {
          auth = "pass";
          socket.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (auth === "pass") {
          auth = null;
          socket.write("235 ok\r\n");
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-zz.fake\r\n250 AUTH LOGIN PLAIN\r\n");
        else if (verb === "HELO") socket.write("250 zz.fake\r\n");
        else if (verb === "AUTH") {
          if (/^AUTH PLAIN \S+/i.test(line)) socket.write("235 ok\r\n");
          else {
            auth = "user";
            socket.write("334 VXNlcm5hbWU6\r\n");
          }
        } else if (verb === "MAIL") {
          current.from = line;
          socket.write("250 ok\r\n");
        } else if (verb === "RCPT") {
          current.rcpt.push(/<([^>]+)>/.exec(line)?.[1] ?? line);
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go on\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close(), mails })));
}

const PDF = Buffer.from("%PDF-1.4 zz invoice\n%%EOF");

async function main() {
  section("Which way a document goes");

  ok("each person's mailbox, connected: theirs", chooseSender("OWN", "connected", true) === "OWN");
  ok("  not connected, where the company offers one: they connect it first", chooseSender("OWN", "not-connected", true) === "CONNECT");
  ok("  broken: they connect it again", chooseSender("OWN", "broken", false) === "CONNECT");
  ok("  no mailbox app at all — nothing set up: Deskzo", chooseSender("OWN", "app-missing", false) === "DESKZO");
  ok("the company's mail server: the company's, connected mailbox or not", chooseSender("COMPANY", "connected", true) === "COMPANY" && chooseSender("COMPANY", "not-connected", true) === "COMPANY");
  ok("  not set up: Deskzo", chooseSender("COMPANY", "connected", false) === "DESKZO");
  ok("their mailbox if connected: theirs", chooseSender("OWN_THEN_COMPANY", "connected", true) === "OWN");
  ok("  otherwise the company's", chooseSender("OWN_THEN_COMPANY", "not-connected", true) === "COMPANY" && chooseSender("OWN_THEN_COMPANY", "broken", true) === "COMPANY");
  ok("  and with neither, Deskzo", chooseSender("OWN_THEN_COMPANY", "not-connected", false) === "DESKZO");
  ok("the three choices, and nothing else", ["OWN", "COMPANY", "OWN_THEN_COMPANY"].every(isDocumentSendMode) && !isDocumentSendMode("DESKZO"));
  ok("the sender's name with the company's", senderDisplayName("Priya Sharma", "Acme Traders") === "Priya Sharma (Acme Traders)");
  ok("  never anything that could break a header", senderDisplayName('Zz "Evil" <x@y>\r\nBcc: a@b', "Acme") === "Zz Evil x@y Bcc: a@b (Acme)");

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { smtpProvider, resendProvider, elasticProvider } = require("../src/lib/marketing/providers/email") as typeof import("../src/lib/marketing/providers/email");
  const route = require("../src/lib/documents/mail-route") as typeof import("../src/lib/documents/mail-route");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const catalogue = require("../src/lib/console-shared/mail-catalogue") as typeof import("../src/lib/console-shared/mail-catalogue");
  const actions = require("../src/actions/document-mail") as typeof import("../src/actions/document-mail");
  const { encryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");

  const documentMessage = {
    to: "buyer.zz@example.com",
    toName: "Zz Buyer",
    moreTo: [{ email: "accounts.zz@example.com", name: "Zz Accounts" }],
    bcc: ["priya.zz@example.com"],
    fromName: "Priya Sharma (Acme Traders)",
    replyTo: "priya.zz@example.com",
    subject: "Tax invoice INV/2026/0042",
    html: "<p>Please find it attached.</p>",
    text: "Please find it attached.",
    attachments: [{ filename: "Tax-invoice-INV-2026-0042.pdf", contentType: "application/pdf", content: PDF }],
  };

  section("On the wire, through an SMTP server");

  const smtp = await fakeSmtp();
  try {
    const config = { key: "smtp", label: "Zz SMTP", fromName: "Acme Accounts", fromEmail: "accounts@acme.zz", replyTo: "noreply@acme.zz", config: { host: "127.0.0.1", port: String(smtp.port), user: "accounts@acme.zz" }, secret: "zz-password" };
    const sent = await smtpProvider.send(documentMessage, config);
    const wire = smtp.mails.at(-1);
    ok("the server takes it", sent.ok && !!wire, sent.ok ? "" : sent.error);
    ok("  addressed to every recipient, and the sender's copy", !!wire && ["buyer.zz@example.com", "accounts.zz@example.com", "priya.zz@example.com"].every((a) => wire.rcpt.includes(a)), wire?.rcpt.join(", "));
    ok("  the copy is blind — not in the headers", !!wire && !/^Bcc:/im.test(wire.data) && !/^(To|Cc):.*priya\.zz/im.test(wire.data));
    ok("  from the server's address, in the sender's name", !!wire && /^From: "Priya Sharma \(Acme Traders\)" <accounts@acme\.zz>/im.test(wire.data), wire?.data.split("\n").find((l) => l.startsWith("From:")));
    ok("  replies to the sender, not the account's reply-to", !!wire && /^Reply-To: priya\.zz@example\.com/im.test(wire.data));
    ok("  with the PDF attached", !!wire && wire.data.includes('filename=Tax-invoice-INV-2026-0042.pdf') && wire.data.includes(PDF.toString("base64").slice(0, 20)));
    const plain = await smtpProvider.send({ to: "one.zz@example.com", subject: "Zz plain", html: "<p>x</p>" }, config);
    const plainWire = smtp.mails.at(-1);
    ok("a marketing message is as it was: one recipient, the account's name and reply-to", plain.ok && plainWire?.rcpt.join() === "one.zz@example.com" && /^From: "?Acme Accounts"? <accounts@acme\.zz>/im.test(plainWire.data) && /^Reply-To: noreply@acme\.zz/im.test(plainWire.data));
  } finally {
    smtp.close();
  }

  section("What the HTTP providers are asked to send");

  const realFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ id: "zz-1", MessageID: "zz-2" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const config = { key: "resend", label: "Zz", fromName: "Acme Accounts", fromEmail: "accounts@acme.zz", replyTo: null, config: {}, secret: "re_zz" };
    await resendProvider.send(documentMessage, config);
    const r = bodies.at(-1) as { to: string[]; bcc: string[]; reply_to: string; from: string; attachments: { filename: string; content: string }[] };
    ok("Resend: every recipient, the copy, the reply-to and the sender's name", r.to.length === 2 && r.bcc[0] === "priya.zz@example.com" && r.reply_to === "priya.zz@example.com" && r.from.startsWith('"Priya Sharma (Acme Traders)"'));
    ok("  and the PDF", r.attachments?.[0]?.filename === "Tax-invoice-INV-2026-0042.pdf" && r.attachments[0].content === PDF.toString("base64"));
    await elasticProvider.send(documentMessage, { ...config, key: "elastic" });
    const e = bodies.at(-1) as { Recipients: { To: string[]; BCC: string[] }; Content: { ReplyTo: string; Attachments: { Name: string; BinaryContent: string }[] } };
    ok("Elastic Email: the same", e.Recipients.To.length === 2 && e.Recipients.BCC[0] === "priya.zz@example.com" && e.Content.ReplyTo === "priya.zz@example.com" && e.Content.Attachments?.[0]?.Name === "Tax-invoice-INV-2026-0042.pdf");
  } finally {
    globalThis.fetch = realFetch;
  }

  section("Through Deskzo's mail");

  ok("the platform has a mail type for workspace documents", catalogue.MAIL_STREAMS.some((s) => s.key === "DOCUMENTS"));
  const platform: import("../src/lib/platform/mailer").PlatformMail[] = [];
  mailer.setTestPlatformMailer(async (m) => {
    platform.push(m);
  });
  try {
    const sent = await route.sendDocumentMail("DESKZO", {
      senderUserId: "zz",
      senderName: "Priya Sharma",
      senderEmail: "priya.zz@example.com",
      companyName: "Acme Traders",
      to: [
        { name: "Zz Buyer", email: "buyer.zz@example.com" },
        { name: null, email: "accounts.zz@example.com" },
      ],
      subject: "Tax invoice INV/2026/0042",
      html: "<p>x</p>",
      text: "x",
      attachment: documentMessage.attachments[0]!,
    });
    const m = platform.at(-1);
    ok("it goes as a workspace document", sent.ok && sent.via === "DESKZO" && m?.type === "DOCUMENTS");
    ok("  to every recipient, a copy to the sender, replies to the sender", m?.to === "buyer.zz@example.com" && m.moreTo?.join() === "accounts.zz@example.com" && m.bcc?.join() === "priya.zz@example.com" && m.replyTo === "priya.zz@example.com");
    ok("  in the sender's and the company's name, via Deskzo", m?.fromName === "Priya Sharma (Acme Traders) via Deskzo");
    ok("  with the PDF and its HTML", m?.attachments?.[0]?.filename === "Tax-invoice-INV-2026-0042.pdf" && m.html === "<p>x</p>");
    ok("  and the platform's log doesn't keep the customer's document number", m?.logSubject === "A workspace's document");
  } finally {
    mailer.setTestPlatformMailer(null);
  }

  section("The company's mail server, end to end");

  const existing = await db.messagingProvider.findUnique({ where: { key: "smtp" } });
  if (existing) {
    console.log("  (skipped: this workspace has its own SMTP provider, which the check won't touch)");
  } else {
    const server = await fakeSmtp();
    try {
      await db.messagingProvider.create({
        data: {
          key: "smtp",
          kind: "EMAIL",
          label: "Zz SMTP",
          enabled: true,
          priority: -1000,
          classes: ["TRANSACTIONAL"],
          fromName: "Acme Accounts",
          fromEmail: "accounts@acme.zz",
          config: { host: "127.0.0.1", port: String(server.port), user: "accounts@acme.zz" },
          secretCipher: await encryptSecret("zz-password"),
        },
      });
      const { emailRouteFor } = require("../src/lib/marketing/pipeline") as typeof import("../src/lib/marketing/pipeline");
      ok("with a mail server set up, the company's route is known", (await emailRouteFor("TRANSACTIONAL"))?.fromEmail === "accounts@acme.zz");
      const sent = await route.sendDocumentMail("COMPANY", {
        senderUserId: "zz",
        senderName: "Priya Sharma",
        senderEmail: "priya.zz@example.com",
        companyName: "Acme Traders",
        to: [{ name: "Zz Buyer", email: "buyer.zz@example.com" }],
        subject: "Tax invoice INV/2026/0042",
        html: "<p>x</p>",
        text: "x",
        attachment: documentMessage.attachments[0]!,
      });
      const wire = server.mails.at(-1);
      ok("it goes through it, from its address", sent.ok && sent.via === "COMPANY" && sent.from === "accounts@acme.zz", sent.ok ? sent.from : sent.error);
      ok("  to the customer, with a copy to the sender and the PDF", !!wire && wire.rcpt.includes("buyer.zz@example.com") && wire.rcpt.includes("priya.zz@example.com") && wire.data.includes("Tax-invoice-INV-2026-0042.pdf"));
    } finally {
      await db.messagingProvider.deleteMany({ where: { key: "smtp", label: "Zz SMTP" } });
      server.close();
    }
  }

  section("Who chooses");

  const before = await db.documentMailSettings.findUnique({ where: { id: "global" } });
  const admin = await db.user.create({ data: { name: "Zzprobe Routes", email: `routes${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
  try {
    actorId = admin.id;
    ok("without \"Change the workspace's settings\", the choice can't be changed", !(await actions.saveDocumentSendMode("COMPANY")).ok);
    await db.userPermission.create({ data: { userId: admin.id, permission: "settings.manage", allowed: true, reason: "ZZPROBE" } });
    ok("with it, it can", (await actions.saveDocumentSendMode("COMPANY")).ok && (await route.documentSendMode()) === "COMPANY");
    ok("  but only to one of the three", !(await actions.saveDocumentSendMode("DESKZO")).ok);
  } finally {
    actorId = "";
    await db.auditLog.deleteMany({ where: { userId: admin.id } });
    await db.userPermission.deleteMany({ where: { userId: admin.id } });
    await db.user.delete({ where: { id: admin.id } });
    if (before) await db.documentMailSettings.update({ where: { id: "global" }, data: { sendFrom: before.sendFrom, updatedById: before.updatedById } });
    else await db.documentMailSettings.deleteMany({ where: { id: "global" } });
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll document mail route checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
