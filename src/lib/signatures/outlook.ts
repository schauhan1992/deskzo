import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { tenantKey } from "@/lib/tenancy/cache";
import { COMPANY_NAME } from "@/lib/brand-names";
import { getOrganisation } from "@/lib/organisation";
import { signatureText } from "@/lib/signatures/render";
import { PERSON_SELECT, mailboxSignature, personSignature, signatureContext, type Person } from "@/lib/signatures/person";
import { readSignatureSettings } from "@/lib/signatures/sync";
import { PEOPLE_ONLY } from "@/lib/people";

/**
 * Deskzo Signatures for Microsoft 365. Microsoft gives no way to set somebody's Outlook signature from
 * outside, so it is an Outlook add-in: the company's Microsoft 365 administrator uploads this workspace's
 * manifest once (Microsoft 365 admin center → Settings → Integrated apps), and from then on Outlook runs
 * the add-in whenever somebody starts a message. It asks the workspace for that person's signature —
 * drawn from their record by the same template as Gmail's and Zoho's — and puts it in.
 *
 * Everything it needs is served by the workspace itself, under /api/signatures/outlook: the manifest
 * (managers only), the page and the one script Outlook runs, its icons, and the signature. Classic
 * Outlook for Windows runs the script on its own, without the page, and lets it reach the workspace
 * only when the workspace lists it at /.well-known/microsoft-officeaddins-allowed.json.
 *
 * Who is asking: the add-in says only the address of the mailbox it runs in. Microsoft's way of proving
 * that (single sign-on) needs an app registered in the company's Entra ID, which is a later step. So
 * while the add-in is on, anybody who knows a person's work address can ask for that person's
 * signature — what every email they send already shows — and a caller who guesses wrong addresses is
 * stopped after a few. The add-in is off until a manager turns it on.
 */

/**
 * Bumped when the manifest's content changes; an uploaded manifest keeps working with the old one, and
 * the administrator uploads the new file to get what was added (1.1: a changed From).
 */
export const OUTLOOK_MANIFEST_VERSION = "1.1.0.0";

/** Outlook refuses a signature longer than this (Office.Body.setSignatureAsync). */
export const OUTLOOK_LIMIT = 30_000;

export const OUTLOOK_PATHS = {
  page: "/api/signatures/outlook/launch.html",
  script: "/api/signatures/outlook/launch.js",
  signature: "/api/signatures/outlook/signature",
  manifest: "/api/signatures/outlook/manifest.xml",
  icon: (size: number) => `/api/signatures/outlook/icon/${size}`,
  allowed: "/.well-known/microsoft-officeaddins-allowed.json",
};

/** The sizes Outlook asks for: the ribbon button's (16, 32, 80) and the add-in's own (64, 128). */
export const OUTLOOK_ICON_SIZES = [16, 32, 64, 80, 128] as const;

/** The manifest says where Office.js is; Microsoft serves it, and only from here. */
export const OFFICE_JS = "https://appsforoffice.microsoft.com/lib/1/hosted/office.js";

