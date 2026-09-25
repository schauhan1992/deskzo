"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import type { Role } from "@/lib/roles";
import { updateSecurityPolicy } from "@/actions/security-policy";
import type { SecurityPolicyShape } from "@/lib/security/policy";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * The DLP settings screen.
 *
 * The organising idea is the two headings: **Enforced** and **Deterrent**. Every control in this
 * module falls into one or the other, and an admin who cannot tell which is which will make bad
 * decisions with it — switching on copy-blocking and believing the data is now safe is strictly
 * worse than leaving it off and knowing it is not, because it buys confidence rather than security.
 *
 * So the distinction is the first thing on the page rather than a footnote at the bottom.
 */

const ROLES: Role[] = ["MANAGEMENT", "SALES", "SUPPORT", "ACCOUNTS", "PURCHASE", "CALLING", "PROFILE"];

function Toggle({
  checked,
  onChange,
  title,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  /** Optional: a few of these need no explanation beyond their own title. */
  children?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2.5 py-2 ${disabled ? "opacity-50" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0"
      />
      <span>
        <span className="block text-sm font-medium text-text">{title}</span>
        <span className="block text-sm text-muted">{children}</span>
      </span>
    </label>
  );
}

export function SecurityPolicyForm({ policy }: { policy: SecurityPolicyShape }) {
  const router = useRouter();
  const [form, setForm] = useState<SecurityPolicyShape>(policy);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof SecurityPolicyShape>(key: K, value: SecurityPolicyShape[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  const toggleRole = (role: Role) =>
    set("exemptRoles", form.exemptRoles.includes(role) ? form.exemptRoles.filter((r) => r !== role) : [...form.exemptRoles, role]);

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateSecurityPolicy(form);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      {saved && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">Security policy saved.</p>}

      <Card className="border-warning/40 bg-warning-bg">
        <CardContent className="space-y-2 py-3 text-sm text-warning">
          <p className="flex items-center gap-2 font-medium">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            Two kinds of control on this page, and they are not equally strong
          </p>
          <p>
            <strong>Enforced</strong> settings run on the server and hold whatever the browser does — export limits,
            read-volume alerts and crawler blocking. <strong>Deterrent</strong> settings run in the user&rsquo;s browser
            and can be switched off by anyone who opens developer tools. They stop the careless copy and they create a
            record of the deliberate one, which is genuinely worth having — but no web application can stop a
            screenshot, a phone camera, or somebody who is determined. Turn them on knowing which you are getting.
          </p>
        </CardContent>
      </Card>

      {/* ----------------------------------------------------------------- Enforced */}
      <Card>
        <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
          <ShieldCheck className="h-4 w-4 text-success" />
          Enforced on the server
        </CardHeader>
        <CardContent className="divide-y divide-line">
          <Toggle checked={form.blockBots} onChange={(v) => set("blockBots", v)} title="Block crawlers and scrapers">
            Turns away search engine crawlers, SEO tools, and scripts like curl and headless browsers. Uptime monitors
            are always allowed so alerting does not break.
          </Toggle>

          <Toggle
            checked={form.blockAiCrawlers}
            onChange={(v) => set("blockAiCrawlers", v)}
            title="Block AI and LLM crawlers"
          >
            GPTBot, ClaudeBot, CCBot, Google-Extended, PerplexityBot, Bytespider and the rest, plus a{" "}
            <code className="rounded bg-surface-sunken px-1 text-xs">robots.txt</code> that names them. These ones
            identify themselves honestly and obey what they are told — which is exactly why naming them works.
          </Toggle>

          <div className="py-3">
            <Label htmlFor="sp-botmode">When a crawler is recognised</Label>
            <select
              id="sp-botmode"
              value={form.botMode}
              onChange={(e) => set("botMode", e.target.value as "BLOCK" | "LOG")}
              className="mt-1.5 h-9 w-full rounded-base border border-line-strong bg-surface px-2 text-sm text-text sm:w-72"
            >
              <option value="BLOCK">Refuse the request and log it</option>
              <option value="LOG">Let it through, but log it</option>
            </select>
            <p className="mt-1 text-sm text-muted">
              Log-only is for finding out what is actually hitting the site before you start turning things away.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 py-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="sp-exportlimit">Export row limit</Label>
              <Input
                id="sp-exportlimit"
                type="number"
                min={0}
                value={form.exportRowLimit}
                onChange={(e) => set("exportRowLimit", Number(e.target.value))}
                className="mt-1.5"
              />
              <p className="mt-1 text-sm text-muted">
                The largest file anyone can download in one go. 0 removes the cap. Applied where the rows are fetched,
                so it holds however the request was made.
              </p>
            </div>
            <div>
              <Label htmlFor="sp-bulk">Unusual read volume — records</Label>
              <Input
                id="sp-bulk"
                type="number"
                min={0}
                value={form.bulkReadThreshold}
                onChange={(e) => set("bulkReadThreshold", Number(e.target.value))}
                className="mt-1.5"
              />
              <p className="mt-1 text-sm text-muted">
                Records read within the window before admins are told. This is the one control a browser extension
                cannot get around — whatever is collecting the data still has to ask the server for it. It alerts
                rather than blocks, because a month-end reconciliation looks identical.
              </p>
            </div>
            <div>
              <Label htmlFor="sp-window">…within this many minutes</Label>
              <Input
                id="sp-window"
                type="number"
                min={1}
                max={1440}
                value={form.bulkReadWindowMinutes}
                onChange={(e) => set("bulkReadWindowMinutes", Number(e.target.value))}
                className="mt-1.5 sm:max-w-40"
              />
            </div>
            <div>
              <Label htmlFor="sp-retention">Keep activity logs for (days)</Label>
              <Input
                id="sp-retention"
                type="number"
                min={30}
                max={3650}
                value={form.retentionDays}
                onChange={(e) => set("retentionDays", Number(e.target.value))}
                className="mt-1.5 sm:max-w-40"
              />
              <p className="mt-1 text-sm text-muted">
                Minimum 30. Short enough to lose last month&rsquo;s incident is not a retention policy, and the DPDP Act
                expects you to be able to show what happened to personal data.
              </p>
            </div>
          </div>

          <Toggle
            checked={form.exportRequiresReason}
            onChange={(v) => set("exportRequiresReason", v)}
            title="Ask for a reason before exporting"
          >
            A one-line note recorded with the export. Mostly useful because typing &ldquo;taking the customer list
            home&rdquo; is harder than clicking Download.
          </Toggle>

          <Toggle checked={form.logPageViews} onChange={(v) => set("logPageViews", v)} title="Log every page view">
            Off by default: it is a row per navigation and rarely the row you want. Record views, exports and refusals
            are always logged regardless.
          </Toggle>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- Deterrent */}
      <Card>
        <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
          <ShieldAlert className="h-4 w-4 text-warning" />
          Deterrent, in the browser
        </CardHeader>
        <CardContent className="divide-y divide-line">
          <Toggle checked={form.blockCopy} onChange={(v) => set("blockCopy", v)} title="Block copying">
            The one worth having: copying out of the app is how data usually leaves. Every refusal is logged.
          </Toggle>
          <Toggle checked={form.blockCut} onChange={(v) => set("blockCut", v)} title="Block cutting" />
          <Toggle checked={form.blockPaste} onChange={(v) => set("blockPaste", v)} title="Block pasting">
            Worth knowing before you switch this on: pasting brings data <em>in</em>, so it does little for leakage and
            mostly inconveniences your own staff. Pasting into a form field stays allowed regardless, or nobody could
            paste an order number into a search box.
          </Toggle>
          <Toggle
            checked={form.blockTextSelection}
            onChange={(v) => set("blockTextSelection", v)}
            title="Block selecting text"
          >
            Fields you type in stay selectable.
          </Toggle>
          <Toggle
            checked={form.blockContextMenu}
            onChange={(v) => set("blockContextMenu", v)}
            title="Block the right-click menu"
          />
          <Toggle checked={form.blockPrint} onChange={(v) => set("blockPrint", v)} title="Block printing">
            Invoices and other documents under the print views still print — this covers the app screens.
          </Toggle>
          <Toggle
            checked={form.blockDevTools}
            onChange={(v) => set("blockDevTools", v)}
            title="Report developer tools"
          >
            Cannot actually prevent them — nothing in a browser can. It notices the window geometry changing and logs
            it, and it gives false positives on an undocked panel or a zoom change.
          </Toggle>
          <Toggle
            checked={form.blurOnBlur}
            onChange={(v) => set("blurOnBlur", v)}
            title="Hide the screen when the window is not in front"
          >
            Aimed at screen sharing and shoulder surfing rather than at attackers.
          </Toggle>

          <div className="grid grid-cols-1 gap-4 py-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="sp-shots">Screenshots allowed per day</Label>
              <Input
                id="sp-shots"
                type="number"
                min={-1}
                max={50}
                value={form.screenshotLimitPerDay}
                onChange={(e) => set("screenshotLimitPerDay", Number(e.target.value))}
                className="mt-1.5 sm:max-w-40"
              />
              <p className="mt-1 text-sm text-muted">
                <strong>-1</strong> unlimited, <strong>0</strong> none. Be clear about what this does: the PrintScreen
                key and the macOS shortcuts are detected and counted, and the clipboard is wiped straight afterwards.
                Windows <kbd>Win+Shift+S</kbd>, the Snipping Tool and a phone camera never reach the page at all. Treat
                the number as &ldquo;attempts we saw&rdquo; and rely on the watermark below for the rest.
              </p>
            </div>
            <div className="space-y-3">
              <Toggle
                checked={form.screenshotNotifyAdmins}
                onChange={(v) => set("screenshotNotifyAdmins", v)}
                title="Tell admins about every screenshot"
              >
                Not only the ones over the limit. Throttled to one notification per person per hour.
              </Toggle>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 py-3 sm:grid-cols-2">
            <Toggle
              checked={form.watermarkEnabled}
              onChange={(v) => set("watermarkEnabled", v)}
              title="Watermark every screen with the viewer's name"
            >
              The only measure here that survives a photograph of the monitor — it does not stop the capture, it makes
              the capture name its own source. If you switch on one thing on this page, this is a good candidate.
            </Toggle>
            <div>
              <Label htmlFor="sp-opacity">Watermark strength (%)</Label>
              <Input
                id="sp-opacity"
                type="number"
                min={3}
                max={25}
                value={form.watermarkOpacity}
                disabled={!form.watermarkEnabled}
                onChange={(e) => set("watermarkOpacity", Number(e.target.value))}
                className="mt-1.5 sm:max-w-40"
              />
              <p className="mt-1 text-sm text-muted">7% is legible in a photo and easy to read past. Above 15 people start asking to turn it off.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------- Scope */}
      <Card>
        <CardHeader className="text-sm font-medium text-text">Who the deterrents apply to</CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted">
            Everyone except admins and the roles ticked here. Admins are always exempt and cannot be added — an admin
            who blocked their own clipboard could not paste a client secret into the field that turns it off again, and
            a control you can lock yourself out of is one that ends up disabled for everybody.
          </p>
          <div className="flex flex-wrap gap-2">
            {ROLES.map((role) => (
              <button
                key={role}
                type="button"
                onClick={() => toggleRole(role)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  form.exemptRoles.includes(role)
                    ? "border-brand bg-brand-subtle text-brand"
                    : "border-line-strong text-muted hover:bg-surface-sunken"
                }`}
              >
                {role.charAt(0) + role.slice(1).toLowerCase()}
                {form.exemptRoles.includes(role) && " — exempt"}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={save} disabled={isPending}>
          {isPending ? "Saving…" : "Save security policy"}
        </Button>
      </div>
    </div>
  );
}
