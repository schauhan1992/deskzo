"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { addCustomDomain, checkCustomDomain, clearCustomDomainPrimary, makeCustomDomainPrimary, removeCustomDomain } from "@/actions/domains";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

/**
 * Settings › Domain's controls (src/actions/domains.ts): adding an address, its two records with copy
 * buttons, Check now, Make primary and Remove — each change confirmed first where it changes what
 * people reach. Everything shown is worked out on the server and arrives as plain text; nothing here
 * decides a rule.
 */

export type DomainTone = "waiting" | "live" | "failing" | "stopped";

export type DomainItem = {
  id: string;
  host: string;
  /** LEGACY: an address kept from before workspaces — staff's to remove, needs no records. */
  kind: "CUSTOM" | "LEGACY";
  status: "PENDING" | "ACTIVE" | "BROKEN";
  isPrimary: boolean;
  statusText: string;
  tone: DomainTone;
  records: { type: "TXT" | "CNAME"; name: string; value: string }[];
  apex: boolean;
  url: string;
  /** "Last checked Thu, 1 Oct 2026, 3:04 pm", or null when never. */
  lastChecked: string | null;
  problems: string[];
};

const BADGE: Record<DomainTone, "amber" | "green" | "red"> = { waiting: "amber", live: "green", failing: "amber", stopped: "red" };

type Result = { ok: true; data?: unknown } | { ok: false; error: string };

/** One action at a time, its refusal kept to show, the page refreshed after it. */
function useRun() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  function run(work: () => Promise<Result>, after?: (r: Result & { ok: true }) => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const r = await work();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      after?.(r);
      router.refresh();
    });
  }
  function clear() {
    setError(null);
    setMessage(null);
  }
  return { pending, error, message, setMessage, run, clear };
}

// ─── Adding ──────────────────────────────────────────────────────────────────────────────────────

export function AddDomainForm({ devHint }: { devHint: boolean }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [value, setValue] = useState("");
  const { pending, error, run } = useRun();

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addCustomDomain(value), () => setValue(""));
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={id}>Address</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={id}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="erp.yourcompany.com"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={hintId}
            className="max-w-sm font-mono"
          />
          <Button type="submit" size="md" disabled={pending || !value.trim()}>
            {pending ? "Adding…" : "Add address"}
          </Button>
        </div>
        <p id={hintId} className="text-xs text-muted">
          A subdomain, like erp.yourcompany.com, works best. Many DNS providers can&apos;t point a bare domain (yourcompany.com) this way.
          {devHint && " In development, an address ending in .test is not looked up: Check now finds its records at once."}
        </p>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  );
}

// ─── The addresses ───────────────────────────────────────────────────────────────────────────────

