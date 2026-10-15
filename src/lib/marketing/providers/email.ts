import nodemailer from "nodemailer";
import {
  allRecipients,
  asError,
  fromHeader,
  replyToFor,
  networkFailure,
  requireSecret,
  retryableStatus,
  standardHeaders,
  textFallback,
  type MessageProvider,
  type OutboundMessage,
  type ProviderConfig,
  type SendResult,
} from "@/lib/marketing/providers/types";

/**
 * The email backends.
 *
 * Resend and Elastic Email speak HTTP, so they need no dependency at all. Amazon SES, Microsoft 365
 * and any other mail server go over SMTP — SES has an HTTP API too, but it wants SigV4 request
 * signing, and its SMTP interface reaches the same servers with none of that.
 *
 * Which one carries what is not decided here; see `routeFor` in ./index.ts. The short version is
 * that bulk should not leave the domain your invoices leave from.
 */

// ─── Resend ───────────────────────────────────────────────────────────────────

export const resendProvider: MessageProvider = {
  key: "resend",
  label: "Resend",
  kind: "EMAIL",
  needs: [
    { key: "apiKey", label: "API key", hint: "From resend.com → API Keys. Starts with re_", secret: true },
  ],
  async send(message, config) {
    const key = requireSecret(config);
    if (!key) return { ok: false, retryable: false, error: "No Resend API key saved." };

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromHeader(config, message),
          to: allRecipients(message).map((r) => r.email),
          ...(message.cc?.length ? { cc: message.cc } : {}),
          ...(message.bcc?.length ? { bcc: message.bcc } : {}),
          reply_to: replyToFor(message, config),
          subject: message.subject,
          html: message.html,
          text: textFallback(message),
          headers: standardHeaders(message),
          ...(message.attachments?.length
            ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), content_type: a.contentType })) }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!response.ok) {
        return {
          ok: false,
          retryable: retryableStatus(response.status),
          error: body.message ?? `Resend returned ${response.status}.`,
        };
      }
      return { ok: true, providerMessageId: body.id ?? null };
    } catch (err) {
      return networkFailure(err);
    }
  },
  async verify(config) {
    const key = requireSecret(config);
    if (!key) return { ok: false, detail: "No API key saved." };
    try {
      const response = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: "Resend rejected the API key." };
      }
      if (!response.ok) return { ok: false, detail: `Resend returned ${response.status}.` };
      return { ok: true, detail: "The API key works." };
    } catch (err) {
      return { ok: false, detail: `Could not reach Resend: ${asError(err)}` };
    }
  },
};

// ─── Elastic Email ────────────────────────────────────────────────────────────

