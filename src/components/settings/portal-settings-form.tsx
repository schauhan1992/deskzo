"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Globe } from "lucide-react";
import { savePortalSettings, type PortalSettingsView } from "@/actions/portal";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils";

/**
 * The two decisions, kept visibly apart.
 *
 * Who may sign in, and what they see once they have. They are laid out as separate cards because
 * they fail differently and get changed for different reasons — and because somebody widening
 * access should not have to scroll past six visibility switches to find the one they came for.
 */

type Draft = Omit<PortalSettingsView, "updatedAt" | "updatedByName" | "grantedCompanies" | "activeLogins">;

const SECTIONS: { key: keyof Draft; label: string; blurb: string }[] = [
  { key: "showSubscriptions", label: "Subscriptions and orders", blurb: "What they bought, how many licences, and when each one ends." },
  { key: "showInvoices", label: "Invoices", blurb: "Issued invoices, proformas and credit notes with their amounts and status. Drafts are never shown." },
  { key: "showPayments", label: "Payments received", blurb: "What they have paid us and when." },
  { key: "showTickets", label: "Support tickets", blurb: "Their own tickets and status. Never the assignee, the internal notes or the SLA state." },
  { key: "showAssets", label: "Hardware and warranties", blurb: "Machines we supplied, with warranty and AMC cover." },
  { key: "showContacts", label: "Their contacts as we hold them", blurb: "So they can tell you the list is out of date." },
];

const ACTIONS: { key: keyof Draft; label: string; blurb: string }[] = [
  { key: "allowRenewalRequest", label: "Ask to renew", blurb: "One click against a subscription. Raises a request, never an order." },
  { key: "allowSeatRequest", label: "Ask for more licences", blurb: "With a number. Again, a request — nothing is priced or committed." },
  { key: "allowQuestion", label: "Ask a question", blurb: "A free-text message to whoever owns the account." },
];

export function PortalSettingsForm({ settings }: { settings: PortalSettingsView }) {
  const [, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [draft, setDraft] = useState<Draft>({
    enabled: settings.enabled,
    access: settings.access,
    showSubscriptions: settings.showSubscriptions,
    showInvoices: settings.showInvoices,
    showPayments: settings.showPayments,
    showTickets: settings.showTickets,
    showAssets: settings.showAssets,
    showContacts: settings.showContacts,
    allowRenewalRequest: settings.allowRenewalRequest,
    allowSeatRequest: settings.allowSeatRequest,
    allowQuestion: settings.allowQuestion,
    linkValidityDays: settings.linkValidityDays,
    welcomeMessage: settings.welcomeMessage,
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    setSaving(true);
    setNotice(null);
    startTransition(async () => {
      const result = await savePortalSettings(draft);
      setSaving(false);
      setNotice(result.ok ? { text: "Saved." } : { text: result.error, bad: true });
    });
  };

  const check = (key: keyof Draft, label: string, blurb: string, disabled?: boolean) => (
    <label key={String(key)} className="flex items-start gap-2.5">
      <input
        type="checkbox"
        checked={Boolean(draft[key])}
        disabled={disabled}
        onChange={(e) => set(key, e.target.checked as Draft[typeof key])}
        className="mt-0.5 h-4 w-4"
      />
      <span>
        <span className="block text-sm font-medium text-text">{label}</span>
        <span className="block text-sm text-muted">{blurb}</span>
      </span>
    </label>
  );

  return (
    <div className="space-y-4">
      {notice && (
        <div
          className={
            notice.bad
              ? "rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger"
              : "rounded-base border border-success/40 bg-success-bg px-3 py-2 text-sm text-success"
          }
        >
          {notice.text}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-text">
              <Globe className="h-4 w-4 text-muted" />
              Who gets a portal
            </div>
            <div className="mt-0.5 text-xs text-muted">
              {settings.activeLogins} active link{settings.activeLogins === 1 ? "" : "s"} ·{" "}
              {settings.grantedCompanies} compan{settings.grantedCompanies === 1 ? "y" : "ies"} granted individually
              {settings.updatedAt && ` · last changed ${formatDateTime(settings.updatedAt)}`}
              {settings.updatedByName ? ` by ${settings.updatedByName}` : ""}
            </div>
          </div>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {check("enabled", "The customer portal is on", "Off, and no link works — whoever was granted what. This is the switch to reach for if anything ever looks wrong.")}

          <fieldset disabled={!draft.enabled} className="space-y-2 disabled:opacity-50">
            <legend className="text-sm font-medium text-text">Who may sign in</legend>
            <label className="flex items-start gap-2.5">
              <input
                type="radio"
                name="portal-access"
                checked={draft.access === "SELECTED"}
                onChange={() => set("access", "SELECTED")}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                <span className="block text-sm font-medium text-text">Only customers I choose</span>
                <span className="block text-sm text-muted">
                  Switch it on per customer from their own page. The safe one, and the one to start with.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <input
                type="radio"
                name="portal-access"
                checked={draft.access === "ALL"}
                onChange={() => set("access", "ALL")}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                <span className="block text-sm font-medium text-text">Every customer</span>
                <span className="block text-sm text-muted">
                  Anyone you have issued a link to can use it, without granting each customer separately. A customer
                  you have explicitly switched off stays off.
                </span>
              </span>
            </label>
          </fieldset>

          {draft.enabled && draft.access === "ALL" && (
            <p className="flex items-start gap-2 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {/*
                Said out loud because it is the one change here that widens who can read what, and
                the difference between "granted" and "has a link" is easy to lose track of.
              */}
              Every customer with a link will be able to open it. Resellers&rsquo; customers are still refused — their
              relationship belongs to the reseller.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="portal-validity">Links expire after</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="portal-validity"
                  type="number"
                  min={1}
                  max={3650}
                  placeholder="never"
                  value={draft.linkValidityDays ?? ""}
                  onChange={(e) => set("linkValidityDays", e.target.value ? Number(e.target.value) : null)}
                />
                <span className="text-sm text-muted">days</span>
              </div>
              <p className="text-xs text-muted">
                Blank means never. A link lives in somebody&rsquo;s inbox for years, so an expiry is what stops a
                former employee of your customer still reading their invoices.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="portal-welcome">Welcome note</Label>
              <Textarea
                id="portal-welcome"
                rows={3}
                placeholder="Any questions, call Priya on 022-1234 5678."
                value={draft.welcomeMessage ?? ""}
                onChange={(e) => set("welcomeMessage", e.target.value || null)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">What a customer can see</CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted">
            Applies to every customer. Deliberately not per customer: a hundred switches nobody audits is how one
            customer quietly ends up seeing something the others cannot.
          </p>
          {SECTIONS.map((s) => check(s.key, s.label, s.blurb, !draft.enabled))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">What a customer can ask for</CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted">
            Every one of these raises a request for somebody here to read. Nothing a customer does creates an order,
            a price or a commitment.
          </p>
          {ACTIONS.map((a) =>
            check(
              a.key,
              a.label,
              a.blurb,
              !draft.enabled || ((a.key === "allowRenewalRequest" || a.key === "allowSeatRequest") && !draft.showSubscriptions),
            ),
          )}
          {!draft.showSubscriptions && (draft.allowRenewalRequest || draft.allowSeatRequest) && (
            <p className="text-xs text-muted">
              Renewals and licence requests need subscriptions to be visible — a button to renew something the page
              won&rsquo;t show is one nobody can use.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
