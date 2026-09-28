import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Check, CircleAlert } from "lucide-react";
import { CopyField } from "@/components/console/kit/copy-field";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill, TONE_TEXT } from "@/components/console/kit/status";
import { durationText, plural } from "@/lib/console-shared/format";
import type { GatewayMode, Tone } from "@/lib/console-shared/types";
import type { BillingOverviewData } from "@/lib/platform/console-data";
import type { TickSummary } from "@/lib/platform/tick-summary";
import { cn } from "@/lib/utils";
import { LifecycleRunButton } from "./lifecycle-run";

/**
 * Whether each gateway can reach the platform, and the scheduler that runs billing every hour.
 *
 * Keys are never shown — not even a prefix: each is a chip saying set or not set, and the mode
 * ("Test mode") is worked out on the server from the key. What an operator copies into a gateway's
 * dashboard (the webhook address, the events to send) is printed as text, so it can be read, selected
 * and checked against what the gateway has. Keys are changed on Settings, by an owner.
 */

const MODE: Record<"test" | "live" | "unknown" | "none", { label: string; tone: Tone }> = {
  live: { label: "Live mode", tone: "success" },
  test: { label: "Test mode", tone: "info" },
  unknown: { label: "Unknown mode", tone: "warning" },
  none: { label: "Not set up", tone: "neutral" },
};

type GatewayCardData = {
  name: "Stripe" | "Razorpay";
  param: "STRIPE" | "RAZORPAY";
  mode: GatewayMode;
  keys: { label: string; set: boolean }[];
  signingSet: boolean;
  webhook: string;
  events: string[];
  lastEvent: Date | null;
  failing: number;
};

export function GatewayConnections({
  data,
  owner,
  manage = false,
  tickBy = null,
}: {
  data: BillingOverviewData;
  owner: boolean;
  /** Managers may run the billing lifecycle now; nobody else sees the button. */
  manage?: boolean;
  /** The name of the staff member who started the last run, when it was not the scheduler. */
  tickBy?: string | null;
}) {
  const s = data.secrets;
  const gateways: GatewayCardData[] = [
    {
      name: "Stripe",
      param: "STRIPE",
      mode: data.modes.stripe,
      keys: [
        { label: "Secret key", set: s["stripe.secretKey"] },
        { label: "Webhook signing secret", set: s["stripe.webhookSecret"] },
      ],
      signingSet: s["stripe.webhookSecret"],
      webhook: data.webhooks.stripe,
      // Refunds and credit notes too: partner commission on money that went back is reversed.
      events: ["checkout.session.completed", "customer.subscription.*", "invoice.*", "charge.refunded", "credit_note.*"],
      lastEvent: data.lastEvent.stripe,
      failing: data.failingByGateway.stripe,
    },
    {
      name: "Razorpay",
      param: "RAZORPAY",
      mode: data.modes.razorpay,
      keys: [
        { label: "Key id", set: s["razorpay.keyId"] },
        { label: "Key secret", set: s["razorpay.keySecret"] },
        { label: "Webhook signing secret", set: s["razorpay.webhookSecret"] },
      ],
      signingSet: s["razorpay.webhookSecret"],
      webhook: data.webhooks.razorpay,
      events: ["subscription.*", "payment.refunded", "refund.processed"],
      lastEvent: data.lastEvent.razorpay,
      failing: data.failingByGateway.razorpay,
    },
  ];

  return (
    <section aria-labelledby="gateway-connections-title" id="gateway-connections" className="scroll-mt-20 space-y-3">
      <div>
        <h2 id="gateway-connections-title" className="text-sm font-semibold text-text">
          Gateway connections
        </h2>
        <p className="mt-0.5 text-xs text-muted">
          Workspaces in India pay through Razorpay in rupees; everywhere else through Stripe. Keys show only as set or not set.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {gateways.map((g) => (
          <GatewayCard key={g.param} gateway={g} owner={owner} />
        ))}
        <SchedulerCard tickUrl={data.webhooks.tick} tick={data.lastTick} tickBy={tickBy} manage={manage} />
      </div>
    </section>
  );
}

/** A labelled block inside a card: a small caption over its value. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-1 min-w-0 text-sm text-text">{children}</div>
    </div>
  );
}

function KeyChip({ label, set }: { label: string; set: boolean }) {
  return (
    <StatusPill
      tone={set ? "success" : "warning"}
      icon={set ? <Check className="h-3 w-3" /> : <CircleAlert className="h-3 w-3" />}
    >
      {`${label} ${set ? "set" : "not set"}`}
    </StatusPill>
  );
}

/** One sentence on what a missing key stops — only when one is missing. */
function readiness(g: GatewayCardData): { text: string; tone: Tone } | null {
  const missing = g.keys.filter((k) => !k.set);
  if (missing.length === 0) return null;
  if (missing.length === g.keys.length) return { text: `Not set up — no workspace can pay through ${g.name} yet.`, tone: "neutral" };
  if (!g.signingSet) return { text: `Its webhooks are turned away until the signing secret is set, so payments made there don't reach the platform.`, tone: "warning" };
  return { text: `Checkouts can't start until every key is set.`, tone: "warning" };
}

