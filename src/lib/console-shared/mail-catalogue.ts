/**
 * What the console's Mail settings offer (owner, 5 Oct 2026): the mail services an account can be,
 * each with its server, how it signs in and where its settings are found; and the four types of the
 * platform's own mail, each of which can go through its own account. Pure and client-safe — the
 * console's form and the server's checks read the same lists (src/lib/platform/mail/store.ts).
 */

export type MailProviderKey = "MICROSOFT_365" | "AWS_SES" | "ELASTIC_EMAIL" | "SENDGRID" | "BREVO" | "MAILGUN" | "POSTMARK" | "SMTP";
export type MailSecurityKey = "TLS" | "STARTTLS";
export type MailStreamKey = "DEFAULT" | "ACCOUNT" | "BILLING" | "SUPPORT" | "ALERTS";
/** The four a mail is sent as — every platform mail names one (src/lib/platform/mailer.ts). */
export type MailType = Exclude<MailStreamKey, "DEFAULT">;

export type ServerChoice = { label: string; host: string };

export type MailProviderDef = {
  key: MailProviderKey;
  label: string;
  /** One line under the name. */
  blurb: string;
  /** The servers to choose between (a region); one means it is fixed; none, typed in (custom SMTP). */
  servers: ServerChoice[];
  port: number;
  security: MailSecurityKey;
  /** "oauth": Microsoft 365's app sign-in; "password": an SMTP login and password (or API key). */
  signIn: "oauth" | "password";
  username: { label: string; hint: string; fixed?: string };
  secret: { label: string; hint: string };
  /** Where everything is found, in order. */
  steps: string[];
};

export const MAIL_PROVIDERS: readonly MailProviderDef[] = [
  {
    key: "MICROSOFT_365",
    label: "Microsoft 365",
    blurb: "Exchange Online, signing in as an Entra app (OAuth) — Microsoft is turning off SMTP passwords.",
    servers: [{ label: "Exchange Online", host: "smtp.office365.com" }],
    port: 587,
    security: "STARTTLS",
    signIn: "oauth",
    username: { label: "Mailbox to send from", hint: "The licensed or shared mailbox the mail goes out of, e.g. no-reply@deskzo.com." },
    secret: { label: "Client secret", hint: "Its value, not its ID — shown once, when it is made." },
    steps: [
      "Entra admin centre › App registrations › New registration: a name like “Deskzo mail”, single tenant. Copy the Application (client) ID and the Directory (tenant) ID.",
      "API permissions › Add a permission › APIs my organization uses › Office 365 Exchange Online › Application permissions › SMTP.SendAsApp. Then Grant admin consent.",
      "Certificates & secrets › New client secret. Copy its value now — it is shown only once.",
      "Enterprise applications › the same app: copy its Object ID (the enterprise application's, not the registration's).",
      "In Exchange Online PowerShell (Connect-ExchangeOnline): New-ServicePrincipal -AppId <client ID> -ObjectId <enterprise object ID>. Then Add-MailboxPermission -Identity <mailbox> -User <the service principal's Identity, from Get-ServicePrincipal> -AccessRights FullAccess.",
      "If SMTP AUTH is off for the mailbox: Set-CASMailbox -Identity <mailbox> -SmtpClientAuthenticationDisabled $false.",
    ],
  },
  {
    key: "AWS_SES",
    label: "Amazon SES",
    blurb: "AWS Simple Email Service, through its SMTP interface.",
    servers: [
      { label: "Asia Pacific (Mumbai) — ap-south-1", host: "email-smtp.ap-south-1.amazonaws.com" },
      { label: "Asia Pacific (Singapore) — ap-southeast-1", host: "email-smtp.ap-southeast-1.amazonaws.com" },
      { label: "Asia Pacific (Sydney) — ap-southeast-2", host: "email-smtp.ap-southeast-2.amazonaws.com" },
      { label: "Asia Pacific (Tokyo) — ap-northeast-1", host: "email-smtp.ap-northeast-1.amazonaws.com" },
      { label: "US East (N. Virginia) — us-east-1", host: "email-smtp.us-east-1.amazonaws.com" },
      { label: "US East (Ohio) — us-east-2", host: "email-smtp.us-east-2.amazonaws.com" },
      { label: "US West (Oregon) — us-west-2", host: "email-smtp.us-west-2.amazonaws.com" },
      { label: "Canada (Central) — ca-central-1", host: "email-smtp.ca-central-1.amazonaws.com" },
      { label: "Europe (Ireland) — eu-west-1", host: "email-smtp.eu-west-1.amazonaws.com" },
      { label: "Europe (London) — eu-west-2", host: "email-smtp.eu-west-2.amazonaws.com" },
      { label: "Europe (Frankfurt) — eu-central-1", host: "email-smtp.eu-central-1.amazonaws.com" },
      { label: "South America (São Paulo) — sa-east-1", host: "email-smtp.sa-east-1.amazonaws.com" },
    ],
    port: 587,
    security: "STARTTLS",
    signIn: "password",
    username: { label: "SMTP username", hint: "From SES › SMTP settings › Create SMTP credentials — not an AWS access key." },
    secret: { label: "SMTP password", hint: "Shown once, with the username, when the credentials are made." },
    steps: [
      "SES › Identities: verify the domain you send from (deskzo.com), with its DKIM records.",
      "Account dashboard: request production access, or SES only sends to addresses you have verified.",
      "SMTP settings › Create SMTP credentials, in the same region as the identity. Copy the username and password.",
    ],
  },
  {
    key: "ELASTIC_EMAIL",
    label: "Elastic Email",
    blurb: "Elastic Email's SMTP relay.",
    servers: [{ label: "Elastic Email", host: "smtp.elasticemail.com" }],
    port: 2525,
    security: "STARTTLS",
    signIn: "password",
    username: { label: "SMTP username", hint: "As shown in Settings › SMTP — usually the account's email address." },
    secret: { label: "SMTP password", hint: "The SMTP password (an API key with Send access) from Settings › SMTP." },
    steps: ["Settings › Domains: add and verify the domain you send from.", "Settings › SMTP › Create credentials. Copy the username and password."],
  },
  {
    key: "SENDGRID",
    label: "SendGrid",
    blurb: "Twilio SendGrid's SMTP relay.",
    servers: [{ label: "SendGrid", host: "smtp.sendgrid.net" }],
    port: 587,
    security: "STARTTLS",
    signIn: "password",
    username: { label: "Username", hint: "Always the word apikey.", fixed: "apikey" },
    secret: { label: "API key", hint: "Settings › API Keys › Create API Key, with Mail Send access." },
    steps: ["Settings › Sender Authentication: authenticate the domain you send from.", "Settings › API Keys › Create API Key with Mail Send permission. Copy it — it is shown once."],
  },
  {
    key: "BREVO",
    label: "Brevo",
    blurb: "Brevo (formerly Sendinblue) SMTP relay.",
    servers: [{ label: "Brevo", host: "smtp-relay.brevo.com" }],
    port: 587,
    security: "STARTTLS",
    signIn: "password",
    username: { label: "SMTP login", hint: "Shown on SMTP & API › SMTP." },
    secret: { label: "SMTP key", hint: "SMTP & API › SMTP › Generate a new SMTP key." },
    steps: ["Senders, domains & dedicated IPs › Domains: authenticate the domain you send from.", "SMTP & API › SMTP: copy the login, and generate an SMTP key."],
  },
  {
    key: "MAILGUN",
    label: "Mailgun",
    blurb: "Mailgun's SMTP, in its US or EU region.",
    servers: [
      { label: "US region", host: "smtp.mailgun.org" },
      { label: "EU region", host: "smtp.eu.mailgun.org" },
    ],
    port: 587,
    security: "STARTTLS",
    signIn: "password",
    username: { label: "SMTP login", hint: "Like postmaster@mg.deskzo.com — Sending › Domain settings › SMTP credentials." },
    secret: { label: "SMTP password", hint: "Set or reset on the same page." },
    steps: ["Sending › Domains: add and verify the sending domain, in the region you choose here.", "Domain settings › SMTP credentials: copy the login and set a password."],
  },
  {
    key: "POSTMARK",
    label: "Postmark",
    blurb: "Postmark's SMTP, for a server's transactional stream.",
    servers: [{ label: "Postmark", host: "smtp.postmarkapp.com" }],
    port: 587,
    security: "STARTTLS",
    signIn: "password",
    username: { label: "Server API token", hint: "Servers › your server › API Tokens. Postmark uses the token as both username and password." },
    secret: { label: "Server API token, again", hint: "The same token." },
    steps: ["Sender Signatures: verify the domain (or address) you send from.", "Servers › your server › API Tokens: copy the Server API token — it is both the username and the password."],
  },
  {
    key: "SMTP",
    label: "Other SMTP server",
    blurb: "Any mail server that accepts an SMTP login — Google Workspace, Zoho Mail, your own.",
    servers: [],
    port: 587,
    security: "STARTTLS",
    signIn: "password",
    username: { label: "Username", hint: "Usually the full address of the mailbox." },
    secret: { label: "Password", hint: "An app password where the provider has them." },
    steps: ["From the provider's SMTP settings: the server's name, its port, and whether it wants TLS from the start (465) or STARTTLS (587)."],
  },
];

