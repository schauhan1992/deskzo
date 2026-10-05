import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { MailConnection, MailProvider, MailSecurity, MailStream } from "@deskzo/control-client";
import { redactSecrets } from "@/lib/console-shared/redact";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { openForPlatform, sealForPlatform } from "@/lib/platform/kek";
import { ConsoleRefused } from "@/lib/platform/refused";
import { EMAIL_PATTERN, GUID_PATTERN, HOST_PATTERN, MAIL_PROVIDERS, MAIL_STREAMS, providerDef, type MailStreamKey } from "@/lib/console-shared/mail-catalogue";

/**
 * The platform's mail accounts and which one each type of mail goes through (owner, 5 Oct 2026;
 * console › Settings › Mail). An account's password, API key or client secret is sealed under the
 * platform key ("mail-connection") when saved and opened only to send — no page, action result or
 * log ever carries it. Microsoft 365 signs in as an Entra app (client credentials → an access token
 * for SMTP's XOAUTH2), the only way Exchange Online will keep accepting once passwords are off.
 *
 * Which account a mail uses: its type's, else the default's; with neither, PLATFORM_SMTP_URL as the
 * installation was started with; with none of those, platform-outbox/ (src/lib/platform/mailer.ts).
 * Its From: the type's address, else — when the type borrows the default's account — the default's,
 * else the account's own; the name likewise, with the mail's own name first (a helpdesk replying as
 * "<Company> Support"). Reply-To: the mail's own, else the type's, else the default's.
 */

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

export type ConnectionView = {
  id: string;
  name: string;
  provider: MailProvider;
  host: string;
  port: number;
  security: MailSecurity;
  username: string | null;
  /** Whether a secret is saved — never the secret. */
  hasSecret: boolean;
  msTenantId: string | null;
  msClientId: string | null;
  fromAddress: string;
  fromName: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: Date;
  updatedByName: string | null;
  /** The types that name it (the default included). */
  usedBy: MailStream[];
};

export type RouteView = { stream: MailStream; connectionId: string | null; fromName: string | null; fromAddress: string | null; replyTo: string | null; updatedAt: Date | null; updatedByName: string | null };

export type MailSetup = {
  connections: ConnectionView[];
  /** Every type, in MAIL_STREAMS' order, saved or not. */
  routes: RouteView[];
  /** PLATFORM_SMTP_URL is set: mail with no account goes there rather than to platform-outbox/. */
  serverFallback: boolean;
  /** PLATFORM_MAIL_FROM, or the built-in sender. */
  serverFrom: string;
};

async function staffNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = await controlDb().platformUser.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function mailSetup(): Promise<MailSetup> {
  const db = controlDb();
  const [connections, routes] = await Promise.all([db.mailConnection.findMany({ orderBy: { name: "asc" } }), db.mailRoute.findMany()]);
  const names = await staffNames([...connections.map((c) => c.updatedBy), ...routes.map((r) => r.updatedBy)]);
  return {
    connections: connections.map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      host: c.host,
      port: c.port,
      security: c.security,
      username: c.username,
      hasSecret: !!c.secretCipher,
      msTenantId: c.msTenantId,
      msClientId: c.msClientId,
      fromAddress: c.fromAddress,
      fromName: c.fromName,
      lastTestAt: c.lastTestAt,
      lastTestOk: c.lastTestOk,
      lastTestError: c.lastTestError,
      updatedAt: c.updatedAt,
      updatedByName: names.get(c.updatedBy) ?? null,
      usedBy: routes.filter((r) => r.connectionId === c.id).map((r) => r.stream),
    })),
    routes: MAIL_STREAMS.map((s) => {
      const r = routes.find((x) => x.stream === s.key);
      return {
        stream: s.key,
        connectionId: r?.connectionId ?? null,
        fromName: r?.fromName ?? null,
        fromAddress: r?.fromAddress ?? null,
        replyTo: r?.replyTo ?? null,
        updatedAt: r?.updatedAt ?? null,
        updatedByName: r ? (names.get(r.updatedBy) ?? null) : null,
      };
    }),
    serverFallback: Boolean(process.env.PLATFORM_SMTP_URL?.trim()),
    serverFrom: serverFrom().line,
  };
}