function GatewayCard({ gateway: g, owner }: { gateway: GatewayCardData; owner: boolean }) {
  const mode = MODE[g.mode ?? "none"];
  const note = readiness(g);
  return (
    <Panel
      headingLevel={3}
      title={g.name}
      actions={
        <StatusPill tone={mode.tone} dot>
          {mode.label}
        </StatusPill>
      }
      footer={
        owner ? (
          <Link href="/settings#gateways" className="inline-flex items-center gap-1 rounded-base font-medium text-brand hover:underline">
            Manage keys
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        ) : (
          "Only an owner changes keys."
        )
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <ul aria-label={`${g.name} keys`} className="flex flex-wrap gap-1.5">
            {g.keys.map((k) => (
              <li key={k.label}>
                <KeyChip label={k.label} set={k.set} />
              </li>
            ))}
          </ul>
          {note && <p className={cn("text-xs", TONE_TEXT[note.tone])}>{note.text}</p>}
        </div>

        <Field label="Webhook endpoint">
          <CopyField value={g.webhook} label={`${g.name} webhook URL`} />
        </Field>

        <Field label="Events to send">
          <ul className="flex flex-wrap gap-1.5">
            {g.events.map((e) => (
              <li key={e}>
                <code className="rounded-md border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-text">{e}</code>
              </li>
            ))}
          </ul>
        </Field>

        <div className="grid grid-cols-2 gap-4 border-t border-line pt-3">
          <Field label="Last event received">
            {g.lastEvent ? <RelativeTime at={g.lastEvent} /> : <span className="text-muted">Nothing yet</span>}
          </Field>
          <Field label="Failing">
            {g.failing > 0 ? (
              <Link
                href={`/billing?tab=events&gateway=${g.param}&state=failed`}
                className="font-medium text-danger tabular-nums hover:underline"
              >
                {plural(g.failing, "webhook")}
              </Link>
            ) : (
              <span className="text-muted">None</span>
            )}
          </Field>
        </div>
      </div>
    </Panel>
  );
}

/** The slug lists in a tick summary keep the first twenty; the audit log has every one. */
const listed = (slugs: string[]) => (slugs.length >= 20 ? "20+" : String(slugs.length));

function SchedulerCard({ tickUrl, tick, tickBy, manage }: { tickUrl: string; tick: TickSummary | null; tickBy: string | null; manage: boolean }) {
  const by = tick ? (tick.by === "tick" ? "the scheduler" : (tickBy ?? "a staff member")) : null;
  return (
    <Panel
      headingLevel={3}
      title="Scheduler"
      // Two gateway cards side by side, the scheduler under them; three across on wide screens.
      className="md:col-span-2 xl:col-span-1"
      description="Runs the billing lifecycle every hour, and the daily chores once a day."
      footer={
        <Link href="/health" className="inline-flex items-center gap-1 rounded-base font-medium text-brand hover:underline">
          System health
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      }
    >
      <div className="space-y-4">
        <Field label="Tick URL">
          <CopyField value={tickUrl} label="tick URL" />
        </Field>
        <Field label="Call it every hour with this header">
          <CopyField value="Authorization: Bearer $PLATFORM_TICK_SECRET" label="authorization header" />
        </Field>

        <div className="border-t border-line pt-3">
          <Field label="Last run">
            {tick ? (
              <div className="space-y-2">
                <p>
                  <RelativeTime at={tick.at} />
                  <span className="text-muted">{` · by ${by} · took ${durationText(tick.ms)}`}</span>
                </p>
                <ul aria-label="What the last run did" className="flex flex-wrap gap-1.5">
                  <li>
                    <StatusPill tone={tick.held.length > 0 ? "warning" : "neutral"} title={tick.held.join(", ") || undefined}>
                      {`${listed(tick.held)} held`}
                    </StatusPill>
                  </li>
                  <li>
                    <StatusPill tone={tick.lifted.length > 0 ? "success" : "neutral"} title={tick.lifted.join(", ") || undefined}>
                      {`${listed(tick.lifted)} lifted`}
                    </StatusPill>
                  </li>
                  <li>
                    <StatusPill tone={tick.closed.length > 0 ? "danger" : "neutral"} title={tick.closed.join(", ") || undefined}>
                      {`${listed(tick.closed)} closed`}
                    </StatusPill>
                  </li>
                  <li>
                    <StatusPill tone={tick.reminded > 0 ? "info" : "neutral"}>{`${tick.reminded} reminded`}</StatusPill>
                  </li>
                </ul>
                <p className="text-xs text-muted">
                  {tick.daily ? (
                    <>
                      {`Daily chores: ${plural(tick.daily.reconciled, "subscription")} read back, ${plural(tick.daily.usage, "usage snapshot")}, ${plural(tick.daily.revenue, "revenue snapshot")}`}
                      {tick.daily.failed > 0 && <span className="text-danger">{` · ${tick.daily.failed} failed`}</span>}
                    </>
                  ) : (
                    "No daily chores on this run."
                  )}
                </p>
              </div>
            ) : (
              <span className="text-muted">No run recorded yet — the scheduler may not be set up.</span>
            )}
          </Field>
        </div>

        {manage && (
          <div className="space-y-2 border-t border-line pt-3">
            <p className="text-xs text-muted">Don&apos;t want to wait for the next tick? Run the same billing checks now — you&apos;ll see who they affect first.</p>
            <LifecycleRunButton />
          </div>
        )}
      </div>
    </Panel>
  );
}
