"use client";

import { useId, useState, type FormEvent } from "react";
import { CircleCheck, CircleX, LoaderCircle, Pencil, Plus, Sparkles, Trash2, Zap } from "lucide-react";
import type { AiProviderKind } from "@deskzo/control-client";
import {
  consoleAddSuggestedAiModels,
  consoleRemoveAiAccount,
  consoleRemoveAiModel,
  consoleSaveAiAccount,
  consoleSaveAiModel,
  consoleSaveAiPacks,
  consoleSaveAiRoutes,
  consoleSaveTrialAiCredits,
  consoleSetAiPaused,
  consoleTestAiAccount,
} from "@/actions/platform/console-ai";
import { Banner } from "@/components/console/kit/banner";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { AI_FEATURES, PROVIDER_KINDS, PROVIDER_KIND_ORDER, creditsText, featureLabel } from "@/lib/ai/catalogue";
import type { AccountView, AiSetup, ModelView, PlatformAiUsage } from "@/lib/ai/accounts";
import { formatMoney } from "@/lib/billing/money";

/**
 * Settings › AI (src/lib/ai): Deskzo AI's accounts, models and rates, routing, kill switch, packs and a
 * trial's credits. An owner changes them; everybody else who opens Settings sees the same page with no
 * controls. A saved secret is never shown — only that one is saved — and its field starts empty each time.
 */