/** Whether platform mail is sent anywhere: an account for the default, or PLATFORM_SMTP_URL. */
export async function mailConfigured(): Promise<boolean> {
  if (process.env.PLATFORM_SMTP_URL?.trim()) return true;
  if (!controlConfigured()) return false;
  // Before the release's migration has made the mail tables, there is no account yet.
  const route = await controlDb()
    .mailRoute.findUnique({ where: { stream: "DEFAULT" }, select: { connectionId: true } })
    .catch(() => null);
  return !!route?.connectionId;
}

// ─── Saving ──────────────────────────────────────────────────────────────────────────────────────

const line = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max + 1) : "");
/** A display name for a header: no quotes, backslashes or angle brackets. */
const displayName = (v: unknown) => line(v, 80).replace(/["\\<>]/g, "").trim();

function address(v: unknown, what: string, required: boolean): string | null {
  const a = line(v, 254);
  if (!a) {
    if (required) throw new ConsoleRefused(`Give ${what}.`);
    return null;
  }
  if (a.length > 254 || !EMAIL_PATTERN.test(a)) throw new ConsoleRefused(`${what[0]!.toUpperCase()}${what.slice(1)} isn't an email address.`);
  return a;
}

export type ConnectionSaved = { id: string; created: boolean; changed: string[]; name: string; provider: MailProvider };

/**
 * Adds an account, or changes one (`id`). Every field is checked before anything is written. A blank
 * secret keeps the saved one; a new account needs one. A preset's server is one of its own (its
 * region); "Other SMTP server" takes any name. `changed` names the fields that moved — "secret" for a
 * new secret, never its value.
 */
export async function saveConnection(input: unknown, staffId: string): Promise<ConnectionSaved> {
  const v = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const db = controlDb();
  const id = typeof v.id === "string" && v.id.trim() ? v.id.trim() : null;
  const current = id ? await db.mailConnection.findUnique({ where: { id } }) : null;
  if (id && !current) throw new ConsoleRefused("That mail account no longer exists.");

  const def = providerDef(String(v.provider ?? ""));
  if (!def) throw new ConsoleRefused("Choose the mail service.");
  const name = line(v.name, 80);
  if (!name) throw new ConsoleRefused("Give the account a name.");
  if (name.length > 80) throw new ConsoleRefused("Keep the name to 80 characters.");

  const host = line(v.host, 253).toLowerCase();
  if (def.servers.length) {
    if (!def.servers.some((s) => s.host === host)) throw new ConsoleRefused(`Choose ${def.label}'s server from the list.`);
  } else if (!HOST_PATTERN.test(host)) {
    throw new ConsoleRefused("Give the server's name only — like smtp.example.com, without https:// or a port.");
  }
  const port = Number(v.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConsoleRefused("The port is a whole number from 1 to 65535.");
  const security = v.security === "TLS" || v.security === "STARTTLS" ? v.security : null;
  if (!security) throw new ConsoleRefused("Choose TLS or STARTTLS.");

  let username = def.username.fixed ?? line(v.username, 254);
  if (!username) throw new ConsoleRefused(`Give the ${def.username.label.toLowerCase()}.`);
  if (username.length > 254 || /\s/.test(username)) throw new ConsoleRefused(`The ${def.username.label.toLowerCase()} has no spaces in it.`);
  let msTenantId: string | null = null;
  let msClientId: string | null = null;
  if (def.signIn === "oauth") {
    username = address(username, "the mailbox to send from", true)!;
    msTenantId = line(v.msTenantId, 253).toLowerCase();
    msClientId = line(v.msClientId, 36).toLowerCase();
    if (!GUID_PATTERN.test(msTenantId) && !HOST_PATTERN.test(msTenantId)) throw new ConsoleRefused("The directory (tenant) ID is a GUID, like 0f3b…-…, or the tenant's domain.");
    if (!GUID_PATTERN.test(msClientId)) throw new ConsoleRefused("The application (client) ID is a GUID, like 7a1c…-….");
  }

  const secretRaw = typeof v.secret === "string" ? v.secret.trim() : "";
  if (secretRaw && (secretRaw.length > 2000 || /[\r\n]/.test(secretRaw))) throw new ConsoleRefused(`That ${def.secret.label.toLowerCase()} can't be right — paste it exactly as the service shows it.`);
  if (!secretRaw && !current?.secretCipher) throw new ConsoleRefused(`Give the ${def.secret.label.toLowerCase()}.`);

  const fromAddress = address(v.fromAddress, "the address to send from", true)!;
  const fromName = displayName(v.fromName) || null;

  const data = {
    name,
    provider: def.key,
    host,
    port,
    security,
    username,
    msTenantId,
    msClientId,
    fromAddress,
    fromName,
    updatedBy: staffId,
    ...(secretRaw ? { secretCipher: sealForPlatform("mail-connection", secretRaw) } : {}),
  } satisfies Partial<MailConnection>;

  if (!current) {
    const made = await db.mailConnection.create({ data: { ...data, secretCipher: sealForPlatform("mail-connection", secretRaw) }, select: { id: true } });
    return { id: made.id, created: true, changed: [], name, provider: def.key };
  }
  const changed: string[] = (["name", "provider", "host", "port", "security", "username", "msTenantId", "msClientId", "fromAddress", "fromName"] as const).filter((k) => current[k] !== data[k]);
  if (secretRaw) changed.push("secret");
  // A changed sign-in is a new account as far as the last test is concerned.
  const signInMoved = changed.some((k) => k !== "name" && k !== "fromName");
  await db.mailConnection.update({ where: { id: current.id }, data: { ...data, ...(signInMoved ? { lastTestAt: null, lastTestOk: null, lastTestError: null } : {}) } });
  forgetToken(current.id);
  return { id: current.id, created: false, changed, name, provider: def.key };
}

/** Removes an account; the types that used it fall back to the default (the foreign key's SET NULL). */
export async function removeConnection(id: unknown): Promise<{ name: string; provider: MailProvider; streams: MailStream[] }> {
  const key = typeof id === "string" ? id.trim() : "";
  const db = controlDb();
  const current = key ? await db.mailConnection.findUnique({ where: { id: key }, include: { routes: { select: { stream: true } } } }) : null;
  if (!current) throw new ConsoleRefused("That mail account no longer exists.");
  await db.mailConnection.delete({ where: { id: current.id } });
  forgetToken(current.id);
  return { name: current.name, provider: current.provider, streams: current.routes.map((r) => r.stream) };
}

export type RouteInput = { stream: MailStreamKey; connectionId: string | null; fromName: string; fromAddress: string; replyTo: string };

/** Saves every type's account, From and Reply-To at once (all checked first). Returns the types that changed. */
export async function saveRoutes(input: unknown, staffId: string): Promise<MailStream[]> {
  const list = Array.isArray(input) ? input : [];
  const db = controlDb();
  const ids = new Set((await db.mailConnection.findMany({ select: { id: true } })).map((c) => c.id));
  const seen = new Set<string>();
  const next: { stream: MailStream; connectionId: string | null; fromName: string | null; fromAddress: string | null; replyTo: string | null }[] = [];
  for (const raw of list) {
    const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const def = MAIL_STREAMS.find((s) => s.key === r.stream);
    if (!def || seen.has(def.key)) throw new ConsoleRefused("Each type of mail is listed once.");
    seen.add(def.key);
    const connectionId = typeof r.connectionId === "string" && r.connectionId ? r.connectionId : null;
    if (connectionId && !ids.has(connectionId)) throw new ConsoleRefused("That mail account no longer exists — reload the page.");
    next.push({
      stream: def.key,
      connectionId,
      fromName: displayName(r.fromName) || null,
      fromAddress: address(r.fromAddress, `${def.label}'s From address`, false),
      replyTo: address(r.replyTo, `${def.label}'s Reply-To address`, false),
    });
  }
  const current = await db.mailRoute.findMany();
  const changed: MailStream[] = [];
  for (const n of next) {
    const c = current.find((x) => x.stream === n.stream);
    const same = c ? c.connectionId === n.connectionId && c.fromName === n.fromName && c.fromAddress === n.fromAddress && c.replyTo === n.replyTo : !n.connectionId && !n.fromName && !n.fromAddress && !n.replyTo;
    if (same) continue;
    changed.push(n.stream);
    await db.mailRoute.upsert({ where: { stream: n.stream }, create: { ...n, updatedBy: staffId }, update: { ...n, updatedBy: staffId } });
  }
  return changed;
}

/** The outcome of a test, kept on the account for the console to show. */
export async function recordTest(connectionId: string, ok: boolean, error: string | null): Promise<void> {
  await controlDb()
    .mailConnection.update({ where: { id: connectionId }, data: { lastTestAt: new Date(), lastTestOk: ok, lastTestError: ok ? null : error } })
    .catch(() => {});
}

// ─── Sending ─────────────────────────────────────────────────────────────────────────────────────

export type MailFrom = { name: string | null; address: string };

/** Where a mail goes, as whom, and what the delivery log calls the way it went. */
export type Resolved =
  | { kind: "connection"; connection: MailConnection; from: MailFrom; replyTo: string | null; via: string }
  | { kind: "server"; url: string; from: MailFrom; replyTo: string | null; via: string }
  | { kind: "outbox"; from: MailFrom; replyTo: string | null; via: string };

export const SERVER_VIA = "Server setting (PLATFORM_SMTP_URL)";
export const OUTBOX_VIA = "platform-outbox/ (no mail account)";

/** PLATFORM_MAIL_FROM, split; or the built-in sender. */
export function serverFrom(): { line: string; from: MailFrom } {
  const configured = process.env.PLATFORM_MAIL_FROM?.trim() || "Deskzo One <no-reply@localhost>";
  const angled = /^(.*)<([^<>]+)>\s*$/.exec(configured);
  const from = angled ? { name: angled[1]!.replace(/"/g, "").trim() || null, address: angled[2]!.trim() } : { name: null, address: configured };
  return { line: configured, from };
}

/**
 * The way a mail of this type goes now. `connectionId` instead: through that account as its own
 * sender — a console test. The control plane unreachable, the server setting (or the outbox) as before
 * accounts existed, so a signup's code still goes out.
 */
export async function resolveMail(stream: MailStreamKey, options: { connectionId?: string } = {}): Promise<Resolved> {
  const fallback = (): Resolved => {
    const url = process.env.PLATFORM_SMTP_URL?.trim();
    const from = serverFrom().from;
    return url ? { kind: "server", url, from, replyTo: null, via: SERVER_VIA } : { kind: "outbox", from, replyTo: null, via: OUTBOX_VIA };
  };
  if (!controlConfigured()) return fallback();
  const db = controlDb();
  if (options.connectionId) {
    const connection = await db.mailConnection.findUnique({ where: { id: options.connectionId } });
    if (!connection) throw new ConsoleRefused("That mail account no longer exists.");
    return { kind: "connection", connection, from: { name: connection.fromName, address: connection.fromAddress }, replyTo: null, via: connection.name };
  }
  let routes;
  try {
    routes = await db.mailRoute.findMany({ where: { stream: { in: stream === "DEFAULT" ? ["DEFAULT"] : [stream, "DEFAULT"] } }, include: { connection: true } });
  } catch (err) {
    console.warn(`[mail] the mail settings could not be read, using the server setting: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
    return fallback();
  }
  const own = routes.find((r) => r.stream === stream) ?? null;
  const base = stream === "DEFAULT" ? null : (routes.find((r) => r.stream === "DEFAULT") ?? null);
  const connection = own?.connection ?? base?.connection ?? null;
  const replyTo = own?.replyTo ?? base?.replyTo ?? null;
  const name = own?.fromName ?? base?.fromName ?? null;
  if (!connection) {
    const resolved = fallback();
    const from = { name: name ?? resolved.from.name, address: own?.fromAddress ?? base?.fromAddress ?? resolved.from.address };
    return { ...resolved, from, replyTo };
  }
  // The default's From address only travels with the default's account.
  const borrowed = !own?.connection;
  const fromAddress = own?.fromAddress ?? (borrowed ? base?.fromAddress : null) ?? connection.fromAddress;
  return { kind: "connection", connection, from: { name: name ?? connection.fromName, address: fromAddress }, replyTo, via: connection.name };
}

// Microsoft 365: a token per account, used until five minutes before it ends.
const tokens = new Map<string, { key: string; token: string; until: number }>();
let testTokenFetch: typeof fetch | null = null;
let testTransport: ((options: SMTPTransport.Options) => Transporter) | null = null;

/** For check scripts: what answers Microsoft's token endpoint, and what stands in for SMTP. Null: the real ones. */
export function setTestMailTransport(transport: ((options: SMTPTransport.Options) => Transporter) | null, tokenFetch: typeof fetch | null = null): void {
  testTransport = transport;
  testTokenFetch = tokenFetch;
  tokens.clear();
}

function forgetToken(connectionId: string) {
  tokens.delete(connectionId);
}

/**
 * Drops an account's Microsoft token — after it was refused, so the next send asks again. Microsoft
 * writes the app's permissions into the token when it issues it: one fetched before an admin granted
 * consent never gains them, however long it has left.
 */
export function forgetMailToken(connectionId: string): void {
  forgetToken(connectionId);
}

/** The permissions ("roles") Microsoft wrote into an account's current token, or null without one. Read, never verified — it is only for saying why a send failed. */
function tokenRoles(connectionId: string): string[] | null {
  const held = tokens.get(connectionId);
  if (!held) return null;
  try {
    const payload = JSON.parse(Buffer.from(held.token.split(".")[1] ?? "", "base64url").toString("utf8")) as { roles?: unknown };
    return Array.isArray(payload.roles) ? payload.roles.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return null;
  }
}

/**
 * What to do about a Microsoft 365 refusal, in words, when it is one of the known ones: SMTP AUTH off
 * for the mailbox or the tenant (5.7.139), or the app not allowed to send as the mailbox (5.7.3) —
 * told apart by whether the token carries SMTP.SendAsApp. Null for anything else, or another service.
 */
export function microsoftHint(connection: MailConnection, err: unknown): string | null {
  if (connection.provider !== "MICROSOFT_365") return null;
  const e = err as { message?: unknown; response?: unknown } | null;
  const said = `${typeof e?.message === "string" ? e.message : ""} ${typeof e?.response === "string" ? e.response : ""}`;
  if (/5\.7\.139/.test(said)) {
    return "SMTP AUTH is off for this mailbox in Microsoft 365: Set-CASMailbox -Identity <mailbox> -SmtpClientAuthenticationDisabled $false, then allow up to an hour.";
  }
  if (/5\.7\.3\b|\b535\b/.test(said)) {
    const roles = tokenRoles(connection.id);
    if (roles && !roles.includes("SMTP.SendAsApp")) {
      return "The app's token has no SMTP.SendAsApp: add it under Office 365 Exchange Online › Application permissions, grant admin consent, and test again.";
    }
    if (roles) {
      return "The app has SMTP.SendAsApp, so Exchange doesn't let it use this mailbox yet: run New-ServicePrincipal and Add-MailboxPermission (the steps), then allow 30 minutes.";
    }
  }
  return null;
}

/** A refusal Microsoft sends back, as one line without its trace and correlation ids. */
function microsoftSaid(body: unknown): string {
  const b = body && typeof body === "object" ? (body as { error?: unknown; error_description?: unknown }) : {};
  const description = typeof b.error_description === "string" ? (b.error_description.split(/\r?\n/)[0] ?? "") : "";
  return [typeof b.error === "string" ? b.error : null, description.replace(/\s*Trace ID:.*$/i, "")].filter(Boolean).join(": ") || "no reason given";
}

async function microsoftToken(connection: MailConnection, secret: string): Promise<string> {
  const key = `${connection.msTenantId}|${connection.msClientId}|${connection.updatedAt.getTime()}`;
  const held = tokens.get(connection.id);
  if (held && held.key === key && held.until > Date.now()) return held.token;
  const body = new URLSearchParams({ client_id: connection.msClientId ?? "", client_secret: secret, scope: "https://outlook.office365.com/.default", grant_type: "client_credentials" });
  const res = await (testTokenFetch ?? fetch)(`https://login.microsoftonline.com/${encodeURIComponent(connection.msTenantId ?? "")}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!res.ok || typeof json?.access_token !== "string") throw new Error(`Microsoft refused the app's sign-in (${res.status}): ${microsoftSaid(json)}`);
  const seconds = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in) || 3600;
  tokens.set(connection.id, { key, token: json.access_token, until: Date.now() + Math.max(60, seconds - 300) * 1000 });
  return json.access_token;
}

/**
 * The transport for an account — its secret opened here and nowhere else. `fresh`: a new Microsoft
 * token rather than the one held (a console test, which should test the app as it is now).
 */
export async function transportFor(connection: MailConnection, how: { fresh?: boolean } = {}): Promise<Transporter> {
  if (how.fresh) forgetToken(connection.id);
  const secret = connection.secretCipher ? openForPlatform("mail-connection", connection.secretCipher) : "";
  const auth: SMTPTransport.Options["auth"] =
    connection.provider === "MICROSOFT_365"
      ? { type: "OAuth2", user: connection.username ?? "", accessToken: await microsoftToken(connection, secret) }
      : { user: connection.username ?? "", pass: secret };
  const options: SMTPTransport.Options = {
    host: connection.host,
    port: connection.port,
    secure: connection.security === "TLS",
    requireTLS: connection.security === "STARTTLS",
    auth,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    tls: { servername: connection.host, minVersion: "TLSv1.2" },
  };
  return testTransport ? testTransport(options) : nodemailer.createTransport(options);
}

/** The server setting's transport (PLATFORM_SMTP_URL), or the check scripts' stand-in. */
export function serverTransport(url: string): Transporter {
  return testTransport ? testTransport({ url } as SMTPTransport.Options) : nodemailer.createTransport(url);
}

/** Why a send failed, for the log and the console: one line, secrets masked. */
export function sendError(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown; responseCode?: unknown; response?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : String(err);
  const response = typeof e?.response === "string" && !message.includes(e.response) ? ` — ${e.response}` : "";
  const code = typeof e?.code === "string" && !message.includes(e.code) ? `${e.code}: ` : "";
  const text = (redactSecrets(`${code}${message}${response}`) ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, 300) || "The mail server refused it.";
}

/**
 * Why a send through an account failed: as `sendError`, and the account's own secret masked too —
 * as typed, and as SMTP's AUTH PLAIN and LOGIN would have carried it — should a server ever echo it.
 */
export function connectionSendError(connection: MailConnection, err: unknown): string {
  // The way out first, when it is a known Microsoft refusal; what the server said after it.
  const hint = microsoftHint(connection, err);
  let text = hint ? `${hint} — ${sendError(err)}`.slice(0, 300) : sendError(err);
  let secret = "";
  try {
    secret = connection.secretCipher ? openForPlatform("mail-connection", connection.secretCipher) : "";
  } catch {
    secret = "";
  }
  if (secret.length >= 4) {
    const user = connection.username ?? "";
    const forms = [secret, Buffer.from(secret).toString("base64"), Buffer.from(`\u0000${user}\u0000${secret}`).toString("base64"), Buffer.from(`${user}\u0000${secret}`).toString("base64")];
    for (const form of forms) text = text.split(form).join("***");
  }
  return text;
}

/** Every provider's key, for the checks. */
export const PROVIDER_KEYS = MAIL_PROVIDERS.map((p) => p.key);
