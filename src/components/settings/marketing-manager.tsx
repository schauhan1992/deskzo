"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Info, ShieldCheck } from "lucide-react";
import type { Organisation } from "@/lib/organisation";
import type { listProviders, checkSenderDomain } from "@/actions/messaging-provider";
import { saveProvider, verifyProvider, checkSenderDomain as runDomainCheck } from "@/actions/messaging-provider";
import { updateMarketingSettings } from "@/actions/organisation";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatMinute } from "@/lib/marketing/schedule";
import { formatRegisteredAddress } from "@/lib/marketing/footer";

type Providers = Awaited<ReturnType<typeof listProviders>>;
type DomainCheck = Extract<Awaited<ReturnType<typeof checkSenderDomain>>, { ok: true }>["data"];

const HOURS = Array.from({ length: 24 }, (_, h) => h * 60);

/**
 * Where marketing goes out from, and when.
 *
 * The routing is the consequential part and the least obvious: a provider only carries the classes
 * it is given, which is what keeps bulk off the domain the invoices go out from. Get that wrong and
 * a campaign nobody liked takes the purchase orders down with it, weeks later, silently.
 */
export function MarketingManager({
  organisation,
  providers,
  webhookUrl,
}: {
  organisation: Organisation;
  providers: Providers;
  /** Where providers send delivery reports — this workspace's address and secret. */
  webhookUrl: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [domain, setDomain] = useState<DomainCheck | null>(null);
  // What the footer falls back to when the override is blank, shown as the placeholder so the
  // field reads as 'already handled' rather than 'empty and therefore broken'.
  const registered = formatRegisteredAddress(organisation);
  const [domainError, setDomainError] = useState<string | null>(null);

  const [form, setForm] = useState({
    marketingFromDomain: organisation.marketingFromDomain ?? "",
    marketingPostalAddress: organisation.marketingPostalAddress ?? "",
    marketingQuietStartMinute: String(organisation.marketingQuietStartMinute),
    marketingQuietEndMinute: String(organisation.marketingQuietEndMinute),
    marketingSkipNonWorkingDays: organisation.marketingSkipNonWorkingDays,
    marketingMaxPerContactPerWeek: String(organisation.marketingMaxPerContactPerWeek),
    marketingApprovalThreshold: String(organisation.marketingApprovalThreshold),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Mail providers</CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted">
            Each provider carries the kinds of message you give it. Keep transactional mail — invoices, quotes,
            password resets — on your primary domain, and send bulk from a subdomain: a campaign that annoys people
            should never be able to stop a purchase order arriving.
          </p>

          {providers.warning && (
            <Card className="border-warning/40 bg-warning-bg px-3 py-2.5 text-xs text-warning">
              <span className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{providers.warning}</span>
              </span>
            </Card>
          )}

          <div className="space-y-3">
            {providers.catalogue.map((definition) => {
              const row = providers.rows.find((r) => r.key === definition.key);
              return <ProviderCard key={definition.key} definition={definition} row={row} />;
            })}
          </div>

          <div className="border-t border-line pt-3 text-sm text-muted">
            <p>
              <span className="font-medium text-text">Delivery reports.</span> So bounces and complaints stop the next
              campaign reaching a dead address, set the provider&apos;s webhook to this address, with the provider&apos;s
              name in place of <code className="font-mono text-xs">&lt;provider&gt;</code>. The key in it is this
              workspace&apos;s own — keep it out of anything public.
            </p>
            <code className="mt-2 block break-all rounded bg-surface-sunken px-2 py-1.5 font-mono text-xs text-text">{webhookUrl}</code>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Sending domain</CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fromDomain">Marketing goes out from</Label>
            <Input
              id="fromDomain"
              value={form.marketingFromDomain}
              onChange={set("marketingFromDomain")}
              placeholder="mail.acme.com"
              className="font-mono text-xs"
            />
            <p className="text-xs text-subtle">
              A subdomain, kept apart from the one your invoices leave from.
            </p>
          </div>

          <div>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setDomainError(null);
                startTransition(async () => {
                  const result = await runDomainCheck();
                  if (!result.ok) {
                    setDomainError(result.error);
                    setDomain(null);
                    return;
                  }
                  setDomain(result.data);
                });
              }}
            >
              <ShieldCheck className="mr-1.5 h-3 w-3" />
              {pending ? "Looking it up…" : "Check SPF, DKIM and DMARC"}
            </Button>
            {domainError && <p className="mt-2 text-xs text-danger">{domainError}</p>}
          </div>

          {domain && (
            <div className="space-y-2 rounded-lg bg-surface-sunken px-3 py-3">
              <p className="font-mono text-xs text-text">{domain.domain}</p>
              <div className="flex flex-wrap gap-2">
                <Badge tone={domain.spf ? "green" : "red"}>SPF {domain.spf ? "found" : "missing"}</Badge>
                <Badge tone={domain.dkim ? "green" : "red"}>DKIM {domain.dkim ? "found" : "missing"}</Badge>
                <Badge tone={domain.dmarc ? (domain.dmarcPolicy === "none" ? "amber" : "green") : "red"}>
                  DMARC {domain.dmarc ? `p=${domain.dmarcPolicy ?? "?"}` : "missing"}
                </Badge>
                <Badge tone={domain.mx > 0 ? "green" : "red"}>{domain.mx} MX</Badge>
              </div>
              {domain.problems.length === 0 ? (
                <p className="flex items-center gap-1.5 text-xs text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Nothing to fix. Mail from here should be believed.
                </p>
              ) : (
                <ul className="space-y-1">
                  {domain.problems.map((p) => (
                    <li key={p} className="flex items-start gap-1.5 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">When, and how often</CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="quietStart">Quiet from</Label>
              <Select id="quietStart" value={form.marketingQuietStartMinute} onChange={set("marketingQuietStartMinute")}>
                {HOURS.map((m) => (
                  <option key={m} value={m}>
                    {formatMinute(m)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="quietEnd">Until</Label>
              <Select id="quietEnd" value={form.marketingQuietEndMinute} onChange={set("marketingQuietEndMinute")}>
                {HOURS.map((m) => (
                  <option key={m} value={m}>
                    {formatMinute(m)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <p className="text-xs text-subtle">
            Nothing marketing goes out between these, in Indian time. Setting them the same removes the restriction
            entirely.
          </p>

          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={form.marketingSkipNonWorkingDays}
              onChange={(e) => {
                setSaved(false);
                setForm((f) => ({ ...f, marketingSkipNonWorkingDays: e.target.checked }));
              }}
              className="mt-0.5 h-4 w-4 accent-brand"
            />
            <span>
              <span className="block text-sm text-text">Skip weekends and company holidays</span>
              <span className="block text-xs text-subtle">
                Uses the same holiday calendar as HR. Restricted holidays don&apos;t count — the office is open.
              </span>
            </span>
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cap">Most a contact hears from us</Label>
              <Input
                id="cap"
                type="number"
                min={0}
                value={form.marketingMaxPerContactPerWeek}
                onChange={set("marketingMaxPerContactPerWeek")}
              />
              <p className="text-xs text-subtle">
                Per week, across every campaign and journey at once. 0 removes the cap. This is the only thing
                standing between four reasonable campaigns and one customer hearing from us four times in a morning.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="threshold">Approval needed above</Label>
              <Input
                id="threshold"
                type="number"
                min={1}
                value={form.marketingApprovalThreshold}
                onChange={set("marketingApprovalThreshold")}
              />
              <p className="text-xs text-subtle">
                Recipients. Above this a second person has to sign it off, and never the person who built it.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="postal">Postal address for the footer</Label>
            <Textarea
              id="postal"
              rows={3}
              value={form.marketingPostalAddress}
              onChange={set("marketingPostalAddress")}
              placeholder={registered ?? "Acme Technologies Pvt Ltd, …"}
            />
            <p className="text-xs text-subtle">
              Printed at the bottom of every marketing email — most providers require one.{" "}
              {registered
                ? "Leave it blank and your registered office is used, which is almost always what you want. Fill it in only if marketing should carry a different address."
                : "There is no registered address on file to fall back on, so this one is doing the work — fill it in, or complete the organisation details above."}
            </p>
          </div>

          <Card className="border-info/40 bg-info-bg px-3 py-2.5 text-xs text-info">
            <span className="flex items-start gap-1.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Nothing sends unless something outside the app calls{" "}
                <span className="font-mono">/api/marketing/tick</span> every few minutes, with{" "}
                <span className="font-mono">MARKETING_TICK_SECRET</span> as a bearer token. The marketing page warns
                when it has stopped.
              </span>
            </span>
          </Card>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex items-center gap-3">
            <Button
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await updateMarketingSettings({
                    marketingFromDomain: form.marketingFromDomain,
                    marketingPostalAddress: form.marketingPostalAddress,
                    marketingQuietStartMinute: Number(form.marketingQuietStartMinute),
                    marketingQuietEndMinute: Number(form.marketingQuietEndMinute),
                    marketingSkipNonWorkingDays: form.marketingSkipNonWorkingDays,
                    marketingMaxPerContactPerWeek: Number(form.marketingMaxPerContactPerWeek),
                    marketingApprovalThreshold: Number(form.marketingApprovalThreshold),
                  });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setSaved(true);
                  router.refresh();
                });
              }}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
            {saved && <span className="text-xs text-success">Saved.</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ProviderCard({
  definition,
  row,
}: {
  definition: Providers["catalogue"][number];
  row: Providers["rows"][number] | undefined;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [state, setState] = useState({
    enabled: row?.enabled ?? false,
    priority: String(row?.priority ?? 100),
    classes: new Set(row?.classes ?? []),
    fromName: row?.fromName ?? "",
    fromEmail: row?.fromEmail ?? "",
    replyTo: row?.replyTo ?? "",
    secret: "",
    config: { ...(row?.config ?? {}) } as Record<string, string>,
  });

  const toggleClass = (cls: "MARKETING" | "TRANSACTIONAL") =>
    setState((s) => {
      const next = new Set(s.classes);
      if (next.has(cls)) next.delete(cls);
      else next.add(cls);
      return { ...s, classes: next };
    });

  return (
    <Card className="px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-text">{definition.label}</span>
          {row?.enabled ? <Badge tone="green">On</Badge> : <Badge tone="default">Off</Badge>}
          {row?.classes.map((c) => (
            <Badge key={c} tone="blue">
              {c.toLowerCase()}
            </Badge>
          ))}
          {row?.verifyOk === true && <Badge tone="green">Verified</Badge>}
          {row?.verifyOk === false && <Badge tone="red">Wouldn&apos;t connect</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {row && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setError(null);
                setNote(null);
                startTransition(async () => {
                  const result = await verifyProvider(definition.key);
                  if (!result.ok) setError(result.error);
                  else setNote(result.data.detail);
                  router.refresh();
                });
              }}
            >
              Test
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : row ? "Edit" : "Set up"}
          </Button>
        </div>
      </div>

      {row?.verifyDetail && !open && <p className="mt-1 text-[11px] text-subtle">{row.verifyDetail}</p>}
      {note && <p className="mt-1 text-[11px] text-success">{note}</p>}
      {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}

      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={state.enabled}
                onChange={(e) => setState((s) => ({ ...s, enabled: e.target.checked }))}
                className="h-4 w-4 accent-brand"
              />
              Switched on
            </label>
            {(["TRANSACTIONAL", "MARKETING"] as const).map((cls) => (
              <label key={cls} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={state.classes.has(cls)}
                  onChange={() => toggleClass(cls)}
                  className="h-4 w-4 accent-brand"
                />
                Carries {cls.toLowerCase()}
              </label>
            ))}
          </div>

          {definition.kind === "EMAIL" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${definition.key}-fromName`}>From name</Label>
                <Input
                  id={`${definition.key}-fromName`}
                  value={state.fromName}
                  onChange={(e) => setState((s) => ({ ...s, fromName: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${definition.key}-fromEmail`}>From address</Label>
                <Input
                  id={`${definition.key}-fromEmail`}
                  value={state.fromEmail}
                  onChange={(e) => setState((s) => ({ ...s, fromEmail: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${definition.key}-replyTo`}>Reply-to</Label>
                <Input
                  id={`${definition.key}-replyTo`}
                  value={state.replyTo}
                  onChange={(e) => setState((s) => ({ ...s, replyTo: e.target.value }))}
                />
              </div>
            </div>
          )}

          {definition.needs.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {definition.needs.map((need) =>
                need.secret ? (
                  <div key={need.key} className="space-y-1.5">
                    <Label htmlFor={`${definition.key}-${need.key}`}>{need.label}</Label>
                    <Input
                      id={`${definition.key}-${need.key}`}
                      type="password"
                      value={state.secret}
                      onChange={(e) => setState((s) => ({ ...s, secret: e.target.value }))}
                      placeholder={row?.hasSecret ? "Saved — leave blank to keep it" : ""}
                      autoComplete="off"
                    />
                    {need.hint && <p className="text-xs text-subtle">{need.hint}</p>}
                  </div>
                ) : (
                  <div key={need.key} className="space-y-1.5">
                    <Label htmlFor={`${definition.key}-${need.key}`}>{need.label}</Label>
                    <Input
                      id={`${definition.key}-${need.key}`}
                      value={state.config[need.key] ?? ""}
                      onChange={(e) =>
                        setState((s) => ({ ...s, config: { ...s.config, [need.key]: e.target.value } }))
                      }
                    />
                    {need.hint && <p className="text-xs text-subtle">{need.hint}</p>}
                  </div>
                ),
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`${definition.key}-priority`}>Order</Label>
            <Input
              id={`${definition.key}-priority`}
              type="number"
              className="max-w-24"
              value={state.priority}
              onChange={(e) => setState((s) => ({ ...s, priority: e.target.value }))}
            />
            <p className="text-xs text-subtle">
              Lower goes first. If one fails in a way worth retrying, the next one on the list takes it.
            </p>
          </div>

          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await saveProvider({
                  key: definition.key,
                  enabled: state.enabled,
                  priority: Number(state.priority),
                  classes: [...state.classes] as ("MARKETING" | "TRANSACTIONAL")[],
                  fromName: state.fromName,
                  fromEmail: state.fromEmail,
                  replyTo: state.replyTo,
                  config: state.config,
                  secret: state.secret,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setOpen(false);
                router.refresh();
              });
            }}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </Card>
  );
}
