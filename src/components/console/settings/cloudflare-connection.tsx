"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { consoleCheckCloudflare, consoleSaveCloudflare } from "@/actions/platform/console-domains";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { StatusPill, TONE_TEXT } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import type { Tone } from "@/lib/console-shared/types";
import type { CloudflareConnection as Connection } from "@/lib/platform/cloudflare-hostnames";
import { cn } from "@/lib/utils";
import { ChangedBy, type SettingChange } from "./signup-settings";

/**
 * Settings › Custom domains › Cloudflare (src/lib/platform/cloudflare-hostnames.ts): the zone workspaces' own
 * addresses are custom hostnames of, and the API token Deskzo adds them with — shown only as set or not, typed
 * into a field that starts empty every time, like the gateways' keys. Check connection asks Cloudflare where
 * those addresses' requests go (the zone's fallback origin). `readOnly`: everybody but an owner, who sees the
 * same rows without the buttons; `canCheck`: owners and admins.
 */

type Editing = "zone" | "token" | null;

export function CloudflareConnectionEditor({
  zoneId,
  tokenSet,
  zoneChange,
  tokenChange,
  readOnly = false,
  canCheck = false,
}: {
  zoneId: string | null;
  tokenSet: boolean;
  zoneChange: SettingChange | null;
  tokenChange: SettingChange | null;
  readOnly?: boolean;
  canCheck?: boolean;
}) {
  const save = useConsoleAction<null>();
  const remove = useConsoleAction<null>();
  const check = useConsoleAction<Connection>();
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState(false);
  const [found, setFound] = useState<Connection | null>(null);
  const connected = !!zoneId && tokenSet;

  function start(which: Editing) {
    save.reset();
    setEditing(which);
  }
  function close() {
    if (save.pending) return;
    setEditing(null);
    save.reset();
  }

  const verdict = found ? connectionWords(found) : null;

  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-text">Cloudflare for SaaS</h3>
          <StatusPill tone={connected ? "success" : "neutral"} dot>
            {connected ? "Connected" : "Not connected"}
          </StatusPill>
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {connected
            ? "A workspace's own address is added to Cloudflare once its DNS records check out, and goes live when Cloudflare has issued its HTTPS certificate. Removing it removes it from Cloudflare."
            : "Until it is connected, an address on a domain outside Cloudflare gets Cloudflare's Error 1001, because deskzo.com's records are proxied — each one would have to be added in Cloudflare by hand."}
        </p>
      </div>

      <dl aria-label="Cloudflare connection" className="divide-y divide-line rounded-base border border-line px-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2.5">
          <dt className="min-w-0">
            <span className="block text-sm text-text">Zone id</span>
            <ChangedBy change={zoneChange} never="Never set" />
          </dt>
          <dd className="flex shrink-0 items-center gap-1.5">
            {zoneId ? <span className="font-mono text-xs text-text">{zoneId}</span> : <StatusPill tone="neutral">Not set</StatusPill>}
            {!readOnly && (
              <Button type="button" variant="secondary" size="sm" onClick={() => start("zone")} aria-label={zoneId ? "Change the Cloudflare zone id" : "Add the Cloudflare zone id"}>
                {zoneId ? "Change…" : "Add…"}
              </Button>
            )}
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2.5">
          <dt className="min-w-0">
            <span className="block text-sm text-text">API token</span>
            <ChangedBy change={tokenChange} prefix={tokenSet ? "Changed by" : "Removed by"} never="Never set" />
          </dt>
          <dd className="flex shrink-0 items-center gap-1.5">
            <StatusPill tone={tokenSet ? "success" : "neutral"} icon={tokenSet ? <Check className="h-3 w-3" /> : undefined}>
              {tokenSet ? "Set" : "Not set"}
            </StatusPill>
            {!readOnly && (
              <>
                <Button type="button" variant="secondary" size="sm" onClick={() => start("token")} aria-label={tokenSet ? "Replace the Cloudflare API token" : "Add the Cloudflare API token"}>
                  {tokenSet ? "Replace…" : "Add…"}
                </Button>
                {tokenSet && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      remove.reset();
                      setRemoving(true);
                    }}
                    aria-label="Remove the Cloudflare API token"
                    className="text-danger hover:bg-danger-bg hover:text-danger"
                  >
                    Remove
                  </Button>
                )}
              </>
            )}
          </dd>
        </div>
      </dl>

      {canCheck && connected && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={check.pending}
            onClick={() => {
              setFound(null);
              check.run(() => consoleCheckCloudflare(), { success: "", refresh: false, onDone: (data) => setFound(data) });
            }}
          >
            {check.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Check connection
          </Button>
          <div aria-live="polite">
            {verdict && <p className={cn("text-xs", TONE_TEXT[verdict.tone])}>{verdict.text}</p>}
            <ActionNoticeRegion notice={check.error ? { tone: "error", message: check.error } : null} />
          </div>
        </div>
      )}

      {!readOnly && (
        <>
          <Dialog open={editing !== null} onClose={close} title={editing === "zone" ? "Cloudflare zone id" : `${tokenSet ? "Replace" : "Add"} the Cloudflare API token`}>
            {editing && <ValueForm which={editing} current={zoneId} replacing={editing === "token" ? tokenSet : !!zoneId} action={save} onClose={close} onSaved={() => setEditing(null)} />}
          </Dialog>

          <ConfirmDialog
            open={removing}
            onClose={() => {
              setRemoving(false);
              remove.reset();
            }}
            title="Remove the Cloudflare API token"
            confirmLabel="Remove token"
            tone="danger"
            pending={remove.pending}
            error={remove.error}
            onConfirm={() =>
              remove.run(() => consoleSaveCloudflare({ clearToken: true }), {
                success: "Cloudflare API token removed.",
                onDone: () => setRemoving(false),
              })
            }
          >
            <p>
              New addresses stop getting an HTTPS certificate, and addresses that are live now aren&apos;t removed from Cloudflare when a workspace
              removes them. Addresses already live keep working.
            </p>
            <p className="text-xs text-muted">It is deleted from the platform, not kept aside: to use it again, paste it in again.</p>
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}

/** What Check connection found, in a sentence. */
function connectionWords(c: Connection): { text: string; tone: Tone } {
  const count = c.hostnames === null ? "" : ` The zone has ${c.hostnames} custom hostname${c.hostnames === 1 ? "" : "s"} (the first 100 are free).`;
  if (!c.fallbackOrigin) {
    return { text: `The token works, but the zone has no fallback origin yet — set one under SSL/TLS › Custom Hostnames in Cloudflare.${count}`, tone: "warning" };
  }
  if (c.fallbackStatus !== "active") {
    const errors = c.errors.length ? ` Cloudflare says: ${c.errors.join("; ")}.` : "";
    return { text: `Requests go to ${c.fallbackOrigin}, which Cloudflare reports as ${c.fallbackStatus ?? "not active"}.${errors}${count}`, tone: "warning" };
  }
  return { text: `Connected — workspaces' own addresses are served through ${c.fallbackOrigin}.${count}`, tone: "success" };
}

/**
 * The zone id, or the token, in a dialog. Mounted only while it is open, so the token's field starts empty and
 * whatever was typed is gone once it closes.
 */
function ValueForm({
  which,
  current,
  replacing,
  action,
  onClose,
  onSaved,
}: {
  which: "zone" | "token";
  current: string | null;
  replacing: boolean;
  action: ReturnType<typeof useConsoleAction<null>>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(which === "zone" ? (current ?? "") : "");

  useEffect(() => {
    // The dialog focuses its close button in its own effect, after this one: wait a frame.
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const typed = value.trim();
  const unchanged = which === "zone" && typed.toLowerCase() === (current ?? "");

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!typed || unchanged || action.pending) return;
    action.run(() => consoleSaveCloudflare(which === "zone" ? { zoneId: typed } : { token: typed }), {
      success: which === "zone" ? "Cloudflare zone id saved." : `Cloudflare API token ${replacing ? "replaced" : "saved"}.`,
      onDone: () => {
        setValue("");
        onSaved();
      },
    });
  }

  const fieldId = `${id}-value`;
  const hintId = `${id}-hint`;

  return (
    // p-0.5: the dialog body scrolls, and a scroll box clips the focus ring of a field at its edge.
    <form onSubmit={submit} autoComplete="off" className="space-y-4 p-0.5">
      <p className="text-sm text-text">
        {which === "zone"
          ? "In Cloudflare, open deskzo.com: the zone id is on its Overview page, under API."
          : "In Cloudflare: My Profile › API Tokens › Create Token › Create Custom Token. Give it Zone › SSL and Certificates › Edit, for the zone deskzo.com only."}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>{which === "zone" ? "Zone id" : replacing ? "New API token" : "API token"}</Label>
        {/* new-password rather than off: browsers ignore "off" on a password field and offer the console's own sign-in. */}
        <Input
          ref={inputRef}
          id={fieldId}
          name={which === "zone" ? "cloudflare-zone-id" : "cloudflare-api-token"}
          type={which === "zone" ? "text" : "password"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete={which === "zone" ? "off" : "new-password"}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          data-form-type="other"
          maxLength={which === "zone" ? 64 : 200}
          readOnly={action.pending}
          aria-describedby={hintId}
          className="font-mono"
        />
        <p id={hintId} className="text-xs text-muted">
          {which === "zone" ? "32 letters and digits." : "Paste it exactly as Cloudflare shows it. It is sealed when saved and never shown again — not even here."}
        </p>
      </div>

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        {/* Inert rather than disabled while pending, so focus stays inside the dialog. */}
        <Button
          type="submit"
          disabled={!typed || unchanged}
          aria-disabled={action.pending || undefined}
          aria-busy={action.pending || undefined}
          className={cn(action.pending && "cursor-wait opacity-70")}
        >
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          {which === "zone" ? "Save zone id" : "Save token"}
        </Button>
      </div>
    </form>
  );
}
