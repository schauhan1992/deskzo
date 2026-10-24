"use client";

import { useId, useState, type FormEvent } from "react";
import { Check, LoaderCircle, Play, X } from "lucide-react";
import { consoleCheckOffsite, consoleRunOffsite, consoleSaveOffsite, consoleTurnOffOffsite } from "@/actions/platform/console-offsite";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { DefinitionList } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { CheckStep, StoreConfig } from "@/lib/offsite/store";
import { cn } from "@/lib/utils";

/**
 * Settings › Backups & logs (src/lib/offsite): the off-site store, as saved and — for an owner — as a form.
 * The secret's field starts empty every time and an empty one keeps what is saved; it is never shown back.
 * Check connection writes, reads, lists and deletes a small object and says how each went, before or after
 * saving. Everybody but an owner sees the saved store without the form.
 */

type Provider = StoreConfig["provider"];
const PROVIDERS: { value: Provider; label: string; hint: string }[] = [
  { value: "azure", label: "Azure Blob Storage", hint: "A container in a storage account in Central India or South India, reached with a SAS token." },
  { value: "s3", label: "S3-compatible", hint: "AWS S3 (ap-south-1, Mumbai), or any store that speaks S3 — Cloudflare R2, Wasabi, MinIO." },
  { value: "filesystem", label: "A folder", hint: "A disk mounted on this server from somewhere else — an Azure Files share, NFS. Not a folder on the same disk." },
];

type Draft = {
  provider: Provider;
  containerUrl: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  pathStyle: boolean;
  path: string;
  prefix: string;
  secret: string;
  backupKeepDays: string;
  logKeepDays: string;
};

function draftOf(config: StoreConfig | null, backupKeepDays: number, logKeepDays: number): Draft {
  return {
    provider: config?.provider ?? "azure",
    containerUrl: config?.provider === "azure" ? config.containerUrl : "",
    endpoint: config?.provider === "s3" ? config.endpoint : "",
    region: config?.provider === "s3" ? config.region : "ap-south-1",
    bucket: config?.provider === "s3" ? config.bucket : "",
    accessKeyId: config?.provider === "s3" ? config.accessKeyId : "",
    pathStyle: config?.provider === "s3" ? config.pathStyle : false,
    path: config?.provider === "filesystem" ? config.path : "",
    prefix: config?.prefix ?? "deskzo",
    secret: "",
    backupKeepDays: String(backupKeepDays),
    logKeepDays: String(logKeepDays),
  };
}

export function OffsiteStoreEditor({
  config,
  label,
  secretSet,
  backupKeepDays,
  logKeepDays,
  canEdit,
  canCheck,
}: {
  config: StoreConfig | null;
  label: string | null;
  secretSet: boolean;
  backupKeepDays: number;
  logKeepDays: number;
  canEdit: boolean;
  canCheck: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const check = useConsoleAction<{ label: string; steps: CheckStep[] }>();
  const off = useConsoleAction<null>();
  const [checked, setChecked] = useState<{ label: string; steps: CheckStep[] } | null>(null);

  if (editing) {
    return <StoreForm config={config} secretSet={secretSet} backupKeepDays={backupKeepDays} logKeepDays={logKeepDays} onDone={() => setEditing(false)} />;
  }

  return (
    <div className="space-y-4">
      {config ? (
        <DefinitionList
          items={[
            { term: "Store", value: <span className="break-all">{label}</span>, wide: true },
            {
              term: config.provider === "azure" ? "SAS token" : config.provider === "s3" ? "Secret access key" : "Secret",
              value:
                config.provider === "filesystem" ? (
                  "None needed"
                ) : (
                  <StatusPill tone={secretSet ? "success" : "danger"} icon={secretSet ? <Check className="h-3 w-3" /> : undefined}>
                    {secretSet ? "Set" : "Missing — nothing is copied"}
                  </StatusPill>
                ),
            },
            ...(config.provider === "s3" ? [{ term: "Access key id", value: <span className="font-mono text-xs">{config.accessKeyId}</span> }] : []),
            { term: "Backups kept there", value: `${backupKeepDays} days, the newest 3 of each workspace whatever their age` },
            { term: "Logs kept there", value: `${logKeepDays} days` },
          ]}
        />
      ) : (
        <p className="text-sm text-text">
          Nothing leaves this server: every workspace&apos;s backups, the control plane&apos;s and the logs are only on its disk, and a lost server
          loses them all.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <Button type="button" size="sm" variant={config ? "secondary" : "primary"} onClick={() => setEditing(true)}>
            {config ? "Change…" : "Set up off-site storage…"}
          </Button>
        )}
        {canCheck && config && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={check.pending}
            onClick={() => {
              setChecked(null);
              check.run(() => consoleCheckOffsite(null), { success: "", refresh: false, onDone: (data) => setChecked(data) });
            }}
          >
            {check.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Check connection
          </Button>
        )}
        {canEdit && config && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-danger hover:bg-danger-bg hover:text-danger"
            onClick={() => {
              off.reset();
              setTurningOff(true);
            }}
          >
            Turn off
          </Button>
        )}
      </div>
      <div aria-live="polite">
        {checked && <CheckResult result={checked} />}
        <ActionNoticeRegion notice={check.error ? { tone: "error", message: check.error } : null} />
      </div>

      <ConfirmDialog
        open={turningOff}
        onClose={() => setTurningOff(false)}
        title="Turn off off-site copies"
        confirmLabel="Turn off"
        tone="danger"
        pending={off.pending}
        error={off.error}
        onConfirm={() => off.run(() => consoleTurnOffOffsite(), { success: "Off-site copies turned off.", onDone: () => setTurningOff(false) })}
      >
        <p>Nothing more is copied off the server — no backups, no control plane dumps, no logs. The secret is deleted.</p>
        <p className="text-xs text-muted">What is in the store already stays there; delete it in the store itself if it should go.</p>
      </ConfirmDialog>
    </div>
  );
}

