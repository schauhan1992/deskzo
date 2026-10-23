import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check, Clock, CreditCard, Globe, LifeBuoy, Link2, Mail, Network, ReceiptText, Server, ShieldCheck, Sparkles, UserPlus, Waypoints, Workflow, type LucideIcon } from "lucide-react";
import { InvoicingSettingsForm } from "@/components/console/settings/invoicing-settings";
import { bankProblem, readBank, readSeller, sellerProblem } from "@/lib/billing/tax-invoice";
import { GST_STATE_CODES } from "@/lib/gst-engine";
import { Banner } from "@/components/console/kit/banner";
import { EnvBadge } from "@/components/console/kit/env-badge";
import { PageHeader } from "@/components/console/kit/page-header";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { GatewayKeysEditor } from "@/components/console/settings/gateway-keys";
import { CloudflareConnectionEditor } from "@/components/console/settings/cloudflare-connection";
import { DomainsOfferedSwitch } from "@/components/console/settings/domains-offered-setting";
import { ConsoleTimeZoneSetting } from "@/components/console/settings/time-zone-setting";
import { consoleZone } from "@/lib/platform/console-clock";
import { zoneOptions } from "@/lib/time/zones";
import { LinkedSignInSwitch } from "@/components/console/settings/linked-sign-in-setting";
import { AutomateSwitch } from "@/components/console/settings/automate-setting";
import { platformPause } from "@/lib/automate/switches";
import { aiSetup } from "@/lib/ai/accounts";
import { featureLabel } from "@/lib/ai/catalogue";
import { TwoFactorPolicyEditor } from "@/components/console/settings/security-settings";
import { ChangedBy, SignupSettingsForm } from "@/components/console/settings/signup-settings";
import type { SettingChange } from "@/components/console/settings/signup-settings";
import { SupportSettingsForm } from "@/components/console/support/support-settings";
import { durationText, plural } from "@/lib/console-shared/format";
import { actorLabel } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import type { Tone } from "@/lib/console-shared/types";
import { consoleStaff, platformEnv } from "@/lib/platform/console-page";
import { controlDb } from "@/lib/platform/control-db";
import { configurationPresence, securityFacts } from "@/lib/platform/health";
import { linkedSignInSetting } from "@/lib/platform/linked/groups";
import { autoDeprovision, customDomainsOffered, gatewayModes, settingsOverview, signupOpen, staffTwoFactorPolicy, trialDays, trialSeats, type SettingRow } from "@/lib/platform/settings";
import { lastTick, type TickSummary } from "@/lib/platform/tick-summary";
import { MAIL_STREAMS } from "@/lib/console-shared/mail-catalogue";
import { mailSetup } from "@/lib/platform/mail/store";
import { SUPPORT_SETTING_KEYS, getSupportSettings } from "@/lib/support/settings";

export const metadata: Metadata = { title: "Settings" };

const SECTIONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "signup", label: "Signup & trials", icon: UserPlus },
  { id: "gateways", label: "Payment gateways", icon: CreditCard },
  { id: "invoicing", label: "Invoicing", icon: ReceiptText },
  { id: "security", label: "Staff security", icon: ShieldCheck },
  { id: "linked-sign-in", label: "Linked sign-in", icon: Link2 },
  { id: "automate", label: "Automate", icon: Workflow },
  { id: "ai", label: "Deskzo AI", icon: Sparkles },
  { id: "custom-domains", label: "Custom domains", icon: Globe },
  { id: "time-zone", label: "Time zone", icon: Clock },
  { id: "support", label: "Support", icon: LifeBuoy },
  { id: "mail", label: "Mail", icon: Mail },
  { id: "environment", label: "Environment", icon: Server },
];

const LINK = "inline-flex items-center gap-1 rounded-base font-medium text-brand hover:underline";

/**
 * Every platform-wide setting in one place (spec §3.18): who may sign up and for how long a trial
 * runs, the payment gateways' keys, how staff sign in, whether linked sign-in is on in the workspaces,
 * and what the installation was started with — each with who changed it last. Owners, admins and
 * billing staff open it; only an owner changes anything, and everybody else is shown values, not
 * disabled controls.
 *
 * Nothing secret reaches this page: a gateway key arrives as "set or not" and the mode worked out
 * from it on the server, the environment as present or not. Changes are made through the owner-only
 * actions, which check the role again and write the audit log.
 */
