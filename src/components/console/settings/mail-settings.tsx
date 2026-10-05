"use client";

import { useId, useState, type FormEvent } from "react";
import { CircleCheck, CircleX, LoaderCircle, Mail, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { consoleRemoveMailConnection, consoleSaveMailConnection, consoleSaveMailRoutes, consoleSendTestMail } from "@/actions/platform/console-mail";
import { Banner } from "@/components/console/kit/banner";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { MAIL_PROVIDERS, MAIL_STREAMS, providerDef, type MailProviderKey, type MailSecurityKey, type MailStreamKey } from "@/lib/console-shared/mail-catalogue";
import type { ConnectionView, MailSetup, RouteView } from "@/lib/platform/mail/store";
import { cn } from "@/lib/utils";

/**
 * Settings › Mail (src/lib/platform/mail): the accounts the platform's mail goes through, and which
 * one each of the four types uses. An owner adds, changes, tests and removes accounts and saves the
 * routing; everybody else who opens Settings sees the same page with no controls. A saved secret is
 * never shown — only that one is saved — and its field starts empty every time.
 */
export function MailSettings({ setup, canEdit, testTo }: { setup: MailSetup; canEdit: boolean; testTo: string }) {
  const [editing, setEditing] = useState<ConnectionView | "new" | null>(null);
  const [removing, setRemoving] = useState<ConnectionView | null>(null);
  const remove = useConsoleAction<null>();
  const defaultRoute = setup.routes.find((r) => r.stream === "DEFAULT");
  const noDefault = !defaultRoute?.connectionId;

  return (
    <div className="space-y-6">
      {noDefault &&
        (setup.serverFallback ? (
          <Banner tone="info" title="The default has no account yet">
            Mail without an account of its own goes through PLATFORM_SMTP_URL, set on the server, from {setup.serverFrom}. Add an account and make it the default to manage it here instead.
          </Banner>
        ) : (
          <Banner tone="warning" title="No mail is being sent">
            Without an account, and without PLATFORM_SMTP_URL on the server, every platform mail — signup codes, password links — is written to platform-outbox/ on the server, and nobody receives it.
          </Banner>
        ))}

      <Panel
        title="Mail accounts"
        description="The mail services the platform can send through. Secrets are sealed when saved and never shown again."
        padded={false}
        actions={
          canEdit ? (
            <Button type="button" size="sm" onClick={() => setEditing("new")}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add account
            </Button>
          ) : undefined
        }
      >
        {setup.connections.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
            <Mail aria-hidden="true" className="h-6 w-6 text-subtle" />
            <p className="text-sm text-muted">No accounts yet. Microsoft 365, Amazon SES, Elastic Email, SendGrid, Brevo, Mailgun, Postmark, or any SMTP server.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {setup.connections.map((c) => (
              <AccountRow key={c.id} connection={c} canEdit={canEdit} testTo={testTo} onEdit={() => setEditing(c)} onRemove={() => setRemoving(c)} />
            ))}
          </ul>
        )}
      </Panel>

      <RoutesPanel setup={setup} canEdit={canEdit} testTo={testTo} />

      {editing && <AccountDialog connection={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          if (!remove.pending) {
            setRemoving(null);
            remove.reset();
          }
        }}
        title="Remove this mail account"
        confirmLabel="Remove it"
        tone="danger"
        pending={remove.pending}
        error={remove.error}
        onConfirm={() => {
          if (!removing) return;
          const id = removing.id;
          remove.run(() => consoleRemoveMailConnection(id), { success: "Mail account removed.", onDone: () => setRemoving(null) });
        }}
      >
        {removing && (
          <>
            <ImpactList
              items={[
                { label: "Account", value: removing.name },
                {
                  label: "Used by",
                  value: removing.usedBy.length ? removing.usedBy.map(streamLabel).join(", ") : "Nothing",
                  tone: removing.usedBy.length ? "warning" : undefined,
                },
              ]}
            />
            <p>
              {removing.usedBy.includes("DEFAULT")
                ? "It is the default: until another account is made the default, mail without an account of its own goes through the server setting — or nowhere."
                : removing.usedBy.length
                  ? "The mail that used it goes through the default account instead."
                  : "No mail uses it."}{" "}
              Its saved secret is deleted with it.
            </p>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

const streamLabel = (stream: MailStreamKey) => MAIL_STREAMS.find((s) => s.key === stream)?.label ?? stream;

function AccountRow({ connection: c, canEdit, testTo, onEdit, onRemove }: { connection: ConnectionView; canEdit: boolean; testTo: string; onEdit: () => void; onRemove: () => void }) {
  const test = useConsoleAction<{ ok: boolean; via: string; to: string; error: string | null }>();
  const def = providerDef(c.provider);
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 py-4">
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
          {c.name}
          <StatusPill tone="neutral">{def?.label ?? c.provider}</StatusPill>
          {c.usedBy.map((s) => (
            <StatusPill key={s} tone={s === "DEFAULT" ? "brand" : "info"}>
              {streamLabel(s)}
            </StatusPill>
          ))}
        </p>
        <p className="text-xs text-muted">
          {`${c.fromName ? `${c.fromName} ` : ""}<${c.fromAddress}> · ${c.host}:${c.port} ${c.security === "TLS" ? "TLS" : "STARTTLS"}`}
          {c.provider === "MICROSOFT_365" ? ` · OAuth as ${c.username}` : ""}
        </p>
        <p className="flex items-center gap-1.5 text-xs">
          {c.lastTestAt === null ? (
            <span className="text-subtle">Not tested yet.</span>
          ) : c.lastTestOk ? (
            <span className="inline-flex items-center gap-1 text-success">
              <CircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
              Worked <RelativeTime at={c.lastTestAt} />
            </span>
          ) : (
            <span className="inline-flex items-start gap-1 text-danger">
              <CircleX aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Failed <RelativeTime at={c.lastTestAt} />: {c.lastTestError}
              </span>
            </span>
          )}
        </p>
        <ActionNoticeRegion notice={test.error ? { tone: "error", message: test.error } : null} />
      </div>
      {canEdit && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={test.pending}
            onClick={() =>
              test.run(() => consoleSendTestMail({ connectionId: c.id }), {
                success: (r) => (r.ok ? `Test sent to ${r.to} through ${c.name}.` : `The test didn't go: ${r.error}`),
              })
            }
            title={`Sends a test to ${testTo}`}
          >
            {test.pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Send aria-hidden="true" className="h-4 w-4" />}
            Send test
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={onEdit}>
            <Pencil aria-hidden="true" className="h-4 w-4" />
            Edit
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${c.name}`}>
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      )}
    </li>
  );
}

type AccountDraft = {
  provider: MailProviderKey;
  name: string;
  host: string;
  port: string;
  security: MailSecurityKey;
  username: string;
  secret: string;
  msTenantId: string;
  msClientId: string;
  fromAddress: string;
  fromName: string;
};

function draftFor(c: ConnectionView | null, provider: MailProviderKey = "MICROSOFT_365"): AccountDraft {
  if (c) {
    return {
      provider: c.provider,
      name: c.name,
      host: c.host,
      port: String(c.port),
      security: c.security,
      username: c.username ?? "",
      secret: "",
      msTenantId: c.msTenantId ?? "",
      msClientId: c.msClientId ?? "",
      fromAddress: c.fromAddress,
      fromName: c.fromName ?? "",
    };
  }
  const def = providerDef(provider)!;
  return {
    provider,
    name: def.label,
    host: def.servers[0]?.host ?? "",
    port: String(def.port),
    security: def.security,
    username: def.username.fixed ?? "",
    secret: "",
    msTenantId: "",
    msClientId: "",
    fromAddress: "",
    fromName: "",
  };
}

function AccountDialog({ connection, onClose }: { connection: ConnectionView | null; onClose: () => void }) {
  const [draft, setDraft] = useState<AccountDraft>(() => draftFor(connection));
  const save = useConsoleAction<{ id: string; created: boolean }>();
  const id = useId();
  const def = providerDef(draft.provider)!;
  const set = <K extends keyof AccountDraft>(key: K, value: AccountDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const editing = connection !== null;

  function choose(provider: MailProviderKey) {
    // A new account takes the service's settings; one being edited keeps what it has but the server, which must be the service's.
    setDraft((d) => (editing ? { ...draftFor(null, provider), name: d.name, fromAddress: d.fromAddress, fromName: d.fromName } : { ...draftFor(null, provider), fromAddress: d.fromAddress, fromName: d.fromName }));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    save.run(
      () =>
        consoleSaveMailConnection({
          id: connection?.id ?? null,
          provider: draft.provider,
          name: draft.name,
          host: draft.host,
          port: Number(draft.port),
          security: draft.security,
          username: draft.username,
          secret: draft.secret,
          msTenantId: draft.msTenantId,
          msClientId: draft.msClientId,
          fromAddress: draft.fromAddress,
          fromName: draft.fromName,
        }),
      {
        success: (r) => (r.created ? "Mail account added — send a test to check it." : "Mail account saved."),
        onDone: () => {
          setDraft((d) => ({ ...d, secret: "" }));
          onClose();
        },
      },
    );
  }

  const field = (key: keyof AccountDraft, label: string, props: { hint?: string; type?: string; placeholder?: string; autoComplete?: string } = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input
        id={`${id}-${key}`}
        type={props.type ?? "text"}
        value={draft[key]}
        onChange={(e) => set(key, e.target.value as never)}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete ?? "off"}
        spellCheck={false}
        readOnly={save.pending}
        aria-describedby={props.hint ? `${id}-${key}-hint` : undefined}
      />
      {props.hint && (
        <p id={`${id}-${key}-hint`} className="text-xs text-muted">
          {props.hint}
        </p>
      )}
    </div>
  );

  return (
    <Dialog open onClose={() => !save.pending && onClose()} title={editing ? `Edit ${connection.name}` : "Add a mail account"} wide>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-provider`}>Mail service</Label>
          <Select id={`${id}-provider`} value={draft.provider} onChange={(e) => choose(e.target.value as MailProviderKey)} disabled={save.pending}>
            {MAIL_PROVIDERS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted">{def.blurb}</p>
        </div>

        <details className="rounded-lg border border-line bg-surface-sunken px-4 py-3 text-sm" open={!editing}>
          <summary className="cursor-pointer font-medium text-text">Where to find these in {def.label}</summary>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs text-muted">
            {def.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </details>

        <div className="grid gap-4 sm:grid-cols-2">
          {field("name", "Name in the console", { hint: "Only staff see it — “Microsoft 365 — support@”." })}
          {def.servers.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-host`}>Region</Label>
              <Select id={`${id}-host`} value={draft.host} onChange={(e) => set("host", e.target.value)} disabled={save.pending}>
                {def.servers.map((s) => (
                  <option key={s.host} value={s.host}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : def.servers.length === 1 ? (
            <div className="space-y-1.5">
              <p className="text-[13px] font-medium text-muted">Server</p>
              <p className="py-2 font-mono text-[13px] text-text">{draft.host}</p>
            </div>
          ) : (
            field("host", "Server", { placeholder: "smtp.example.com" })
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {field("port", "Port", { hint: def.servers.length ? `${def.label} uses ${def.port}.` : "587 or 465, usually." })}
          <fieldset className="space-y-1.5">
            <legend className="text-[13px] font-medium text-muted">Encryption</legend>
            <div className="flex gap-4 py-2 text-sm">
              {(["STARTTLS", "TLS"] as const).map((s) => (
                <label key={s} className="inline-flex items-center gap-2">
                  <input type="radio" name={`${id}-security`} checked={draft.security === s} onChange={() => set("security", s)} disabled={save.pending} className="accent-[var(--brand)]" />
                  {s === "TLS" ? "TLS from the start (465)" : "STARTTLS (587, 2525)"}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        {def.signIn === "oauth" && (
          <div className="grid gap-4 sm:grid-cols-2">
            {field("msTenantId", "Directory (tenant) ID", { placeholder: "00000000-0000-0000-0000-000000000000" })}
            {field("msClientId", "Application (client) ID", { placeholder: "00000000-0000-0000-0000-000000000000" })}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {def.username.fixed ? (
            <div className="space-y-1.5">
              <p className="text-[13px] font-medium text-muted">{def.username.label}</p>
              <p className="py-2 font-mono text-[13px] text-text">{def.username.fixed}</p>
            </div>
          ) : (
            field("username", def.username.label, { hint: def.username.hint })
          )}
          {field("secret", def.secret.label, {
            type: "password",
            autoComplete: "new-password",
            hint: editing && connection.hasSecret ? `One is saved. Leave this empty to keep it. ${def.secret.hint}` : def.secret.hint,
          })}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {field("fromAddress", "Send from", { hint: "An address this account may send as.", placeholder: def.signIn === "oauth" ? draft.username || "no-reply@deskzo.com" : "no-reply@deskzo.com" })}
          {field("fromName", "Sender name", { hint: "Shown before the address. A type of mail can name its own.", placeholder: "Deskzo One" })}
        </div>

        <ActionNoticeRegion notice={save.error ? { tone: "error", message: save.error } : null} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          <Button type="submit" aria-busy={save.pending || undefined} className={save.pending ? "cursor-wait opacity-70" : undefined}>
            {save.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            {editing ? "Save" : "Add account"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type RouteDraft = { connectionId: string; fromName: string; fromAddress: string; replyTo: string };

function RoutesPanel({ setup, canEdit, testTo }: { setup: MailSetup; canEdit: boolean; testTo: string }) {
  const initial = (r: RouteView): RouteDraft => ({ connectionId: r.connectionId ?? "", fromName: r.fromName ?? "", fromAddress: r.fromAddress ?? "", replyTo: r.replyTo ?? "" });
  const [drafts, setDrafts] = useState<Record<string, RouteDraft>>(() => Object.fromEntries(setup.routes.map((r) => [r.stream, initial(r)])));
  const save = useConsoleAction<{ changed: string[] }>();
  const test = useConsoleAction<{ ok: boolean; via: string; to: string; error: string | null }>();
  const id = useId();
  const changed = setup.routes.some((r) => JSON.stringify(initial(r)) !== JSON.stringify(drafts[r.stream]));
  const accountName = (connectionId: string) => setup.connections.find((c) => c.id === connectionId)?.name ?? null;
  const set = (stream: string, key: keyof RouteDraft, value: string) => setDrafts((d) => ({ ...d, [stream]: { ...d[stream]!, [key]: value } }));

  function submit(e: FormEvent) {
    e.preventDefault();
    save.run(() => consoleSaveMailRoutes(setup.routes.map((r) => ({ stream: r.stream, ...drafts[r.stream]!, connectionId: drafts[r.stream]!.connectionId || null }))), {
      success: (r) => (r.changed.length ? "Saved — mail goes this way from now." : "Nothing had changed."),
    });
  }

  return (
    <Panel title="Which account each mail uses" description="Each type of mail can go through its own account, from its own address. A type left on the default uses the default's account and sender." padded={false}>
      <form onSubmit={submit}>
        <ul className="divide-y divide-line">
          {MAIL_STREAMS.map((s) => {
            const d = drafts[s.key]!;
            const own = d.connectionId ? accountName(d.connectionId) : null;
            const fallback = s.key === "DEFAULT" ? (setup.serverFallback ? "the server setting (PLATFORM_SMTP_URL)" : "platform-outbox/ — not sent") : `the default's${drafts.DEFAULT?.connectionId ? ` (${accountName(drafts.DEFAULT.connectionId)})` : ""}`;
            return (
              <li key={s.key} className="space-y-3 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">{s.label}</p>
                    <p className="text-xs text-muted">{s.description}</p>
                    {s.examples && <p className="mt-0.5 text-xs text-subtle">{s.examples}</p>}
                  </div>
                  {canEdit && s.key !== "DEFAULT" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={test.pending || changed}
                      title={changed ? "Save first, then test" : `Sends a test to ${testTo}, as ${s.label} mail goes now`}
                      onClick={() => test.run(() => consoleSendTestMail({ stream: s.key }), { success: (r) => (r.ok ? `Test sent to ${r.to} through ${r.via}.` : `The test didn't go: ${r.error}`) })}
                    >
                      <Send aria-hidden="true" className="h-4 w-4" />
                      Test
                    </Button>
                  )}
                </div>
                {canEdit ? (
                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="space-y-1">
                      <Label htmlFor={`${id}-${s.key}-account`}>Account</Label>
                      <Select id={`${id}-${s.key}-account`} value={d.connectionId} onChange={(e) => set(s.key, "connectionId", e.target.value)} disabled={save.pending}>
                        <option value="">{s.key === "DEFAULT" ? (setup.serverFallback ? "Server setting" : "None") : "The default's"}</option>
                        {setup.connections.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <RouteField id={`${id}-${s.key}-name`} label="Sender name" value={d.fromName} onChange={(v) => set(s.key, "fromName", v)} placeholder="The account's" readOnly={save.pending} />
                    <RouteField id={`${id}-${s.key}-from`} label="Send from" value={d.fromAddress} onChange={(v) => set(s.key, "fromAddress", v)} placeholder="The account's" readOnly={save.pending} />
                    <RouteField id={`${id}-${s.key}-reply`} label="Reply-To" value={d.replyTo} onChange={(v) => set(s.key, "replyTo", v)} placeholder={s.key === "DEFAULT" ? "None" : "The default's"} readOnly={save.pending} />
                  </div>
                ) : (
                  <p className="text-xs text-text">
                    {`Through ${own ?? fallback}${d.fromAddress ? `, from ${d.fromName ? `${d.fromName} ` : ""}<${d.fromAddress}>` : d.fromName ? `, as ${d.fromName}` : ""}${d.replyTo ? `, replies to ${d.replyTo}` : ""}.`}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {canEdit && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
            <p className={cn("text-xs", changed ? "text-warning" : "text-muted")}>
              {changed ? "Not saved yet." : "Helpdesk replies keep their own sender name (“Acme Support”) and Reply-To (the workspace's helpdesk address)."}
            </p>
            <div className="flex gap-2">
              {changed && (
                <Button type="button" variant="secondary" onClick={() => setDrafts(Object.fromEntries(setup.routes.map((r) => [r.stream, initial(r)])))} disabled={save.pending}>
                  Undo
                </Button>
              )}
              <Button type="submit" disabled={!changed} aria-busy={save.pending || undefined}>
                {save.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        )}
        <div className="px-5 pb-3">
          <ActionNoticeRegion notice={save.error ? { tone: "error", message: save.error } : test.error ? { tone: "error", message: test.error } : null} />
        </div>
      </form>
    </Panel>
  );
}

function RouteField({ id, label, value, onChange, placeholder, readOnly }: { id: string; label: string; value: string; onChange: (v: string) => void; placeholder: string; readOnly: boolean }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} readOnly={readOnly} spellCheck={false} autoComplete="off" />
    </div>
  );
}
