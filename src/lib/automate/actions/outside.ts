import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { STILL_THERE } from "@/lib/contacts/left";
import { workplaceAccess } from "@/lib/mail/mailbox";
import { googleSheetsBase, grantsGoogleSheets } from "@/lib/mail/google";
import { deliverNow, marketingSettings, resolveRecipients } from "@/lib/marketing/pipeline";
import { ActionError, defineAction, type ActionContext } from "@/lib/automate/action-types";
import { priorOutput, withOutsideEffect, type OutsideOutcome } from "@/lib/automate/effects";
import { connectionFor, noteConnectionUse } from "@/lib/automate/connections";
import { answerBody, failureOf, outboundFetch, statusKind, type OutboundRequest } from "@/lib/automate/outbound";
import { reach } from "@/lib/automate/actions/shared";

/**
 * Deskzo Automate's outside actions (Phase 4): an HTTP API or webhook, Slack, Teams, a WhatsApp
 * template, a Google Sheets row. Every call goes through the outbound guard (src/lib/automate/outbound.ts)
 * and is made at most once: a call that changes something is marked before it goes, and one cut off
 * with no answer waits for a person rather than being sent again (src/lib/automate/effects.ts). Each
 * carries the step's Idempotency-Key, the same on every try, for receivers that can use it.
 */

const optionalId = z.string().trim().min(1, "Choose one, or leave it empty.").max(60).optional();
const headerValue = z.string().max(2000).refine((v) => !/[\r\n]/.test(v), "A header's value is one line.");

/** One call that changes something, at most once: its outcome as the outside-effect record wants it. */
async function callOnce<T>(ctx: ActionContext, request: OutboundRequest, done: (body: unknown, status: number) => T): Promise<OutsideOutcome<T>> {
  let response;
  try {
    response = await outboundFetch(ctx, request);
  } catch (err) {
    const failure = failureOf(err, true);
    // Unknown whether it went: thrown as it came, so the step's mark stays and a person decides —
    // withOutsideEffect says so in the step's error.
    if (failure.kind === "UNKNOWN") throw err;
    return { ok: false, error: failure.message, kind: failure.kind };
  }
  const kind = statusKind(response.status);
  if (kind !== "ok") return { ok: false, error: `It answered ${response.status}: ${response.body.slice(0, 200) || "no reason given"}`, kind };
  return { ok: true, output: done(answerBody(response), response.status) };
}

// ─── An HTTP API or webhook ──────────────────────────────────────────────────────────────────────

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const httpInput = z
  .object({
    /** A saved outside API (its base address and headers), or a full address here. */
    connectionId: optionalId,
    url: z.string().trim().max(2000).optional(),
    /** Added to the connection's base address: "/v1/orders". */
    path: z.string().trim().max(1000).optional(),
    method: z.enum(METHODS).default("POST"),
    headers: z
      .record(z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, "A header's name is letters, digits and hyphens."), headerValue)
      .refine((h) => Object.keys(h).length <= 20, "At most 20 headers.")
      .optional(),
    /** Sent as JSON when it is data; as it is when it is text. */
    body: z.unknown().optional(),
    /** Signed with the workspace's secret (X-Deskzo-Timestamp, X-Deskzo-Signature). */
    sign: z.boolean().default(true),
  })
  .strict()
  .refine((i) => !!i.connectionId !== !!i.url, { message: "Choose a saved outside API, or give an address — one of the two.", path: ["url"] });