/** The names Outlook calls the script's handlers by — the manifest and the script must agree. */
export const OUTLOOK_HANDLERS = { compose: "deskzoOnNewMessageCompose", button: "deskzoInsertSignature", from: "deskzoOnMessageFromChanged" } as const;

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function html(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The company's name, as its signatures show it. */
export async function outlookCompany(): Promise<string> {
  const org = await getOrganisation();
  return org.tradeName?.trim() || org.legalName?.trim() || "";
}

/** A name for the add-in in Outlook and in the admin center: the company's, or a plain one. */
export function addinName(company: string): string {
  const name = company.trim().slice(0, 80);
  return name ? `${name} signatures` : "Company signatures";
}

/**
 * The add-in's manifest — the add-in only (XML) kind, because the unified one isn't taken by Outlook on
 * a Mac or a phone. Two events on every Outlook that runs event-based add-ins — a new message (replies and
 * forwards included, which get the template's reply signature) and a changed From (a shared mailbox, or
 * another account) — and a button in the message's ribbon to put the signature in again. Read/write item
 * is the least it can ask for to set a signature.
 */
export function outlookManifest(p: { origin: string; addinId: string; company: string }): string {
  const o = p.origin.replace(/\/+$/, "");
  const name = xml(addinName(p.company));
  const url = (path: string) => xml(`${o}${path}`);
  const launchEvent = `<ExtensionPoint xsi:type="LaunchEvent">
              <LaunchEvents>
                <LaunchEvent Type="OnNewMessageCompose" FunctionName="${OUTLOOK_HANDLERS.compose}"/>
                <LaunchEvent Type="OnMessageFromChanged" FunctionName="${OUTLOOK_HANDLERS.from}"/>
              </LaunchEvents>
              <SourceLocation resid="Launch.Url"/>
            </ExtensionPoint>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0" xsi:type="MailApp">
  <Id>${xml(p.addinId)}</Id>
  <Version>${OUTLOOK_MANIFEST_VERSION}</Version>
  <ProviderName>${xml(COMPANY_NAME)}</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="${name}"/>
  <Description DefaultValue="Puts your company email signature, kept by ${xml(COMPANY_NAME)} Signatures, into every new message."/>
  <IconUrl DefaultValue="${url(OUTLOOK_PATHS.icon(64))}"/>
  <HighResolutionIconUrl DefaultValue="${url(OUTLOOK_PATHS.icon(128))}"/>
  <SupportUrl DefaultValue="${url("/signatures")}"/>
  <AppDomains>
    <AppDomain>${xml(o)}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Mailbox"/>
  </Hosts>
  <Requirements>
    <Sets DefaultMinVersion="1.1">
      <Set Name="Mailbox"/>
    </Sets>
  </Requirements>
  <FormSettings>
    <Form xsi:type="ItemEdit">
      <DesktopSettings>
        <SourceLocation DefaultValue="${url(OUTLOOK_PATHS.page)}"/>
      </DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadWriteItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Edit"/>
  </Rule>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides/1.1" xsi:type="VersionOverridesV1_1">
      <Requirements>
        <bt:Sets DefaultMinVersion="1.5">
          <bt:Set Name="Mailbox"/>
        </bt:Sets>
      </Requirements>
      <Hosts>
        <Host xsi:type="MailHost">
          <Runtimes>
            <Runtime resid="Launch.Url">
              <Override type="javascript" resid="LaunchScript.Url"/>
            </Runtime>
          </Runtimes>
          <DesktopFormFactor>
            <FunctionFile resid="Launch.Url"/>
            <ExtensionPoint xsi:type="MessageComposeCommandSurface">
              <OfficeTab id="TabDefault">
                <Group id="deskzoSignatureGroup">
                  <Label resid="Group.Label"/>
                  <Control xsi:type="Button" id="deskzoInsertSignatureButton">
                    <Label resid="Insert.Label"/>
                    <Supertip>
                      <Title resid="Insert.Label"/>
                      <Description resid="Insert.Tooltip"/>
                    </Supertip>
                    <Icon>
                      <bt:Image size="16" resid="Icon.16"/>
                      <bt:Image size="32" resid="Icon.32"/>
                      <bt:Image size="80" resid="Icon.80"/>
                    </Icon>
                    <Action xsi:type="ExecuteFunction">
                      <FunctionName>${OUTLOOK_HANDLERS.button}</FunctionName>
                    </Action>
                  </Control>
                </Group>
              </OfficeTab>
            </ExtensionPoint>
            ${launchEvent}
          </DesktopFormFactor>
          <MobileFormFactor>
            ${launchEvent}
          </MobileFormFactor>
        </Host>
      </Hosts>
      <Resources>
        <bt:Images>
          <bt:Image id="Icon.16" DefaultValue="${url(OUTLOOK_PATHS.icon(16))}"/>
          <bt:Image id="Icon.32" DefaultValue="${url(OUTLOOK_PATHS.icon(32))}"/>
          <bt:Image id="Icon.80" DefaultValue="${url(OUTLOOK_PATHS.icon(80))}"/>
        </bt:Images>
        <bt:Urls>
          <bt:Url id="Launch.Url" DefaultValue="${url(OUTLOOK_PATHS.page)}"/>
          <bt:Url id="LaunchScript.Url" DefaultValue="${url(OUTLOOK_PATHS.script)}"/>
        </bt:Urls>
        <bt:ShortStrings>
          <bt:String id="Group.Label" DefaultValue="${name}"/>
          <bt:String id="Insert.Label" DefaultValue="Insert signature"/>
        </bt:ShortStrings>
        <bt:LongStrings>
          <bt:String id="Insert.Tooltip" DefaultValue="Puts your company signature into this message again."/>
        </bt:LongStrings>
      </Resources>
    </VersionOverrides>
  </VersionOverrides>
</OfficeApp>
`;
}

/**
 * The script Outlook runs. One file and no imports: classic Outlook for Windows loads it on its own, in
 * a runtime with no page, where every address must be absolute. It finishes every event it is given —
 * Outlook waits for that — and gives up after 20 seconds rather than leave a message hanging. It says
 * something only when the person can act on it.
 */
export function outlookScript(origin: string): string {
  const o = JSON.stringify(origin.replace(/\/+$/, ""));
  const ask = JSON.stringify(OUTLOOK_PATHS.signature);
  return `/*
 * ${COMPANY_NAME} Signatures for Outlook. When somebody starts a message, changes its From, or presses
 * Insert signature, it asks their workspace for the signature and puts it in.
 */
var DESKZO_ORIGIN = ${o};
var DESKZO_WAIT_MS = 20000;

function deskzoFinish(event, run) {
  if (run.done) return;
  run.done = true;
  if (run.timer) clearTimeout(run.timer);
  try {
    event.completed();
  } catch (e) {}
}

function deskzoTell(item, message) {
  try {
    item.notificationMessages.replaceAsync("deskzoSignature", { type: "errorMessage", message: message.slice(0, 150) }, function () {});
  } catch (e) {}
}

function deskzoTurnOffOwn(item, then) {
  if (typeof item.disableClientSignatureAsync !== "function") return then();
  if (typeof item.isClientSignatureEnabledAsync !== "function") {
    item.disableClientSignatureAsync(function () {
      then();
    });
    return;
  }
  item.isClientSignatureEnabledAsync(function (r) {
    if (r.status === "succeeded" && r.value === true) {
      item.disableClientSignatureAsync(function () {
        then();
      });
    } else then();
  });
}

function deskzoBodyType(item, then) {
  if (!item.body || typeof item.body.getTypeAsync !== "function") return then("html");
  item.body.getTypeAsync(function (r) {
    then(r.status === "succeeded" && r.value === "text" ? "text" : "html");
  });
}

// A reply or a forward, when Outlook can say — the button always puts the whole signature in.
function deskzoComposeType(item, mode, then) {
  if (mode === "button" || typeof item.getComposeTypeAsync !== "function") return then("newMail");
  item.getComposeTypeAsync(function (r) {
    then(r.status === "succeeded" && r.value && r.value.composeType ? String(r.value.composeType) : "newMail");
  });
}

// Whose signature: the mailbox Outlook runs in — or, when the From was changed (a shared mailbox, another
// account), the address it was changed to.
function deskzoAddress(item, mode, then) {
  var own = "";
  try {
    own = Office.context.mailbox.userProfile.emailAddress;
  } catch (e) {}
  if (mode !== "from" || !item.from || typeof item.from.getAsync !== "function") return then(own);
  item.from.getAsync(function (r) {
    then(r.status === "succeeded" && r.value && r.value.emailAddress ? r.value.emailAddress : own);
  });
}

function deskzoInsert(event, mode) {
  var run = { done: false, timer: null };
  if (typeof setTimeout === "function") {
    run.timer = setTimeout(function () {
      deskzoFinish(event, run);
    }, DESKZO_WAIT_MS);
  }
  var item = null;
  try {
    item = Office.context.mailbox.item;
  } catch (e) {}
  if (!item || !item.body) return deskzoFinish(event, run);

  deskzoAddress(item, mode, function (email) {
    if (!email) return deskzoFinish(event, run);
    deskzoBodyType(item, function (type) {
      deskzoComposeType(item, mode, function (composeType) {
        deskzoFetchAndSet(event, run, item, mode, email, type, composeType === "reply" || composeType === "forward");
      });
    });
  });
}

function deskzoFetchAndSet(event, run, item, mode, email, type, replying) {
  (function () {
    fetch(DESKZO_ORIGIN + ${ask} + "?email=" + encodeURIComponent(email), { method: "GET", headers: { Accept: "application/json" }, credentials: "omit" })
      .then(function (response) {
        return response.json().then(
          function (answer) {
            return { status: response.status, answer: answer };
          },
          function () {
            return { status: response.status, answer: null };
          },
        );
      })
      .then(function (r) {
        var a = r.answer || {};
        if (r.status !== 200) {
          // A From changed to an address with no signature here keeps the one already in.
          if (a.message && mode !== "from") deskzoTell(item, a.message);
          return deskzoFinish(event, run);
        }
        // On a reply or a forward, the template's reply signature — or none at all.
        var source = replying ? a.reply : a;
        if (!source) return deskzoFinish(event, run);
        var asText = type === "text" || !source.html;
        var signature = asText ? source.text : source.html;
        if (!signature) return deskzoFinish(event, run);
        item.body.setSignatureAsync(signature, { coercionType: asText ? "text" : "html" }, function (set) {
          if (set.status !== "succeeded") {
            deskzoTell(item, "Your company signature couldn't be put in: " + (set.error && set.error.message ? set.error.message : "Outlook refused it."));
            return deskzoFinish(event, run);
          }
          if (a.replaceOwn) {
            deskzoTurnOffOwn(item, function () {
              deskzoFinish(event, run);
            });
          } else deskzoFinish(event, run);
        });
      })
      .catch(function () {
        deskzoTell(item, "Your company signature couldn't be fetched. Press Insert signature to try again.");
        deskzoFinish(event, run);
      });
  })();
}

function ${OUTLOOK_HANDLERS.compose}(event) {
  deskzoInsert(event, "compose");
}

function ${OUTLOOK_HANDLERS.button}(event) {
  deskzoInsert(event, "button");
}

function ${OUTLOOK_HANDLERS.from}(event) {
  deskzoInsert(event, "from");
}

// In a page (Outlook on the web, the new Outlook, Mac, phones) Office.js waits to be told it may start;
// classic Outlook for Windows has no page and runs the handlers without it.
if (typeof document !== "undefined" && typeof Office !== "undefined" && typeof Office.onReady === "function") Office.onReady();
Office.actions.associate(${JSON.stringify(OUTLOOK_HANDLERS.compose)}, ${OUTLOOK_HANDLERS.compose});
Office.actions.associate(${JSON.stringify(OUTLOOK_HANDLERS.button)}, ${OUTLOOK_HANDLERS.button});
Office.actions.associate(${JSON.stringify(OUTLOOK_HANDLERS.from)}, ${OUTLOOK_HANDLERS.from});
`;
}

/** The page Outlook on the web, the new Outlook, Mac and phones load: Office.js, then the script. Nothing to see. */
export function outlookPage(origin: string, company: string): string {
  const o = origin.replace(/\/+$/, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${html(addinName(company))}</title>
<script src="${OFFICE_JS}"></script>
<script src="${html(`${o}${OUTLOOK_PATHS.script}`)}"></script>
</head>
<body></body>
</html>
`;
}

/** The well-known file: the one script classic Outlook for Windows may let reach this workspace. */
export function outlookAllowed(origin: string): { allowed: string[] } {
  return { allowed: [`${origin.replace(/\/+$/, "")}${OUTLOOK_PATHS.script}`] };
}

// ── Asking for a signature ──────────────────────────────────────────────────────────────────────────

/** Wrong addresses per caller, per workspace — somebody guessing addresses is stopped after a few. */
const misses = new Map<string, { count: number; since: number }>();
const MISS_WINDOW_MS = 10 * 60_000;
const MAX_MISSES = 20;
const MAX_TRACKED = 5_000;

/** Only for the check script. */
export function resetOutlookMisses() {
  misses.clear();
}

function missesOf(key: string, now: number): number {
  const entry = misses.get(key);
  if (!entry || now - entry.since >= MISS_WINDOW_MS) return 0;
  return entry.count;
}

function noteMiss(key: string, now: number) {
  const entry = misses.get(key);
  if (!entry || now - entry.since >= MISS_WINDOW_MS) {
    if (!entry && misses.size >= MAX_TRACKED) {
      const oldest = misses.keys().next().value;
      if (oldest !== undefined) misses.delete(oldest);
    }
    misses.set(key, { count: 1, since: now });
  } else entry.count += 1;
}

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,63}$/;

/** Written at most this often for a signature that hasn't changed — one row per person, not one per message. */
const NOTE_EVERY_MS = 60 * 60_000;

export type OutlookAnswer =
  | { status: 200; body: { html: string | null; text: string; reply: { html: string | null; text: string } | null; replaceOwn: boolean } }
  | { status: 404 | 429 | 400; body: { message: string | null } };

/**
 * A person's signature, for the add-in. Not found (with nothing said to the person) while Signatures is
 * out of the plan or the add-in is off; a plain "no signature" for an address that is nobody's here,
 * counted against the caller; the HTML and its plain-text twin otherwise, with whether to turn off the
 * person's own Outlook signature. The HTML is left out when Outlook would refuse it as too long.
 */
export async function outlookSignature(rawEmail: string | null, caller: string | null, now = Date.now()): Promise<OutlookAnswer> {
  const off: OutlookAnswer = { status: 404, body: { message: null } };
  if (!(await moduleAvailableForTenant("signatures"))) return off;
  const settings = await readSignatureSettings();
  if (!settings?.outlookOn) return off;

  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) return { status: 400, body: { message: null } };
  const key = `${await tenantKey()}|${caller ?? "unknown"}`;
  if (missesOf(key, now) >= MAX_MISSES) return { status: 429, body: { message: null } };

  const person = (await db.user.findFirst({ where: { email: { equals: email, mode: "insensitive" }, active: true, ...PEOPLE_ONLY }, select: PERSON_SELECT })) as Person | null;
  // Nobody's own address: perhaps a shared mailbox's (sales@, support@), when a From was changed to it.
  const mailbox = person ? null : await db.signatureMailbox.findUnique({ where: { address: email }, select: { id: true, address: true, name: true, phone: true, templateId: true } });
  if (!person && !mailbox) {
    noteMiss(key, now);
    return { status: 404, body: { message: `There is no company signature for ${email.slice(0, 80)}. Ask whoever manages your company's email signatures.` } };
  }

  const ctx = await signatureContext();
  const sig = person ? await personSignature(person, ctx) : mailboxSignature(mailbox!, ctx);
  if (person) {
    const last = await db.signatureOutlook.findUnique({ where: { userId: person.id } });
    if (!last || last.hash !== sig.hash || now - last.fetchedAt.getTime() >= NOTE_EVERY_MS) {
      const data = { hash: sig.hash, fetchedAt: new Date(now) };
      await db.signatureOutlook.upsert({ where: { userId: person.id }, create: { userId: person.id, ...data }, update: data });
    }
  }
  const fits = (html: string) => (html.length <= OUTLOOK_LIMIT ? html : null);
  return {
    status: 200,
    body: {
      html: fits(sig.html),
      text: signatureText(sig.details, null),
      reply: sig.reply ? { html: fits(sig.reply.html), text: sig.reply.text } : null,
      replaceOwn: settings.outlookReplaceOwn,
    },
  };
}