export default async function ConsoleSettingsPage() {
  // First: signed out, the page ends here with a redirect to /login; support and read-only staff get "not found".
  const staff = await consoleStaff(PAGE_ROLES.settings);
  const caps = capsFor(staff.role);
  const [seller, bank, waitingInvoices] = await Promise.all([readSeller(), readBank(), controlDb().invoice.count({ where: { taxNumber: null, currency: "INR", status: "PAID" } })]);
  const sellerIssue = sellerProblem(seller);
  const [rows, modes, policy, open, days, people, autoClose, presence, tick, facts, support, linked, domainsOffered, timeZone, mail, automate, ai] = await Promise.all([
    settingsOverview(),
    gatewayModes(),
    staffTwoFactorPolicy(),
    signupOpen(),
    trialDays(),
    trialSeats(),
    autoDeprovision(),
    configurationPresence(),
    lastTick(),
    securityFacts(),
    getSupportSettings(),
    linkedSignInState(),
    customDomainsOffered(),
    consoleZone(),
    // Null until the release's migration has made the mail tables.
    mailSetup().catch(() => null),
    automateState(),
    // Null until the release's migration has made the AI tables.
    aiSetup().catch(() => null),
  ]);
  const env = platformEnv();
  const production = env.key === "production";

  const row = (key: SettingRow["key"]) => rows.find((r) => r.key === key) ?? null;
  // The three signup settings are always saved together, so the form says when it was last saved.
  const lastSaved = changeOf(newest([row("signup.open"), row("trial.days"), row("trial.seats"), row("billing.autoDeprovision")]));
  const tickBy = row("platform.lastTick")?.updatedByName ?? null;
  // The six support settings are saved together too.
  const supportSaved = changeOf(newest(SUPPORT_SETTING_KEYS.map((key) => row(key))));

  return (
    <>
      <PageHeader
        title="Settings"
        chips={caps.owner ? undefined : <StatusPill tone="neutral">{caps.manage ? "View only, except Support" : "View only"}</StatusPill>}
        subtitle={
          caps.owner
            ? "Platform-wide: a change here applies to every workspace at once, and is written to the audit log."
            : caps.manage
              ? "Platform-wide settings, as they stand. Only an owner changes them — except Support, which admins change too."
              : "Platform-wide settings, as they stand. Only an owner changes them."
        }
      />

      <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <SectionNav />

        <div className="min-w-0 space-y-6">
          <Panel id="signup" title="Signup & trials" description="Who can create a workspace, and how long its trial lasts.">
            {caps.owner ? (
              <SignupSettingsForm signupOpen={open} trialDays={days} trialSeats={people} autoDeprovision={autoClose} lastSaved={lastSaved} />
            ) : (
              <div className="space-y-4">
                <DefinitionList
                  columns={1}
                  items={[
                    {
                      term: "Open signup",
                      value: open ? (
                        <Stated tone="success" label="Open">
                          Anyone can create a workspace without an invitation.
                        </Stated>
                      ) : (
                        <Stated tone="neutral" label="Invite-only">
                          People need an invitation to sign up.
                        </Stated>
                      ),
                    },
                    {
                      term: "Trial length",
                      value: (
                        <Stated tone="info" label={plural(days, "day")}>
                          New workspaces start with a trial this long; trials already running keep their end date.
                        </Stated>
                      ),
                    },
                    {
                      term: "Close lapsed workspaces automatically",
                      value: autoClose ? (
                        <Stated tone="warning" label="On">
                          Workspaces held for billing for 90 days are closed: final backup, database dropped.
                        </Stated>
                      ) : (
                        <Stated tone="neutral" label="Off">
                          A lapsed workspace stays held until somebody closes it by hand.
                        </Stated>
                      ),
                    },
                  ]}
                />
                <ChangedBy change={lastSaved} prefix="Last saved by" never="Never saved — these are the defaults" className="border-t border-line pt-3" />
              </div>
            )}
          </Panel>

          <Panel
            id="gateways"
            title="Payment gateways"
            description={
              caps.owner
                ? "Keys are sealed when saved and never shown again — only whether each is set, and the mode it is in."
                : "Only whether each key is set, and the mode it is in — keys are never shown. Only an owner changes them."
            }
            padded={false}
            footer={
              <Link href="/billing#gateway-connections" className={LINK}>
                Webhook endpoints and the events to send are on Billing › Overview
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              </Link>
            }
          >
            <GatewayKeysEditor rows={rows.filter((r) => r.kind === "secret")} modes={modes} readOnly={!caps.owner} production={production} />
          </Panel>

          <Panel
            id="invoicing"
            title="Invoicing"
            description="Deskzo's own details on its GST tax invoices and credit notes — every paid rupee invoice gets one, numbered in the financial year's series and mailed to whoever it is made out to."
          >
            {caps.owner ? (
              <InvoicingSettingsForm
                initial={{
                  name: seller.name ?? "",
                  address: seller.address ?? "",
                  state: seller.state ?? "",
                  gstin: seller.gstin ?? "",
                  pan: seller.pan ?? "",
                  sac: seller.sac ?? "9983",
                  prefix: seller.prefix ?? "DZ",
                  bankAccountName: bank.accountName ?? "",
                  bankName: bank.bankName ?? "",
                  bankAccount: bank.account ?? "",
                  bankIfsc: bank.ifsc ?? "",
                  bankUpi: bank.upi ?? "",
                }}
                waiting={waitingInvoices}
              />
            ) : (
              <DefinitionList
                columns={1}
                items={[
                  { term: "Registered name", value: seller.name ?? <span className="text-muted">Not set</span> },
                  { term: "State · GSTIN", value: seller.state && seller.gstin ? `${GST_STATE_CODES[seller.state] ?? seller.state} · ${seller.gstin}` : <span className="text-muted">Not set</span> },
                  { term: "Ready to issue", value: sellerIssue ? <span className="text-warning">{sellerIssue}</span> : "Yes" },
                  { term: "Bank account, for proformas", value: bankProblem(bank) ? <span className="text-muted">Not set — workspaces can only pay online</span> : `${bank.bankName} · …${(bank.account ?? "").slice(-4)}` },
                ]}
              />
            )}
          </Panel>

          <Panel id="security" title="Staff security" description="How staff sign in to this console.">
            <div className="space-y-5">
              {production && policy.mode === "off" && (
                <Banner tone="danger" title="Two-factor is off on the production installation">
                  Anyone with a staff password reaches the console. System health counts this as failing.
                </Banner>
              )}

              {caps.owner ? (
                <TwoFactorPolicyEditor mode={policy.mode} chosen={policy.chosen} production={production} change={changeOf(row("staff.twoFactor"))} />
              ) : (
                <div className="space-y-2">
                  <DefinitionList
                    columns={1}
                    items={[
                      {
                        term: "Two-factor for staff",
                        value:
                          policy.mode === "required" ? (
                            <Stated tone="success" label="Required">
                              Everyone signs in with a password and a code from their authenticator app.
                            </Stated>
                          ) : (
                            <Stated tone={production ? "danger" : "warning"} label="Off">
                              A password alone opens the console.
                            </Stated>
                          ),
                      },
                    ]}
                  />
                  <ChangedBy change={changeOf(row("staff.twoFactor"))} never="Not changed yet — the installation's default" />
                </div>
              )}

              {facts.withoutAuthenticator ? (
                <p className="text-xs text-warning">
                  {`${plural(facts.withoutAuthenticator, "active staff member")} ${facts.withoutAuthenticator === 1 ? "has" : "have"} no authenticator yet — they set one up before they get in. `}
                  <Link href="/staff" className="font-medium underline underline-offset-2">
                    See staff
                  </Link>
                </p>
              ) : null}

              <div className="border-t border-line pt-4">
                <h3 className="text-[13px] font-medium text-text">Set on the server</h3>
                <ul className="mt-2 space-y-2">
                  <Fact icon={Clock}>Sessions end after 30 minutes idle or 12 hours</Fact>
                  <Fact icon={Network} state={facts.allowlist}>{`IP allowlist: ${facts.allowlist ? "on" : "off"} (set on the server)`}</Fact>
                  <Fact icon={Waypoints} state={facts.trustProxy}>{`Trusted proxy: ${facts.trustProxy ? "on" : "off"}`}</Fact>
                </ul>
                {facts.allowlist && !facts.trustProxy && (
                  <p className="mt-2 text-xs text-warning">The allowlist needs TRUST_PROXY=1 behind the reverse proxy, or nobody reaches the console.</p>
                )}
              </div>
            </div>
          </Panel>

          <Panel
            id="linked-sign-in"
            title="Linked sign-in"
            description="Switching between linked workspaces from the header, without signing in again — one switch for every workspace."
          >
            <LinkedSignInSwitch enabled={linked.enabled} change={linked.change} readOnly={!caps.owner} />
          </Panel>

          <Panel id="automate" title="Automate" description="Deskzo Automate's workflows in every workspace — one switch to pause them all at once, as a kill switch.">
            <AutomateSwitch running={automate.running} change={automate.change} readOnly={!caps.owner} />
          </Panel>

          <Panel
            id="custom-domains"
            title="Custom domains"
            description="Whether workspace owners may reach their workspace at an address of their own. Each plan says how many; staff add them from a workspace's page either way. Their HTTPS certificates come through Cloudflare."
          >
            <DomainsOfferedSwitch offered={domainsOffered} change={changeOf(row("domains.offered"))} readOnly={!caps.owner} />
            <div className="mt-5 border-t border-line pt-5">
              <CloudflareConnectionEditor
                zoneId={row("cloudflare.zoneId")?.value ?? null}
                tokenSet={row("cloudflare.apiToken")?.set ?? false}
                zoneChange={changeOf(row("cloudflare.zoneId"))}
                tokenChange={changeOf(row("cloudflare.apiToken"))}
                readOnly={!caps.owner}
                canCheck={caps.manage}
              />
            </div>
          </Panel>

          <Panel id="time-zone" title="Time zone" description="The zone every time in this console is shown in, for all staff. Each workspace keeps its own, chosen by its owner.">
            <ConsoleTimeZoneSetting zone={timeZone} options={zoneOptions()} change={changeOf(row("console.timezone"))} readOnly={!caps.owner} />
          </Panel>

          <Panel id="support" title="Support" description="Contact Support in the workspaces: where requests are announced, the helpline, recording, and how long files are kept.">
            {caps.manage ? (
              <SupportSettingsForm settings={support} lastSaved={supportSaved} />
            ) : (
              <div className="space-y-4">
                <DefinitionList
                  columns={1}
                  items={[
                    {
                      term: "Contact Support in workspaces",
                      value: support.enabled ? (
                        <Stated tone="success" label="On">
                          Everybody signed in to a workspace can send a request.
                        </Stated>
                      ) : (
                        <Stated tone="neutral" label="Off">
                          No workspace shows the button.
                        </Stated>
                      ),
                    },
                    { term: "Support email", value: <span className="break-all">{support.email}</span> },
                    { term: "Helpline", value: support.helpline ? `${support.helpline}${support.hours ? ` · ${support.hours}` : ""}` : "Not shown" },
                    { term: "Languages", value: support.languages ?? "Not shown" },
                    {
                      term: "Screen recording",
                      value: support.recording ? (
                        <Stated tone="success" label="On">
                          Offered after the customer consents.
                        </Stated>
                      ) : (
                        <Stated tone="neutral" label="Off">
                          Not offered.
                        </Stated>
                      ),
                    },
                    { term: "Keep files after closing", value: plural(support.retentionDays, "day") },
                  ]}
                />
                <ChangedBy change={supportSaved} prefix="Last saved by" never="Never saved — these are the defaults" className="border-t border-line pt-3" />
              </div>
            )}
          </Panel>

          <Panel
            id="ai"
            title="Deskzo AI"
            description="Where the copilot and Automate's drafting run, the rates workspaces pay in credits, the packs on sale, and the switch that pauses AI everywhere."
            footer={
              <Link href="/settings/ai" className={LINK}>
                {caps.owner ? "Manage Deskzo AI" : "See Deskzo AI"}
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              </Link>
            }
          >
            {ai ? (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <StatusPill tone={ai.paused ? "warning" : "success"}>{ai.paused ? "Paused" : "Running"}</StatusPill>
                <span className="text-muted">
                  {ai.routes.map((r) => `${featureLabel(r.feature)}: ${ai.models.find((m) => m.id === r.modelId)?.label ?? "not set up"}`).join(" · ")}
                </span>
              </p>
            ) : (
              <p className="text-sm text-muted">{"Deskzo AI settings appear once this release's migrations have run."}</p>
            )}
          </Panel>

          <Panel
            id="mail"
            title="Mail"
            description="The accounts the platform's own mail goes through, and which one each type of mail uses."
            footer={
              <Link href="/settings/mail" className={LINK}>
                {caps.owner ? "Manage mail accounts" : "See mail accounts"}
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              </Link>
            }
          >
            {mail ? <MailSummary mail={mail} /> : <p className="text-sm text-muted">{"Mail settings appear once this release's migrations have run."}</p>}
          </Panel>

          <Panel
            id="environment"
            title="Environment"
            description="What this installation was started with. Values stay on the server; only whether each is set is shown."
            actions={<EnvBadge env={env} size="md" />}
            padded={false}
            footer={
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                <Link href="/health#configuration" className={LINK}>
                  System health › Configuration
                  <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                </Link>
                <Link href="/plans" className={LINK}>
                  Plans and prices
                  <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                </Link>
              </div>
            }
          >
            <ul aria-label="Environment variables" className="divide-y divide-line">
              {presence.map((p) => (
                <li key={p.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-5 py-2.5">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-text">
                      {p.label}
                      <span className="font-mono text-[11px] break-all text-subtle">{p.key}</span>
                    </p>
                    {p.note && <p className="mt-0.5 text-xs text-muted">{p.note}</p>}
                  </div>
                  <StatusPill tone={p.set ? "success" : "neutral"} icon={p.set ? <Check className="h-3 w-3" /> : undefined}>
                    {p.set ? "Set" : "Not set"}
                  </StatusPill>
                </li>
              ))}
            </ul>
            <LastTick tick={tick} by={tickBy} />
          </Panel>
        </div>
      </div>
    </>
  );
}

/** The sections as anchors — a column that stays in view on wide screens, a row of links above the cards on narrow ones. */
function SectionNav() {
  return (
    <nav aria-label="Settings sections" className="min-w-0 lg:sticky lg:top-20 lg:self-start">
      <p className="mb-2 hidden text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase lg:block">On this page</p>
      <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <li key={id} className="shrink-0">
            <a
              href={`#${id}`}
              className="flex items-center gap-2 rounded-base border border-line px-2.5 py-1.5 text-sm whitespace-nowrap text-muted hover:bg-surface-sunken hover:text-text lg:border-transparent"
            >
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A value as a pill, then what it means. */
function Stated({ tone, label, children }: { tone: Tone; label: string; children: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusPill tone={tone}>{label}</StatusPill>
      <span className="text-muted">{children}</span>
    </span>
  );
}

/** One fact the server was started with; `state` adds an on/off dot, so it is not read from the words alone. */
function Fact({ icon: Icon, state, children }: { icon: LucideIcon; state?: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-sm text-text">
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
      <span className="min-w-0">{children}</span>
      {state !== undefined && <span aria-hidden="true" className={state ? "h-1.5 w-1.5 shrink-0 rounded-full bg-success" : "h-1.5 w-1.5 shrink-0 rounded-full bg-subtle"} />}
    </li>
  );
}

/** What the hourly platform tick did last — the full account is on System health. */
function LastTick({ tick, by }: { tick: TickSummary | null; by: string | null }) {
  const count = (slugs: string[]) => `${slugs.length.toLocaleString("en-IN")}${slugs.length >= 20 ? "+" : ""}`;
  return (
    <div className="border-t border-line px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium text-text">Last platform tick</h3>
        <Link href="/health#last-tick" className={`${LINK} text-xs`}>
          Details on System health
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        </Link>
      </div>
      {tick ? (
        <>
          <p className="mt-1 text-sm text-text">
            {"Finished "}
            <RelativeTime at={tick.at} />
            {` · took ${durationText(tick.ms)} · ${tick.by === "tick" ? "run by the scheduler" : `started by ${by ?? "a staff member"} from the console`}`}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {`${count(tick.held)} held · ${count(tick.lifted)} lifted · ${count(tick.closed)} closed · ${plural(tick.reminded, "reminder")} sent${tick.daily ? " · daily chores done" : ""}`}
          </p>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted">No run recorded yet. The scheduler should call /api/platform/tick every hour.</p>
      )}
    </div>
  );
}

/** Where each type of mail goes now, in one line each. */
function MailSummary({ mail }: { mail: Awaited<ReturnType<typeof mailSetup>> }) {
  const name = (id: string | null) => (id ? (mail.connections.find((c) => c.id === id)?.name ?? null) : null);
  const base = mail.routes.find((r) => r.stream === "DEFAULT")?.connectionId ?? null;
  const fallback = mail.serverFallback ? "the server setting (PLATFORM_SMTP_URL)" : "nowhere — written to platform-outbox/";
  return (
    <DefinitionList
      columns={1}
      items={MAIL_STREAMS.map((s) => {
        const own = mail.routes.find((r) => r.stream === s.key)?.connectionId ?? null;
        const through = name(own) ?? (s.key === "DEFAULT" ? null : name(base));
        return {
          term: s.label,
          value: through ? (
            <Stated tone="success" label={through}>
              {own || s.key === "DEFAULT" ? "Its own account." : "The default's account."}
            </Stated>
          ) : (
            <Stated tone={mail.serverFallback ? "info" : "warning"} label="No account">
              {`Sent through ${fallback}.`}
            </Stated>
          ),
        };
      })}
    />
  );
}

/** The most recently written of these settings. */
function newest(list: (SettingRow | null)[]): SettingRow | null {
  let found: SettingRow | null = null;
  for (const r of list) {
    if (r?.updatedAt && (!found?.updatedAt || r.updatedAt.getTime() > found.updatedAt.getTime())) found = r;
  }
  return found;
}

function changeOf(r: SettingRow | null): SettingChange | null {
  return r?.updatedAt ? { by: r.updatedByName, at: r.updatedAt } : null;
}

/**
 * Linked sign-in's switch, read fresh, and who last set it: a staff member by name, or the script
 * (`script:linked-sign-in`) as its command. It is not one of settingsOverview's keys, so the name is
 * looked up here.
 */
async function automateState(): Promise<{ running: boolean; change: SettingChange | null }> {
  // Unreadable (the console still works without it): shown as running, as the worker reads it fresh anyway.
  const setting = await platformPause().catch(() => ({ paused: false, updatedBy: null, updatedAt: null }));
  if (!setting.updatedAt) return { running: !setting.paused, change: null };
  const name = setting.updatedBy ? ((await controlDb().platformUser.findUnique({ where: { id: setting.updatedBy }, select: { name: true } }))?.name ?? "a former staff member") : null;
  return { running: !setting.paused, change: { by: name, at: setting.updatedAt } };
}

async function linkedSignInState(): Promise<{ enabled: boolean; change: SettingChange | null }> {
  const setting = await linkedSignInSetting();
  if (!setting.updatedAt) return { enabled: setting.enabled, change: null };
  const by = setting.updatedBy;
  let name: string | null = null;
  if (by?.includes(":")) name = actorLabel("SCRIPT", by, new Map());
  else if (by) name = (await controlDb().platformUser.findUnique({ where: { id: by }, select: { name: true } }))?.name ?? "a former staff member";
  return { enabled: setting.enabled, change: { by: name, at: setting.updatedAt } };
}