export const httpRequest = defineAction({
  key: "http.request",
  label: "Call a webhook or API",
  description: "Sends a request to an outside address — signed, with the step's idempotency key — and hands its answer to the steps after.",
  module: "automate",
  permission: null,
  risk: "irreversible",
  input: httpInput,
  outputs: ["status", "ok", "body"],
  preview: (i) => `Would ${i.method} ${i.url ?? `the saved API${i.path ? ` ${i.path}` : ""}`}.`,
  async run(ctx, i) {
    const done = await priorOutput<{ status: number; ok: boolean; body: unknown }>(ctx);
    if (done) return done.output;

    let url = i.url ?? "";
    let headers: Record<string, string> = { ...(i.headers ?? {}) };
    let connectionId: string | null = null;
    if (i.connectionId) {
      const connection = await connectionFor(ctx.actorId, i.connectionId, "http");
      connectionId = connection.id;
      url = `${connection.secret.url.replace(/\/+$/, "")}${i.path ? `/${i.path.replace(/^\/+/, "")}` : ""}`;
      headers = { ...connection.secret.headers, ...headers };
    }
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    let body: string | undefined;
    if (i.method !== "GET" && i.body !== undefined) {
      body = typeof i.body === "string" ? i.body : JSON.stringify(i.body);
      if (typeof i.body !== "string" && !lower["content-type"]) lower["content-type"] = "application/json";
    }
    const request: OutboundRequest = { method: i.method, url, headers: lower, body, sign: i.sign };
    const finish = (b: unknown, status: number) => ({ status, ok: true, body: b });

    // Reading changes nothing: tried again as often as it takes, no mark needed.
    if (i.method === "GET") {
      let response;
      try {
        response = await outboundFetch(ctx, request);
      } catch (err) {
        if (connectionId) await noteConnectionUse(connectionId, err instanceof Error ? err.message : String(err));
        throw failureOf(err, false);
      }
      const kind = statusKind(response.status);
      if (connectionId) await noteConnectionUse(connectionId, kind === "ok" ? null : `${response.status}`);
      if (kind !== "ok") throw new ActionError(`It answered ${response.status}: ${response.body.slice(0, 200) || "no reason given"}`, kind);
      return finish(answerBody(response), response.status);
    }
    try {
      const { output } = await withOutsideEffect(ctx, () => callOnce(ctx, request, finish));
      if (connectionId) await noteConnectionUse(connectionId, null);
      return output;
    } catch (err) {
      if (connectionId) await noteConnectionUse(connectionId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  },
});

// ─── Slack and Teams ─────────────────────────────────────────────────────────────────────────────

const chatInput = z
  .object({
    connectionId: z.string().trim().min(1, "Choose where to post it.").max(60),
    title: z.string().trim().max(200).optional(),
    text: z.string().trim().min(1, "Write the message.").max(3000),
  })
  .strict();

async function postTo(ctx: ActionContext, provider: "slack" | "teams", i: z.infer<typeof chatInput>) {
  const done = await priorOutput<{ posted: true; to: string }>(ctx);
  if (done) return done.output;
  const connection = await connectionFor(ctx.actorId, i.connectionId, provider);
  const payload =
    provider === "slack"
      ? { text: i.title ? `*${i.title}*\n${i.text}` : i.text }
      : {
          // An Adaptive Card, as the Teams Workflows webhook takes it.
          type: "message",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: {
                $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                type: "AdaptiveCard",
                version: "1.4",
                body: [...(i.title ? [{ type: "TextBlock", text: i.title, weight: "Bolder", size: "Medium", wrap: true }] : []), { type: "TextBlock", text: i.text, wrap: true }],
              },
            },
          ],
        };
  try {
    const { output } = await withOutsideEffect(ctx, () =>
      callOnce(ctx, { method: "POST", url: connection.secret.url, headers: { "content-type": "application/json" }, body: JSON.stringify(payload), sign: false }, () => ({ posted: true as const, to: connection.name })),
    );
    await noteConnectionUse(connection.id, null);
    return output;
  } catch (err) {
    await noteConnectionUse(connection.id, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export const slackPost = defineAction({
  key: "slack.post",
  label: "Post to Slack",
  description: "Posts a message to a Slack channel through a saved incoming webhook.",
  module: "automate",
  permission: null,
  risk: "irreversible",
  input: chatInput,
  outputs: ["posted", "to"],
  preview: (i) => `Would post to Slack: "${i.text.slice(0, 80)}".`,
  run: (ctx, i) => postTo(ctx, "slack", i),
});

export const teamsPost = defineAction({
  key: "teams.post",
  label: "Post to Microsoft Teams",
  description: "Posts a card to a Teams channel through a saved Workflows webhook.",
  module: "automate",
  permission: null,
  risk: "irreversible",
  input: chatInput,
  outputs: ["posted", "to"],
  preview: (i) => `Would post to Teams: "${(i.title ?? i.text).slice(0, 80)}".`,
  run: (ctx, i) => postTo(ctx, "teams", i),
});

// ─── A WhatsApp template ─────────────────────────────────────────────────────────────────────────

const whatsappInput = z
  .object({
    to: z.enum(["lead_contact", "contact", "company_contact"]).default("lead_contact"),
    leadId: optionalId,
    contactId: optionalId,
    companyId: optionalId,
    /** The approved template's name, as Meta has it. */
    template: z.string().trim().min(1, "Name the approved template.").max(512).regex(/^[a-z0-9_]+$/, "A template's name is lower-case letters, digits and underscores."),
    /** Its {{1}}, {{2}}…, in order. */
    parameters: z.array(z.string().max(1000)).max(10).default([]),
  })
  .strict()
  .superRefine((i, issue) => {
    if (i.to === "lead_contact" && !i.leadId) issue.addIssue({ code: "custom", path: ["leadId"], message: "Say which lead." });
    if (i.to === "contact" && !i.contactId) issue.addIssue({ code: "custom", path: ["contactId"], message: "Say which contact." });
    if (i.to === "company_contact" && !i.companyId) issue.addIssue({ code: "custom", path: ["companyId"], message: "Say which customer." });
  });

export const whatsappSend = defineAction({
  key: "whatsapp.send",
  label: "Send a WhatsApp template",
  description: "Sends an approved WhatsApp template to a lead's contact, a contact or a customer's main contact.",
  module: "marketing",
  permission: null,
  risk: "irreversible",
  input: whatsappInput,
  outputs: ["sent", "contactId", "provider"],
  preview: (i) => `Would send the WhatsApp template "${i.template}".`,
  async run(ctx, i) {
    const done = await priorOutput<{ sent: true; contactId: string; provider: string }>(ctx);
    if (done) return done.output;
    // The provider reads the values one a line and skips blank ones, so a blank value or a line break in
    // one would move every value after it into the wrong place in the template.
    const parameters = i.parameters.map((p) => p.replace(/\s*[\r\n]+\s*/g, " ").trim());
    const blank = parameters.findIndex((p) => !p);
    if (blank >= 0) throw new ActionError(`The template's value {{${blank + 1}}} came out empty, so it wasn't sent.`, "PERMANENT");
    let contactId = i.contactId ?? null;
    if (i.to === "lead_contact") {
      await reach(ctx, "leads", "view", i.leadId!, "lead");
      contactId = (await db.lead.findUnique({ where: { id: i.leadId! }, select: { contactId: true } }))?.contactId ?? null;
      if (!contactId) throw new ActionError("The lead has no contact to message.", "PERMANENT");
    } else if (i.to === "company_contact") {
      await reach(ctx, "companies", "view", i.companyId!, "customer");
      contactId = (await db.contact.findFirst({ where: { companyId: i.companyId!, phone: { not: null }, ...STILL_THERE }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], select: { id: true } }))?.id ?? null;
      if (!contactId) throw new ActionError("The customer has nobody with a phone number to message.", "PERMANENT");
    } else {
      await reach(ctx, "contacts", "view", contactId!, "contact");
    }
    if (!(await can(ctx.actorId, "contacts.view"))) throw new ActionError("The workflow's owner can't see contacts' details, so can't message one.", "PERMANENT");
    // The rules every transactional message keeps: still there, reachable, never a reseller's customer.
    const [resolved] = await resolveRecipients({ contactIds: [contactId!], channel: "WHATSAPP", topic: "SERVICE", messageClass: "TRANSACTIONAL", settings: await marketingSettings() });
    if (!resolved) throw new ActionError("The contact has left their company, so wasn't messaged.", "PERMANENT");
    if (!resolved.verdict.ok) throw new ActionError(`${resolved.recipient.name} can't be messaged: ${resolved.verdict.detail}`, "PERMANENT");
    const r = resolved.recipient;

    const { output, fresh } = await withOutsideEffect(ctx, async () => {
      // The provider takes the template's name as the subject and its parameters one a line.
      const sent = await deliverNow({ to: r.phone!, toName: r.name, subject: i.template, html: parameters.join("\n") }, "TRANSACTIONAL", { delivering: true, kind: "WHATSAPP" });
      if (!sent.ok) return { ok: false, error: `WhatsApp didn't take it: ${sent.error}`, kind: /No WhatsApp provider|not configured/i.test(sent.error) ? "PERMANENT" : "TRANSIENT" };
      return { ok: true, output: { sent: true as const, contactId: r.contactId, provider: sent.provider } };
    });
    if (fresh) {
      const now = new Date();
      await db.marketingMessage.create({
        data: {
          token: randomBytes(24).toString("base64url"),
          companyId: r.companyId,
          contactId: r.contactId,
          channel: "WHATSAPP",
          messageClass: "TRANSACTIONAL",
          subject: i.template,
          body: parameters.join("\n"),
          toPhone: r.phone,
          status: "SENT",
          scheduledFor: now,
          sentAt: now,
          attempts: 1,
          sentByUserId: ctx.actorId,
        },
      });
    }
    return output;
  },
});

// ─── A Google Sheets row ─────────────────────────────────────────────────────────────────────────

const sheetsInput = z
  .object({
    /** The spreadsheet's address, or its id. */
    spreadsheet: z.string().trim().min(1, "Say which spreadsheet.").max(500),
    /** The tab, by name. The first one when not given. */
    sheet: z.string().trim().max(100).optional(),
    values: z.array(z.unknown()).min(1, "Give the row's values.").max(50),
  })
  .strict();

/** The id in a spreadsheet's address, or the id itself. */
export function spreadsheetId(given: string): string | null {
  const fromUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(given);
  if (fromUrl) return fromUrl[1]!;
  return /^[A-Za-z0-9_-]{20,}$/.test(given) ? given : null;
}

export const sheetsAppend = defineAction({
  key: "sheets.append",
  label: "Add a Google Sheets row",
  description: "Adds a row to a Google Sheet, as the workflow's owner — who connects Google Sheets once, under Automate › Connections.",
  module: "automate",
  permission: null,
  risk: "irreversible",
  input: sheetsInput,
  outputs: ["range", "rows"],
  preview: (i) => `Would add a row of ${i.values.length} value${i.values.length === 1 ? "" : "s"} to the spreadsheet.`,
  async run(ctx, i) {
    const done = await priorOutput<{ range: string; rows: number }>(ctx);
    if (done) return done.output;
    const id = spreadsheetId(i.spreadsheet);
    if (!id) throw new ActionError("That isn't a Google spreadsheet's address.", "PERMANENT");
    const connection = await db.mailConnection.findUnique({ where: { userId: ctx.actorId }, select: { provider: true, scopes: true } });
    if (connection?.provider !== "GOOGLE" || !grantsGoogleSheets(connection.scopes)) {
      throw new ActionError("The workflow's owner hasn't connected Google Sheets — Automate › Connections, under Google Sheets.", "PERMANENT");
    }
    const access = await workplaceAccess(ctx.actorId);
    if (!access.ok) throw new ActionError(access.error, access.reconnect ? "PERMANENT" : "TRANSIENT");
    const range = encodeURIComponent(i.sheet ? `'${i.sheet.replace(/'/g, "''")}'!A1` : "A1");
    const url = `${googleSheetsBase()}/v4/spreadsheets/${id}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    // Text that Sheets would read as a formula (=, +, -, @ first) goes in as the text it is: a lead's name
    // or a ticket's subject from outside must never become =IMPORTXML(…) in the owner's sheet.
    const values = i.values.map((v) => {
      const value = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v;
      return typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    });
    const { output } = await withOutsideEffect(ctx, () =>
      callOnce(ctx, { method: "POST", url, headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" }, body: JSON.stringify({ values: [values] }), sign: false }, (body) => ({
        range: String((body as { updates?: { updatedRange?: string } } | null)?.updates?.updatedRange ?? ""),
        rows: 1,
      })),
    );
    return output;
  },
});
