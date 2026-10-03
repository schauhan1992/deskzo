import Link from "next/link";
import { getDomainSettings, type DomainSettingsView } from "@/actions/domains";
import { SettingsPage } from "@/components/settings/settings-page";
import { AddDomainForm, DomainRow, OwnAddress, type DomainItem } from "@/components/settings/domain-settings";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";

const LINK = "font-medium text-brand hover:underline";

/** Each address as the controls take it: plain text, dates already in words. */
function itemsOf(view: DomainSettingsView, clock: Clock): DomainItem[] {
  return view.domains.map((d) => ({
    id: d.id,
    host: d.host,
    kind: d.kind,
    status: d.status,
    isPrimary: d.isPrimary,
    statusText: d.statusText,
    tone: d.tone,
    records: d.records,
    apex: d.apex,
    url: d.url,
    lastChecked: d.lastCheckedAt ? `Last checked ${clock.dateTime(d.lastCheckedAt)}` : d.kind === "CUSTOM" ? "Not checked yet — create the records below, then press Check now." : null,
    problems: d.problems,
  }));
}

/**
 * Settings › Domain — the workspace at an address of its own (src/actions/domains.ts). Its owner's
 * page: its own address always, each custom one with its state in words, the two records to create,
 * Check now, Make primary and Remove; how many it may have; whether the platform offers them yet; and
 * where Microsoft sign-in's addresses go.
 */
export default async function DomainSettingsPage() {
  const view = await getDomainSettings();
  if (!view) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Custom domain</h1>
        <p className="mt-2 text-sm text-muted">Only the workspace owner manages its custom domain.</p>
      </div>
    );
  }

  const items = itemsOf(view, await workspaceClock());
  const ownPrimary = view.primaryHost === view.ownHost;
  const full = view.limit !== null && view.limit > 0 && !view.canAdd;

  return (
    <SettingsPage settingsKey="domain" description="Reach this workspace at an address of your own, like erp.yourcompany.com, as well as its own.">
      {!view.available ? (
        <Card className="px-5 py-4 text-sm text-muted">Custom domains need the platform&apos;s control plane, which this installation does not use.</Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
              <span>Addresses</span>
              <span className="text-xs font-normal text-muted">
                {view.limit === 0 ? (
                  <>
                    {view.allowanceText} —{" "}
                    <Link href="/settings/billing" className={LINK}>
                      Plan &amp; billing
                    </Link>
                  </>
                ) : (
                  view.allowanceText
                )}
              </span>
            </CardHeader>
            <ul className="divide-y divide-line">
              <OwnAddress host={view.ownHost} url={view.ownUrl} primary={ownPrimary} />
              {items.map((d) => (
                <DomainRow key={d.id} domain={d} ownHost={view.ownHost} />
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Add an address</CardHeader>
            <CardContent className="text-sm">
              {!view.offered ? (
                <p className="text-muted">
                  Custom domains aren&apos;t offered yet. When they are, you can add an address of your own here — until then the workspace is reached at{" "}
                  <span className="font-mono text-text">{view.ownHost}</span>.
                </p>
              ) : view.limit === 0 ? (
                <p className="text-muted">
                  Your plan doesn&apos;t include a custom domain. See{" "}
                  <Link href="/settings/billing" className={LINK}>
                    Plan &amp; billing
                  </Link>{" "}
                  for one that does.
                </p>
              ) : full ? (
                <p className="text-muted">{`${view.allowanceText} — remove one to add another, or see Plan & billing for more.`}</p>
              ) : (
                <div className="space-y-3">
                  <p className="text-muted">
                    You prove the address is yours with a TXT record, and point it at <span className="font-mono text-text">{view.target}</span>. It starts
                    working as soon as both check out.
                  </p>
                  <AddDomainForm devHint={process.env.NODE_ENV !== "production"} />
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="px-5 py-4 text-sm text-muted">
            Signing in with Microsoft, and sending from Outlook, need each address&apos;s redirect address added to your Microsoft app —{" "}
            <Link href="/settings/security" className={LINK}>
              they&apos;re listed under Security
            </Link>
            . People sign in separately at each address.
          </Card>
        </>
      )}
    </SettingsPage>
  );
}
