import nodemailer from "nodemailer";
import {
  asError,
  fromHeader,
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
 * The four email backends.
 *
 * Resend and Elastic Email speak HTTP, so they need no dependency at all. Amazon SES and Microsoft
 * 365 go over SMTP — SES has an HTTP API too, but it wants SigV4 request signing, and its SMTP
 * interface reaches the same servers with none of that.
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
          from: fromHeader(config),
          to: [message.to],
          reply_to: config.replyTo ?? undefined,
          subject: message.subject,
          html: message.html,
          text: textFallback(message),
          headers: standardHeaders(message),
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
          Recipients: { To: [message.to] },
          Content: {
            From: fromHeader(config),
            ReplyTo: config.replyTo ?? undefined,
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

// ─── SMTP, shared by Amazon SES and Microsoft 365 ─────────────────────────────

type SmtpSettings = { host: string; port: number; user: string };

function smtpSettings(config: ProviderConfig, fallbackHost: string, fallbackPort: number): SmtpSettings | null {
  const raw = config.config ?? {};
  const host = String(raw.host ?? fallbackHost).trim();
  const port = Number(raw.port ?? fallbackPort);
  const user = String(raw.user ?? "").trim();
  if (!host || !user || !Number.isFinite(port)) return null;
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

async function smtpSend(
  message: OutboundMessage,
  config: ProviderConfig,
  settings: SmtpSettings,
): Promise<SendResult> {
  const password = requireSecret(config);
  if (!password) return { ok: false, retryable: false, error: "No SMTP password saved." };

  try {
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      // 587 is STARTTLS, 465 is implicit TLS. Getting this backwards fails with a timeout that
      // looks like a firewall problem and is not.
      secure: settings.port === 465,
      auth: { user: settings.user, pass: password },
    });
    const info = await transport.sendMail({
      from: fromHeader(config),
      to: message.toName ? `${message.toName} <${message.to}>` : message.to,
      replyTo: config.replyTo ?? undefined,
      subject: message.subject,
      html: message.html,
      text: textFallback(message),
      headers: standardHeaders(message),
    });
    return { ok: true, providerMessageId: info.messageId ?? null };
  } catch (err) {
    return { ok: false, retryable: smtpRetryable(err), error: asError(err) };
  }
}

async function smtpVerify(config: ProviderConfig, settings: SmtpSettings | null) {
  if (!settings) return { ok: false, detail: "Host, port and username are all needed." };
  const password = requireSecret(config);
  if (!password) return { ok: false, detail: "No password saved." };
  try {
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 465,
      auth: { user: settings.user, pass: password },
    });
    await transport.verify();
    return { ok: true, detail: `${settings.host} accepted the credentials.` };
  } catch (err) {
    return { ok: false, detail: asError(err) };
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
    console.log(`[mock] would send "${message.subject}" to ${message.to}`);
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
  mockProvider,
];