/** The workspace's own address, always there — and the way back to it for links when another is primary. */
export function OwnAddress({ host, url, primary }: { host: string; url: string; primary: boolean }) {
  const { pending, error, run } = useRun();
  return (
    <li className="space-y-1 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <a href={url} className="font-mono text-sm break-all text-text hover:text-brand">
            {host}
          </a>
          <Badge tone="green">Live</Badge>
          {primary && <Badge tone="brand">Primary</Badge>}
        </span>
        {!primary && (
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run(clearCustomDomainPrimary)}>
            {pending ? "Saving…" : "Use for links"}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted">The workspace&apos;s own address. It always works, whatever happens to the others.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
    </li>
  );
}

export function DomainRow({ domain, ownHost }: { domain: DomainItem; ownHost: string }) {
  const { pending, error, message, setMessage, run, clear } = useRun();
  const [confirm, setConfirm] = useState<"primary" | "remove" | null>(null);
  const close = () => {
    if (!pending) setConfirm(null);
  };

  return (
    <li className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm break-all text-text">{domain.host}</span>
            <Badge tone={BADGE[domain.tone]}>{domain.statusText}</Badge>
            {domain.isPrimary && <Badge tone={domain.status === "ACTIVE" ? "brand" : "default"}>{domain.status === "ACTIVE" ? "Primary" : "Primary when live"}</Badge>}
          </span>
          {domain.lastChecked && <p className="text-xs text-muted">{domain.lastChecked}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {domain.kind === "CUSTOM" && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                run(
                  () => checkCustomDomain(domain.id),
                  (r) => setMessage((r.data as { message?: string } | undefined)?.message ?? null),
                )
              }
            >
              {pending && !confirm ? "Checking…" : "Check now"}
            </Button>
          )}
          {domain.status === "ACTIVE" && !domain.isPrimary && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                clear();
                setConfirm("primary");
              }}
            >
              Make primary
            </Button>
          )}
          {domain.kind === "CUSTOM" && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                clear();
                setConfirm("remove");
              }}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      <div aria-live="polite">
        {message && <p className="text-sm text-text">{message}</p>}
        {error && !confirm && <p className="text-sm text-danger">{error}</p>}
      </div>

      {domain.problems.length > 0 && (
        <div className="space-y-0.5 text-xs">
          <p className="text-muted">The last check found:</p>
          <ul className={domain.status === "ACTIVE" ? "list-disc space-y-0.5 pl-4 text-warning" : "list-disc space-y-0.5 pl-4 text-danger"}>
            {domain.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {domain.apex && (
        <p className="flex items-start gap-1.5 rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">
          <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            {domain.host} is a bare domain. Many DNS providers can&apos;t point one with a CNAME record — use their ALIAS, ANAME or &ldquo;CNAME
            flattening&rdquo; record if they have one, or add a subdomain such as erp.{domain.host} instead.
          </span>
        </p>
      )}

      {domain.records.length > 0 && <RecordTable host={domain.host} records={domain.records} />}

      <Dialog open={confirm === "primary"} onClose={close} title={`Make ${domain.host} primary`}>
        <div className="space-y-3 text-sm">
          <p>
            Links in emails and documents — invoices, proposals, password resets — will use <span className="font-mono">{domain.host}</span> instead of{" "}
            <span className="font-mono">{ownHost}</span>.
          </p>
          <p className="text-muted">
            People sign in separately at each address: signing in at one doesn&apos;t sign them in at another. Both addresses keep working.
          </p>
          {error && <p className="text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={pending} onClick={() => run(() => makeCustomDomainPrimary(domain.id), () => setConfirm(null))}>
              {pending ? "Saving…" : "Make primary"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={confirm === "remove"} onClose={close} title={`Remove ${domain.host}`}>
        <div className="space-y-3 text-sm">
          <p>
            <span className="font-mono">{domain.host}</span> stops reaching this workspace at once
            {domain.isPrimary ? (
              <>
                , and links go back to <span className="font-mono">{ownHost}</span>.
              </>
            ) : (
              "."
            )}{" "}
            Anybody signed in there is signed out.
          </p>
          <p className="text-muted">Adding it again later means proving it again with a new TXT record.</p>
          {error && <p className="text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" variant="danger" size="sm" disabled={pending} onClick={() => run(() => removeCustomDomain(domain.id), () => setConfirm(null))}>
              {pending ? "Removing…" : "Remove address"}
            </Button>
          </div>
        </div>
      </Dialog>
    </li>
  );
}

/** The records to create, a row each, with their name and value ready to copy. */
function RecordTable({ host, records }: { host: string; records: DomainItem["records"] }) {
  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto rounded-base border border-line">
        <table className="w-full min-w-[520px] text-left text-sm">
          <caption className="sr-only">{`DNS records to create for ${host}`}</caption>
          <thead>
            <tr className="border-b border-line bg-surface-sunken text-xs text-muted">
              <th scope="col" className="px-3 py-1.5 font-medium">
                Type
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Name
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Value
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {records.map((r) => (
              <tr key={r.type}>
                <td className="px-3 py-2 align-top font-medium text-text">{r.type}</td>
                <td className="px-3 py-2 align-top">
                  <CopyValue value={r.name} label={`Copy the ${r.type} record's name`} />
                </td>
                <td className="px-3 py-2 align-top">
                  <CopyValue value={r.value} label={`Copy the ${r.type} record's value`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Create both at your DNS provider. Some providers add your domain to a name by themselves — there, type only the part before it. Records can
        take a few minutes to an hour to be seen.
      </p>
    </div>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-start gap-1.5">
      <code className="min-w-0 font-mono text-xs break-all text-text">{value}</code>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => setCopied(false),
          );
        }}
        className="shrink-0 rounded-base p-0.5 text-muted hover:bg-surface-sunken hover:text-text"
      >
        {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}