function CheckResult({ result }: { result: { label: string; steps: CheckStep[] } }) {
  const ok = result.steps.length === 4 && result.steps.every((s) => s.ok);
  return (
    <div className="space-y-1.5 rounded-lg border border-line bg-surface-sunken px-4 py-3">
      <p className={cn("text-sm font-medium", ok ? "text-success" : "text-danger")}>{ok ? `Connected to ${result.label}.` : `${result.label} isn't ready.`}</p>
      <ul className="space-y-1">
        {result.steps.map((s) => (
          <li key={s.step} className="flex gap-2 text-xs">
            {s.ok ? <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : <X aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />}
            <span className="text-text">
              <span className="font-medium capitalize">{s.step}</span>
              <span className="sr-only">{s.ok ? " worked" : " failed"}</span> — {s.detail}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StoreForm({ config, secretSet, backupKeepDays, logKeepDays, onDone }: { config: StoreConfig | null; secretSet: boolean; backupKeepDays: number; logKeepDays: number; onDone: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(config, backupKeepDays, logKeepDays));
  const save = useConsoleAction<null>();
  const check = useConsoleAction<{ label: string; steps: CheckStep[] }>();
  const [checked, setChecked] = useState<{ label: string; steps: CheckStep[] } | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setChecked(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const keepsSecret = secretSet && config?.provider === draft.provider && draft.provider !== "filesystem";
  const busy = save.pending || check.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    save.run(() => consoleSaveOffsite({ ...draft }), { success: "Off-site storage saved. The platform worker starts copying within the hour.", onDone });
  }

  const field = (key: keyof Draft, text: string, hint?: string, props: Record<string, unknown> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-${key}`}>{text}</Label>
      <Input
        id={`${id}-${key}`}
        value={String(draft[key])}
        onChange={(e) => set(key, e.target.value as never)}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        readOnly={busy}
        aria-describedby={hint ? `${id}-${key}-hint` : undefined}
        {...props}
      />
      {hint && (
        <p id={`${id}-${key}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );

  const secretLabel = draft.provider === "azure" ? "SAS token" : "Secret access key";

  return (
    <form onSubmit={submit} autoComplete="off" className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-muted">Where</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {PROVIDERS.map((p) => (
            <label
              key={p.value}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 text-sm",
                draft.provider === p.value ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken",
              )}
            >
              <span className="flex items-center gap-2 font-medium text-text">
                <input type="radio" name={`${id}-provider`} value={p.value} checked={draft.provider === p.value} onChange={() => set("provider", p.value)} disabled={busy} />
                {p.label}
              </span>
              <span className="text-xs text-muted">{p.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {draft.provider === "azure" &&
        field("containerUrl", "Container address", "https://<account>.blob.core.windows.net/<container> — under the container's Properties in the Azure portal.", { placeholder: "https://deskzobackups.blob.core.windows.net/deskzo", inputMode: "url" })}
      {draft.provider === "s3" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {field("endpoint", "Endpoint", "AWS: https://s3.ap-south-1.amazonaws.com. R2: https://<account>.r2.cloudflarestorage.com.", { placeholder: "https://s3.ap-south-1.amazonaws.com", inputMode: "url" })}
          {field("region", "Region", "ap-south-1 for Mumbai; auto for Cloudflare R2.")}
          {field("bucket", "Bucket")}
          {field("accessKeyId", "Access key id", "A key for this bucket alone, allowed to put, get, list and delete.")}
          <label className="flex items-center gap-2 text-sm text-text sm:col-span-2">
            <input type="checkbox" checked={draft.pathStyle} onChange={(e) => set("pathStyle", e.target.checked)} disabled={busy} />
            Address the bucket in the path (MinIO and some others need it; AWS and R2 don&apos;t)
          </label>
        </div>
      )}
      {draft.provider === "filesystem" && field("path", "Folder", "Its full path on this server. It must not be inside the backup or log folders.", { placeholder: "/mnt/offsite" })}

      {draft.provider !== "filesystem" &&
        field(
          "secret",
          keepsSecret ? `New ${secretLabel.toLowerCase()}` : secretLabel,
          keepsSecret
            ? "Leave it empty to keep the one saved. It is sealed when saved and never shown again."
            : draft.provider === "azure"
              ? "Generate one on the container (Shared access tokens) with read, add, create, write, delete and list, valid for a year or more. It is sealed when saved and never shown again."
              : "It is sealed when saved and never shown again.",
          { type: "password", autoComplete: "new-password", "data-1p-ignore": "", "data-lpignore": "true", "data-form-type": "other", className: "font-mono", maxLength: 2000 },
        )}

      <div className="grid gap-4 sm:grid-cols-3">
        {field("prefix", "Folder inside the store", "Everything goes under it, so one store can serve staging and production.", { placeholder: "deskzo" })}
        {field("backupKeepDays", "Keep backups (days)", "7 to 3650. The newest 3 of each workspace stay whatever their age.", { type: "number", min: 7, max: 3650, inputMode: "numeric" })}
        {field("logKeepDays", "Keep logs (days)", "180 to 3650 — CERT-In requires 180 at least.", { type: "number", min: 180, max: 3650, inputMode: "numeric" })}
      </div>

      <div aria-live="polite">
        {checked && <CheckResult result={checked} />}
        <ActionNoticeRegion notice={save.error ? { tone: "error", message: save.error } : check.error ? { tone: "error", message: check.error } : null} />
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setChecked(null);
            check.run(() => consoleCheckOffsite({ ...draft }), { success: "", refresh: false, onDone: (data) => setChecked(data) });
          }}
        >
          {check.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Check connection
        </Button>
        <Button type="submit" aria-disabled={busy || undefined} aria-busy={save.pending || undefined} className={cn(save.pending && "cursor-wait opacity-70")}>
          {save.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}

/** "Run now" for one chore — the platform worker picks it up within a minute. A drill may name a workspace. */
export function RunOffsiteButton({ chore, label, withWorkspace = false, disabled = false }: { chore: "sync" | "control" | "logs" | "drill" | "clock"; label: string; withWorkspace?: boolean; disabled?: boolean }) {
  const id = useId();
  const run = useConsoleAction<null>();
  const [workspace, setWorkspace] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {withWorkspace && (
        <>
          <Label htmlFor={`${id}-ws`} className="sr-only">
            Workspace to restore (its address name; empty for the one restored longest ago)
          </Label>
          <Input
            id={`${id}-ws`}
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder="any workspace"
            className="h-8 w-40 text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled || run.pending}
        onClick={() => run.run(() => consoleRunOffsite(chore, workspace), { success: `${label}: asked for. The platform worker starts it within a minute.` })}
      >
        {run.pending ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Play aria-hidden="true" className="h-3.5 w-3.5" />}
        {label}
      </Button>
      <ActionNoticeRegion notice={run.error ? { tone: "error", message: run.error } : null} />
    </div>
  );
}