export function AiSettings({ setup, usage, monthLabel, canEdit }: { setup: AiSetup; usage: PlatformAiUsage[]; monthLabel: string; canEdit: boolean }) {
  const [editingAccount, setEditingAccount] = useState<AccountView | "new" | null>(null);
  const [editingModel, setEditingModel] = useState<ModelView | "new" | null>(null);
  const [removing, setRemoving] = useState<{ kind: "account"; item: AccountView } | { kind: "model"; item: ModelView } | null>(null);
  const remove = useConsoleAction<null>();
  const unrouted = setup.routes.filter((r) => !r.modelId);

  return (
    <div className="space-y-6">
      <SwitchPanel paused={setup.paused} canEdit={canEdit} />
      {unrouted.length > 0 && (
        <Banner tone="warning" title="Not every feature is set up">
          {`${unrouted.map((r) => featureLabel(r.feature)).join(" and ")} ${unrouted.length === 1 ? "has" : "have"} no model, so workspaces are told Deskzo AI isn't available for ${unrouted.length === 1 ? "it" : "them"}. Add an account and a model, then choose it under Routing.`}
        </Banner>
      )}

      <Panel
        title="Accounts"
        description="The providers Deskzo AI calls models through. Keys are sealed when saved and never shown again."
        padded={false}
        actions={
          canEdit ? (
            <Button type="button" size="sm" onClick={() => setEditingAccount("new")}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add account
            </Button>
          ) : undefined
        }
      >
        {setup.accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
            <Sparkles aria-hidden="true" className="h-6 w-6 text-subtle" />
            <p className="text-sm text-muted">No accounts yet. Start with Claude on Amazon Bedrock in ap-south-1, whose India profiles keep requests in Mumbai and Hyderabad.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {setup.accounts.map((a) => (
              <AccountRow key={a.id} account={a} models={setup.models.filter((m) => m.accountId === a.id)} canEdit={canEdit} onEdit={() => setEditingAccount(a)} onRemove={() => setRemoving({ kind: "account", item: a })} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Models and rates"
        description="What each model is called at its provider, and what workspaces are charged: credits for a million tokens. A credit is ₹1 before GST. Cached input counts a tenth."
        padded={false}
        actions={
          canEdit && setup.accounts.length > 0 ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditingModel("new")}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add model
            </Button>
          ) : undefined
        }
      >
        {setup.models.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">No models yet. An account&apos;s “Add suggested models” fills in its provider&apos;s usual ones with suggested rates.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2">Model</th>
                  <th className="px-3 py-2">At the provider</th>
                  <th className="px-3 py-2 text-right">Credits / M in · out</th>
                  <th className="px-3 py-2 text-right">Cost / M in · out</th>
                  <th className="px-3 py-2">Runs</th>
                  {canEdit && <th className="px-5 py-2" />}
                </tr>
              </thead>
              <tbody>
                {setup.models.map((m) => (
                  <tr key={m.id} className="border-b border-line last:border-0">
                    <td className="px-5 py-2">
                      <span className="font-medium text-text">{m.label}</span>
                      <span className="block font-mono text-[11px] text-subtle">{m.key}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-mono text-[12px]">{m.providerModel}</span>
                      <span className="block text-[11px] text-subtle">{setup.accounts.find((a) => a.id === m.accountId)?.name}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {m.inputRate.toLocaleString("en-IN")} · {m.outputRate.toLocaleString("en-IN")}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{m.inputCost === null && m.outputCost === null ? "—" : `${rupees(m.inputCost)} · ${rupees(m.outputCost)}`}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {!m.active && <StatusPill tone="neutral">Off</StatusPill>}
                        {m.features.map((f) => (
                          <StatusPill key={f} tone="brand">
                            {featureLabel(f)}
                          </StatusPill>
                        ))}
                      </span>
                    </td>
                    {canEdit && (
                      <td className="whitespace-nowrap px-5 py-2 text-right">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setEditingModel(m)} aria-label={`Edit ${m.label}`}>
                          <Pencil aria-hidden="true" className="h-4 w-4" />
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setRemoving({ kind: "model", item: m })} aria-label={`Remove ${m.label}`}>
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <RoutesPanel setup={setup} canEdit={canEdit} />
      <CreditsPanel setup={setup} canEdit={canEdit} />
      <UsagePanel usage={usage} models={setup.models} monthLabel={monthLabel} />

      {editingAccount && <AccountDialog account={editingAccount === "new" ? null : editingAccount} onClose={() => setEditingAccount(null)} />}
      {editingModel && <ModelDialog model={editingModel === "new" ? null : editingModel} accounts={setup.accounts} onClose={() => setEditingModel(null)} />}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          if (!remove.pending) {
            setRemoving(null);
            remove.reset();
          }
        }}
        title={removing?.kind === "account" ? "Remove this AI account" : "Remove this model"}
        confirmLabel="Remove it"
        tone="danger"
        pending={remove.pending}
        error={remove.error}
        onConfirm={() => {
          if (!removing) return;
          const id = removing.item.id;
          remove.run(() => (removing.kind === "account" ? consoleRemoveAiAccount(id) : consoleRemoveAiModel(id)), { success: "Removed.", onDone: () => setRemoving(null) });
        }}
      >
        {removing?.kind === "account" ? (
          <p>
            {removing.item.name} and its models go, with its sealed key. A feature still running on one of its models stops this — move the feature first. What workspaces were
            charged stays on the record.
          </p>
        ) : removing ? (
          <p>{removing.item.label} goes. What workspaces were charged on it stays on the record, under its key.</p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

const rupees = (paise: number | null) => (paise === null ? "—" : formatMoney(paise, "INR"));

function SwitchPanel({ paused, canEdit }: { paused: boolean; canEdit: boolean }) {
  const action = useConsoleAction<null>();
  const [confirming, setConfirming] = useState(false);
  return (
    <Panel title="The switch" description="Deskzo AI in every workspace at once. Paused, nothing is sent to any provider and nothing is charged; people are told it's paused.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <StatusPill tone={paused ? "warning" : "success"}>{paused ? "Paused" : "Running"}</StatusPill>
          <span className="text-muted">{paused ? "No workspace can use the copilot or AI drafting." : "Workspaces use it as their own switches and credits allow."}</span>
        </p>
        {canEdit && (
          <Button type="button" size="sm" variant={paused ? "primary" : "secondary"} disabled={action.pending} onClick={() => (paused ? action.run(() => consoleSetAiPaused(false), { success: "Deskzo AI is running again." }) : setConfirming(true))}>
            {paused ? "Resume" : "Pause everywhere"}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => !action.pending && setConfirming(false)}
        title="Pause Deskzo AI everywhere"
        confirmLabel="Pause it"
        tone="danger"
        pending={action.pending}
        error={action.error}
        onConfirm={() => action.run(() => consoleSetAiPaused(true), { success: "Deskzo AI is paused everywhere.", onDone: () => setConfirming(false) })}
      >
        <p>Every workspace&apos;s copilot and AI drafting stop until it is resumed. Answers already being written finish.</p>
      </ConfirmDialog>
    </Panel>
  );
}

function AccountRow({ account: a, models, canEdit, onEdit, onRemove }: { account: AccountView; models: ModelView[]; canEdit: boolean; onEdit: () => void; onRemove: () => void }) {
  const test = useConsoleAction<{ ok: boolean; model: string | null; error: string | null }>();
  const suggest = useConsoleAction<{ added: string[] }>();
  const def = PROVIDER_KINDS[a.kind];
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 py-4">
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
          {a.name}
          <StatusPill tone="neutral">{def.label}</StatusPill>
          {!a.active && <StatusPill tone="warning">Off</StatusPill>}
          {a.noTraining ? <StatusPill tone="success">No training</StatusPill> : <StatusPill tone="warning">Training terms not checked</StatusPill>}
        </p>
        <p className="text-xs text-muted">
          {[`Processed in ${a.residency}`, a.region, a.endpoint, a.keyId && a.kind !== "BEDROCK" ? a.keyId : null, a.hasSecret ? "key saved" : "no key", `${models.length} model${models.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
        </p>
        <p className="flex items-center gap-1.5 text-xs">
          {a.lastTestAt === null ? (
            <span className="text-subtle">Not tested yet.</span>
          ) : a.lastTestOk ? (
            <span className="inline-flex items-center gap-1 text-success">
              <CircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
              Answered <RelativeTime at={a.lastTestAt} />
            </span>
          ) : (
            <span className="inline-flex items-start gap-1 text-danger">
              <CircleX aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Failed <RelativeTime at={a.lastTestAt} />: {a.lastTestError}
              </span>
            </span>
          )}
        </p>
        <ActionNoticeRegion notice={test.error ? { tone: "error", message: test.error } : suggest.error ? { tone: "error", message: suggest.error } : null} />
      </div>
      {canEdit && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={test.pending || models.length === 0}
            title={models.length === 0 ? "Add a model first" : "Asks its first model for one word — a few tokens, charged to no workspace"}
            onClick={() => test.run(() => consoleTestAiAccount({ accountId: a.id }), { success: (r) => (r.ok ? `${r.model} answered.` : `The test failed: ${r.error}`) })}
          >
            {test.pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Zap aria-hidden="true" className="h-4 w-4" />}
            Test
          </Button>
          {def.suggested.models.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={suggest.pending}
              onClick={() => suggest.run(() => consoleAddSuggestedAiModels(a.id), { success: (r) => (r.added.length ? `Added ${r.added.join(", ")}. Check the rates against the provider's prices.` : "Its suggested models are already here.") })}
            >
              Add suggested models
            </Button>
          )}
          <Button type="button" size="sm" variant="secondary" onClick={onEdit}>
            <Pencil aria-hidden="true" className="h-4 w-4" />
            Edit
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${a.name}`}>
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      )}
    </li>
  );
}

type AccountDraft = { kind: AiProviderKind; name: string; region: string; endpoint: string; keyId: string; secret: string; residency: string; noTraining: boolean; active: boolean };

function draftFor(a: AccountView | null, kind: AiProviderKind = "BEDROCK"): AccountDraft {
  if (a) return { kind: a.kind, name: a.name, region: a.region ?? "", endpoint: a.endpoint ?? "", keyId: a.keyId ?? "", secret: "", residency: a.residency, noTraining: a.noTraining, active: a.active };
  const s = PROVIDER_KINDS[kind].suggested;
  return { kind, name: s.name, region: s.region ?? "", endpoint: s.endpoint ?? "", keyId: s.keyId ?? "", secret: "", residency: s.residency, noTraining: false, active: true };
}

function AccountDialog({ account, onClose }: { account: AccountView | null; onClose: () => void }) {
  const [draft, setDraft] = useState<AccountDraft>(() => draftFor(account));
  const save = useConsoleAction<{ id: string; created: boolean }>();
  const id = useId();
  const def = PROVIDER_KINDS[draft.kind];
  const editing = account !== null;
  const set = <K extends keyof AccountDraft>(key: K, value: AccountDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    save.run(() => consoleSaveAiAccount({ id: account?.id ?? null, ...draft }), {
      success: (r) => (r.created ? "Account added — add its models, then test it." : "Account saved."),
      onDone: onClose,
    });
  }

  const field = (key: "name" | "region" | "endpoint" | "keyId" | "residency", label: string, hint?: string, placeholder?: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input id={`${id}-${key}`} value={draft[key]} onChange={(e) => set(key, e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} readOnly={save.pending} />
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );

  return (
    <Dialog open onClose={() => !save.pending && onClose()} title={editing ? `Edit ${account.name}` : "Add an AI account"} wide>
      <form onSubmit={submit} className="space-y-5">
        {!editing && (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-kind`}>Provider</Label>
            <Select id={`${id}-kind`} value={draft.kind} onChange={(e) => setDraft(draftFor(null, e.target.value as AiProviderKind))} disabled={save.pending}>
              {PROVIDER_KIND_ORDER.map((k) => (
                <option key={k} value={k}>
                  {PROVIDER_KINDS[k].label}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {field("name", "Name in the console")}
          {field("residency", "Where it processes requests", "Shown to workspaces before they use AI: “India (Mumbai and Hyderabad)”.")}
          {def.region && field("region", def.region.label, def.region.help, def.region.placeholder)}
          {def.endpoint && field("endpoint", def.endpoint.label, def.endpoint.help, def.endpoint.placeholder)}
          {def.keyId && field("keyId", def.keyId.label, def.keyId.help, def.keyId.placeholder)}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-secret`}>{def.secret.label}</Label>
          {draft.kind === "VERTEX" ? (
            <textarea
              id={`${id}-secret`}
              value={draft.secret}
              onChange={(e) => set("secret", e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={account?.hasSecret ? "Saved — paste a new one to replace it" : def.secret.placeholder}
              className="w-full rounded-base border border-line bg-surface px-3 py-2 font-mono text-xs"
              readOnly={save.pending}
            />
          ) : (
            <Input id={`${id}-secret`} type="password" value={draft.secret} onChange={(e) => set("secret", e.target.value)} autoComplete="new-password" placeholder={account?.hasSecret ? "Saved — type a new one to replace it" : def.secret.placeholder} readOnly={save.pending} />
          )}
          <p className="text-xs text-muted">Sealed under the platform key and never shown again. Leave it empty to keep the saved one.</p>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={draft.noTraining} onChange={(e) => set("noTraining", e.target.checked)} disabled={save.pending} />
            <span>I have checked the provider&apos;s terms: nothing sent is used to train its models. Workspaces are told so.</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={draft.active} onChange={(e) => set("active", e.target.checked)} disabled={save.pending} />
            <span>On — features can run on its models.</span>
          </label>
        </div>
        <ActionNoticeRegion notice={save.error ? { tone: "error", message: save.error } : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.pending}>
            {save.pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type ModelDraft = { accountId: string; key: string; label: string; providerModel: string; inputRate: string; outputRate: string; inputCost: string; outputCost: string; active: boolean };

function ModelDialog({ model, accounts, onClose }: { model: ModelView | null; accounts: AccountView[]; onClose: () => void }) {
  const [draft, setDraft] = useState<ModelDraft>(() => ({
    accountId: model?.accountId ?? accounts[0]?.id ?? "",
    key: model?.key ?? "",
    label: model?.label ?? "",
    providerModel: model?.providerModel ?? "",
    inputRate: model ? String(model.inputRate) : "",
    outputRate: model ? String(model.outputRate) : "",
    inputCost: model?.inputCost === null || model?.inputCost === undefined ? "" : String(model.inputCost),
    outputCost: model?.outputCost === null || model?.outputCost === undefined ? "" : String(model.outputCost),
    active: model?.active ?? true,
  }));
  const save = useConsoleAction<{ id: string; created: boolean }>();
  const id = useId();
  const set = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    save.run(
      () =>
        consoleSaveAiModel({
          id: model?.id ?? null,
          accountId: draft.accountId,
          key: draft.key,
          label: draft.label,
          providerModel: draft.providerModel,
          inputRate: Number(draft.inputRate),
          outputRate: Number(draft.outputRate),
          inputCost: draft.inputCost.trim() === "" ? null : Number(draft.inputCost),
          outputCost: draft.outputCost.trim() === "" ? null : Number(draft.outputCost),
          active: draft.active,
        }),
      { success: (r) => (r.created ? "Model added." : "Model saved."), onDone: onClose },
    );
  }

  const field = (key: Exclude<keyof ModelDraft, "active" | "accountId">, label: string, hint?: string, readOnly = false) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input id={`${id}-${key}`} value={draft[key]} onChange={(e) => set(key, e.target.value)} autoComplete="off" spellCheck={false} readOnly={save.pending || readOnly} />
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );

  return (
    <Dialog open onClose={() => !save.pending && onClose()} title={model ? `Edit ${model.label}` : "Add a model"} wide>
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-account`}>Account</Label>
            <Select id={`${id}-account`} value={draft.accountId} onChange={(e) => set("accountId", e.target.value)} disabled={save.pending || !!model}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          {field("key", "Key", model ? "Kept on every charge, so it doesn't change." : "Lower-case, like claude-sonnet-5-india. Kept on every charge.", !!model)}
          {field("label", "Name workspaces see", "“Claude Sonnet 5”.")}
          {field("providerModel", "Name at the provider", "A Bedrock inference profile (in.anthropic.…), an Azure deployment, a model ID.")}
          {field("inputRate", "Credits for a million input tokens")}
          {field("outputRate", "Credits for a million output tokens")}
          {field("inputCost", "Its cost to Deskzo, paise a million input tokens", "Optional — only for the margin below.")}
          {field("outputCost", "Its cost to Deskzo, paise a million output tokens")}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={draft.active} onChange={(e) => set("active", e.target.checked)} disabled={save.pending} />
          <span>On — a feature can be routed to it.</span>
        </label>
        <ActionNoticeRegion notice={save.error ? { tone: "error", message: save.error } : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.pending}>
            {save.pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RoutesPanel({ setup, canEdit }: { setup: AiSetup; canEdit: boolean }) {
  const [routes, setRoutes] = useState<Record<string, string>>(() => Object.fromEntries(setup.routes.map((r) => [r.feature, r.modelId ?? ""])));
  const save = useConsoleAction<{ changed: string[] }>();
  const id = useId();
  const usable = setup.models.filter((m) => m.active && setup.accounts.find((a) => a.id === m.accountId)?.active);
  return (
    <Panel title="Routing" description="Which model each feature runs on. A change applies to the next turn in every workspace.">
      <div className="space-y-4">
        {AI_FEATURES.map((f) => (
          <div key={f.key} className="grid gap-1.5 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-center">
            <Label htmlFor={`${id}-${f.key}`}>{f.label}</Label>
            <div>
              <Select id={`${id}-${f.key}`} value={routes[f.key] ?? ""} onChange={(e) => setRoutes((r) => ({ ...r, [f.key]: e.target.value }))} disabled={!canEdit || save.pending}>
                <option value="">Not set up — workspaces can&apos;t use it</option>
                {usable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {setup.accounts.find((a) => a.id === m.accountId)?.name}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-muted">Sends: {f.sends}</p>
            </div>
          </div>
        ))}
        {canEdit && (
          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={save.pending} onClick={() => save.run(() => consoleSaveAiRoutes(routes), { success: (r) => (r.changed.length ? "Routing saved." : "Nothing changed.") })}>
              {save.pending ? "Saving…" : "Save routing"}
            </Button>
          </div>
        )}
        <ActionNoticeRegion notice={save.error ? { tone: "error", message: save.error } : null} />
      </div>
    </Panel>
  );
}

function CreditsPanel({ setup, canEdit }: { setup: AiSetup; canEdit: boolean }) {
  const [packs, setPacks] = useState(() => setup.packs.map((p) => ({ credits: String(p.credits), rupees: String(p.inr / 100) })));
  const [trial, setTrial] = useState(String(setup.trialCredits));
  const savePacks = useConsoleAction<null>();
  const saveTrial = useConsoleAction<{ workspaces: number }>();
  const id = useId();
  return (
    <Panel
      title="Credits on sale"
      description="Each plan's monthly credits are set on the plan (Plans › AI credits a month). Packs are bought on top, in India through Razorpay, before 18% GST, and last twelve months."
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm font-medium text-text">Packs</p>
          {packs.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <Input aria-label={`Pack ${i + 1}: credits`} className="w-28" value={p.credits} onChange={(e) => setPacks((list) => list.map((x, j) => (j === i ? { ...x, credits: e.target.value } : x)))} disabled={!canEdit} />
              <span className="text-muted">credits for ₹</span>
              <Input aria-label={`Pack ${i + 1}: price before GST, rupees`} className="w-28" value={p.rupees} onChange={(e) => setPacks((list) => list.map((x, j) => (j === i ? { ...x, rupees: e.target.value } : x)))} disabled={!canEdit} />
              <span className="text-muted">before GST</span>
              {canEdit && packs.length > 1 && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setPacks((list) => list.filter((_, j) => j !== i))} aria-label={`Remove pack ${i + 1}`}>
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              {packs.length < 6 && (
                <Button type="button" size="sm" variant="secondary" onClick={() => setPacks((list) => [...list, { credits: "", rupees: "" }])}>
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  Add a pack
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                disabled={savePacks.pending}
                onClick={() => savePacks.run(() => consoleSaveAiPacks(packs.map((p) => ({ credits: Number(p.credits), inr: Math.round(Number(p.rupees) * 100) }))), { success: "Packs saved." })}
              >
                Save packs
              </Button>
            </div>
          )}
          <ActionNoticeRegion notice={savePacks.error ? { tone: "error", message: savePacks.error } : null} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-trial`}>A free trial&apos;s credits, for the whole workspace</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input id={`${id}-trial`} className="w-28" value={trial} onChange={(e) => setTrial(e.target.value)} disabled={!canEdit} />
            {canEdit && (
              <Button type="button" size="sm" disabled={saveTrial.pending} onClick={() => saveTrial.run(() => consoleSaveTrialAiCredits(Number(trial)), { success: (r) => `Saved — ${r.workspaces} workspace${r.workspaces === 1 ? "" : "s"} on a trial worked out again.` })}>
                Save
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">In place of what the trial&apos;s plan would give a paying workspace. Every workspace on its trial gets the new number at once.</p>
          <ActionNoticeRegion notice={saveTrial.error ? { tone: "error", message: saveTrial.error } : null} />
        </div>
      </div>
    </Panel>
  );
}

function UsagePanel({ usage, models, monthLabel }: { usage: PlatformAiUsage[]; models: ModelView[]; monthLabel: string }) {
  const charged = usage.reduce((s, u) => s + u.credits, 0);
  const cost = usage.reduce((s, u) => s + (u.cost ?? 0), 0);
  return (
    <Panel title={`This month (${monthLabel})`} description="Every workspace together: what was charged in credits (₹1 each, before GST, whether from an allowance or a pack) against what the provider charged Deskzo." padded={false}>
      {usage.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">Nothing charged this month yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-5 py-2">Model</th>
                <th className="px-3 py-2 text-right">Workspaces</th>
                <th className="px-3 py-2 text-right">Turns</th>
                <th className="px-3 py-2 text-right">Credits charged</th>
                <th className="px-5 py-2 text-right">Cost to Deskzo</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.modelKey} className="border-b border-line last:border-0">
                  <td className="px-5 py-2">{models.find((m) => m.key === u.modelKey)?.label ?? u.modelKey}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{u.workspaces}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{u.turns.toLocaleString("en-IN")}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{creditsText(u.credits)}</td>
                  <td className="px-5 py-2 text-right tabular-nums">{u.cost === null ? "—" : formatMoney(u.cost, "INR")}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="px-5 py-2">All</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right tabular-nums">{usage.reduce((s, u) => s + u.turns, 0).toLocaleString("en-IN")}</td>
                <td className="px-3 py-2 text-right tabular-nums">{creditsText(charged)}</td>
                <td className="px-5 py-2 text-right tabular-nums">{formatMoney(cost, "INR")}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