export const elasticProvider: MessageProvider = {
  key: "elastic",
  label: "Elastic Email",
  kind: "EMAIL",
  needs: [{ key: "apiKey", label: "API key", hint: "Settings → API in Elastic Email", secret: true }],
  async send(message, config) {
    const key = requireSecret(config);
    if (!key) return { ok: false, retryable: false, error: "No Elastic Email API key saved." };

    try {
      const response = await fetch("https://api.elasticemail.com/v4/emails/transactional", {
        method: "POST",
        headers: { "X-ElasticEmail-ApiKey": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          Recipients: { To: allRecipients(message).map((r) => r.email), ...(message.cc?.length ? { CC: message.cc } : {}), ...(message.bcc?.length ? { BCC: message.bcc } : {}) },
          Content: {
            From: fromHeader(config, message),
            ReplyTo: replyToFor(message, config),
            ...(message.attachments?.length
              ? { Attachments: message.attachments.map((a) => ({ BinaryContent: a.content.toString("base64"), Name: a.filename, ContentType: a.contentType })) }
              : {}),
            Subject: message.subject,
            Body: [
              { ContentType: "HTML", Content: message.html },
              { ContentType: "PlainText", Content: textFallback(message) },
            ],
            Headers: standardHeaders(message),
          },
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { MessageID?: string; Error?: string };
      if (!response.ok) {
        return {
          ok: false,
          retryable: retryableStatus(response.status),
          error: body.Error ?? `Elastic Email returned ${response.status}.`,
        };
      }
      return { ok: true, providerMessageId: body.MessageID ?? null };
    } catch (err) {
      return networkFailure(err);
    }
  },
  async verify(config) {
    const key = requireSecret(config);
    if (!key) return { ok: false, detail: "No API key saved." };
    try {
      const response = await fetch("https://api.elasticemail.com/v4/account/load", {
        headers: { "X-ElasticEmail-ApiKey": key },
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: "Elastic Email rejected the API key." };
      }
      if (!response.ok) return { ok: false, detail: `Elastic Email returned ${response.status}.` };
      return { ok: true, detail: "The API key works." };
    } catch (err) {
      return { ok: false, detail: `Could not reach Elastic Email: ${asError(err)}` };
    }
  },
};

// ─── SMTP, shared by Amazon SES, Microsoft 365 and any other server ───────────

type SmtpSettings = { host: string; port: number; user: string };

function smtpSettings(config: ProviderConfig, fallbackHost: string, fallbackPort: number): SmtpSettings | null {
  const raw = config.config ?? {};
  // A field cleared in the settings screen is saved as "", which means "the usual", not port 0.
  // A host pasted as "smtps://mail.example.com:465" is taken apart rather than looked up whole.
  const typed = String(raw.host ?? "").trim().replace(/^smtps?:\/\//i, "").replace(/\/.*$/, "");
  const [typedHost, typedPort] = typed.split(":");
  const host = typedHost || fallbackHost;
  const portField = String(raw.port ?? "").trim() || typedPort || "";
  const port = portField ? Number(portField) : fallbackPort;
  const user = String(raw.user ?? "").trim();
  if (!host || !user || !Number.isInteger(port) || port <= 0) return null;
  return { host, port, user };
}

/**
 * SMTP is a conversation, not a request, so a failure can land anywhere in it. Nodemailer surfaces
 * the server's reply code — 4xx means "try later" by the protocol's own definition, and 5xx means
 * the server has made up its mind.
 */
function smtpRetryable(err: unknown): boolean {
  const code = (err as { responseCode?: number })?.responseCode;
  if (typeof code === "number") return code >= 400 && code < 500;
  // A socket that never connected has told us nothing, so trying again is safe.
  return true;
}

function smtpTransport(settings: SmtpSettings, password: string) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    // 587 is STARTTLS, 465 is implicit TLS. Getting this backwards fails with a timeout that
    // looks like a firewall problem and is not.
    secure: settings.port === 465,
    auth: { user: settings.user, pass: password },
    // Nodemailer's own default is two minutes of silence before it says anything.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

/**
 * Why it failed, with the likely way out. "Connection timeout" alone sends people to check the
 * password, when nothing ever got as far as asking for one.
 */
function smtpFailure(err: unknown, settings: SmtpSettings): string {
  const said = asError(err);
  const code = (err as { code?: string })?.code ?? "";
  const where = `${settings.host}:${settings.port}`;
  if (/greeting never received/i.test(said)) {
    return settings.port === 465
      ? `${where} answered, but not with TLS — try port 587.`
      : `${where} answered, but said nothing — if it wants TLS from the start, use port 465.`;
  }
  if (code === "ETIMEDOUT" || /timeout|timed out/i.test(said)) {
    return `Couldn't reach ${where} — the connection timed out. Check the host and port${
      settings.port === 25 ? "; port 25 is blocked by most cloud hosts, so use 587 or 465" : " (587 or 465)"
    }, and that the mail server doesn't only accept connections from certain IP addresses.`;
  }
  if (code === "EDNS" || /ENOTFOUND|EAI_AGAIN/.test(said)) return `There is no server called ${settings.host} — check the host.`;
  if (/ECONNREFUSED/.test(said) || code === "ECONNECTION") return `${where} refused the connection — check the port. (${said})`;
  if (code === "EAUTH") return `${settings.host} turned down the username or password. (${said})`;
  return said;
}

async function smtpSend(
  message: OutboundMessage,
  config: ProviderConfig,
  settings: SmtpSettings,
): Promise<SendResult> {
  const password = requireSecret(config);
  if (!password) return { ok: false, retryable: false, error: "No SMTP password saved." };

  try {
    const info = await smtpTransport(settings, password).sendMail({
      from: fromHeader(config, message),
      to: allRecipients(message).map((r) => (r.name ? { name: r.name, address: r.email } : r.email)),
      ...(message.cc?.length ? { cc: message.cc } : {}),
      ...(message.bcc?.length ? { bcc: message.bcc } : {}),
      replyTo: replyToFor(message, config),
      subject: message.subject,
      html: message.html,
      text: textFallback(message),
      headers: standardHeaders(message),
      ...(message.attachments?.length
        ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) }
        : {}),
    });
    return { ok: true, providerMessageId: info.messageId ?? null };
  } catch (err) {
    return { ok: false, retryable: smtpRetryable(err), error: smtpFailure(err, settings) };
  }
}

async function smtpVerify(config: ProviderConfig, settings: SmtpSettings | null) {
  if (!settings) return { ok: false, detail: "Host, port and username are all needed." };
  const password = requireSecret(config);
  if (!password) return { ok: false, detail: "No password saved." };
  try {
    await smtpTransport(settings, password).verify();
    return { ok: true, detail: `${settings.host} accepted the credentials.` };
  } catch (err) {
    return { ok: false, detail: smtpFailure(err, settings) };
  }
}

export const sesProvider: MessageProvider = {
  key: "ses",
  label: "Amazon SES",
  kind: "EMAIL",
  needs: [
    { key: "host", label: "SMTP endpoint", hint: "e.g. email-smtp.ap-south-1.amazonaws.com" },
    { key: "port", label: "Port", hint: "587 for STARTTLS" },
    { key: "user", label: "SMTP username", hint: "The SES SMTP credential, not your AWS access key" },
    { key: "password", label: "SMTP password", secret: true },
  ],
  async send(message, config) {
    const settings = smtpSettings(config, "email-smtp.ap-south-1.amazonaws.com", 587);
    if (!settings) return { ok: false, retryable: false, error: "SES SMTP settings are incomplete." };
    return smtpSend(message, config, settings);
  },
  verify: (config) => smtpVerify(config, smtpSettings(config, "email-smtp.ap-south-1.amazonaws.com", 587)),
};

export const microsoft365Provider: MessageProvider = {
  key: "m365",
  label: "Microsoft 365 (SMTP)",
  kind: "EMAIL",
  needs: [
    { key: "host", label: "SMTP host", hint: "smtp.office365.com" },
    { key: "port", label: "Port", hint: "587" },
    { key: "user", label: "Mailbox", hint: "The account mail is sent as" },
    { key: "password", label: "App password", hint: "An app password, not the account password", secret: true },
  ],
  async send(message, config) {
    const settings = smtpSettings(config, "smtp.office365.com", 587);
    if (!settings) return { ok: false, retryable: false, error: "Microsoft 365 SMTP settings are incomplete." };
    return smtpSend(message, config, settings);
  },
  verify: (config) => smtpVerify(config, smtpSettings(config, "smtp.office365.com", 587)),
};

/**
 * Any server that takes an SMTP login — Google Workspace, Zoho Mail, a hosting company's, your own.
 * Nothing to fall back on for the host: it is whatever the provider's SMTP settings say.
 */
export const smtpProvider: MessageProvider = {
  key: "smtp",
  label: "Other SMTP server",
  kind: "EMAIL",
  needs: [
    { key: "host", label: "SMTP host", hint: "e.g. smtp.gmail.com or smtp.zoho.in" },
    { key: "port", label: "Port", hint: "587 for STARTTLS, 465 for TLS from the start" },
    { key: "user", label: "Username", hint: "Usually the full address of the mailbox" },
    { key: "password", label: "Password", hint: "An app password where the provider has them", secret: true },
  ],
  async send(message, config) {
    const settings = smtpSettings(config, "", 587);
    if (!settings) return { ok: false, retryable: false, error: "SMTP settings are incomplete — a host and a username are needed." };
    return smtpSend(message, config, settings);
  },
  verify: (config) => smtpVerify(config, smtpSettings(config, "", 587)),
};

// ─── Mock ─────────────────────────────────────────────────────────────────────

/**
 * Records instead of sending.
 *
 * Not only for tests: it is the honest state of a system whose provider is not configured yet, and
 * it lets the whole pipeline — suppression, scheduling, merge, tracking — be exercised end to end
 * before anybody's reputation is on the line.
 */
export const mockProvider: MessageProvider = {
  key: "mock",
  label: "Mock (records, sends nothing)",
  kind: "EMAIL",
  needs: [],
  async send(message) {
    const files = message.attachments?.length ? ` with ${message.attachments.map((a) => a.filename).join(", ")}` : "";
    console.log(`[mock] would send "${message.subject}" to ${allRecipients(message).map((r) => r.email).join(", ")}${files}`);
    return { ok: true, providerMessageId: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 10)}` };
  },
  async verify() {
    return { ok: true, detail: "Records every send and delivers nothing." };
  },
};

export const EMAIL_PROVIDERS: MessageProvider[] = [
  resendProvider,
  sesProvider,
  elasticProvider,
  microsoft365Provider,
  smtpProvider,
  mockProvider,
];