export const providerDef = (key: string): MailProviderDef | null => MAIL_PROVIDERS.find((p) => p.key === key) ?? null;

export type MailStreamDef = { key: MailStreamKey; label: string; description: string; examples: string };

export const MAIL_STREAMS: readonly MailStreamDef[] = [
  { key: "DEFAULT", label: "Default", description: "What every type below uses unless it names its own account.", examples: "" },
  {
    key: "ACCOUNT",
    label: "Account & security",
    description: "Codes, links and notices about signing in.",
    examples: "Signup codes, password and setup links, invitations, “your workspace is ready”, find-my-workspaces, linked workspaces, support access requests",
  },
  { key: "BILLING", label: "Billing", description: "Trials and payments.", examples: "Trial ending, payment due, workspace held for billing" },
  {
    key: "SUPPORT",
    label: "Support",
    description: "Customers' conversations with support.",
    examples: "Helpdesk replies from workspaces (tickets by email), Contact Support acknowledgements, notifications and replies",
  },
  {
    key: "ALERTS",
    label: "Alerts",
    description: "Notices for your team, and warnings to workspace owners.",
    examples: "Website contact-form leads, partner applications, custom-domain warnings",
  },
];

export const streamDef = (key: string): MailStreamDef | null => MAIL_STREAMS.find((s) => s.key === key) ?? null;

/** An address as SMTP takes it: one, no name, no spaces. */
export const EMAIL_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
/** A server's name: letters, digits, dots and hyphens — no scheme, no port, no path. */
export const HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
/** An Entra directory or application ID. */
export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long the delivery log keeps a row. */
export const MAIL_LOG_DAYS = 90;
