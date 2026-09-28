"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { consoleSaveGatewayKeys } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { StatusPill, TONE_TEXT } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import type { GatewayMode, GatewayModes, Tone } from "@/lib/console-shared/types";
import type { SecretKey, SettingRow } from "@/lib/platform/settings";
import { cn } from "@/lib/utils";
import { ChangedBy } from "./signup-settings";

/**
 * The payment gateways' keys (spec §3.18, decision D3): per gateway, each key as set or not set and
 * the mode its keys are in — never a key, a piece of one or a mask; the loader hands over nothing
 * else. An owner replaces a key in a dialog whose password field starts empty every time and is
 * emptied once the key is saved (a refusal keeps it, to be corrected), or removes one after a
 * confirmation. One key per save: the keys are written one at a time, so a save of several could
 * stop half-way.
 *
 * `readOnly` (admins and billing staff) draws the same cards with no controls at all. The webhook
 * endpoints stay on Billing › Overview, where they are copied from.
 */

type KeyDef = {
  key: SecretKey;
  label: string;
  /** Where the key is found in the gateway's dashboard. */
  find: string;
  /** What stops while it is missing. */
  loss: string;
};

type GatewayDef = { id: keyof GatewayModes; name: "Stripe" | "Razorpay"; who: string; keys: KeyDef[] };

const GATEWAYS: GatewayDef[] = [
  {
    id: "stripe",
    name: "Stripe",
    who: "Workspaces outside India pay through Stripe.",
    keys: [
      {
        key: "stripe.secretKey",
        label: "Secret key",
        find: "In Stripe: Developers › API keys. Use the secret key, or a restricted key — not the publishable one.",
        loss: "Checkouts and plan changes through Stripe stop until a new secret key is saved.",
      },
      {
        key: "stripe.webhookSecret",
        label: "Webhook signing secret",
        find: "In Stripe: Developers › Webhooks › the platform's endpoint › Signing secret.",
        loss: "Stripe's webhooks are turned away until a new signing secret is saved, so payments made there don't reach the platform.",
      },
    ],
  },
  {
    id: "razorpay",
    name: "Razorpay",
    who: "Workspaces in India pay through Razorpay, in rupees.",
    keys: [
      {
        key: "razorpay.keyId",
        label: "Key id",
        find: "In Razorpay: Account & Settings › API keys.",
        loss: "Checkouts through Razorpay stop until a new key id is saved.",
      },
      {
        key: "razorpay.keySecret",
        label: "Key secret",
        find: "Razorpay shows it once, next to the key id, when the key is generated.",
        loss: "Checkouts through Razorpay stop until a new key secret is saved.",
      },
      {
        key: "razorpay.webhookSecret",
        label: "Webhook signing secret",
        find: "The secret typed into Razorpay when the platform's webhook was added (Account & Settings › Webhooks).",
        loss: "Razorpay's webhooks are turned away until a new secret is saved, so payments made there don't reach the platform.",
      },
    ],
  },
];

const MODE: Record<"test" | "live" | "unknown" | "none", { label: string; tone: Tone }> = {
  live: { label: "Live mode", tone: "success" },
  test: { label: "Test mode", tone: "info" },
  unknown: { label: "Unknown mode", tone: "warning" },
  none: { label: "Not set up", tone: "neutral" },
};

/** One sentence on what is wrong with a gateway's keys, when something is. */
function gatewayNote(g: GatewayDef, set: (key: SecretKey) => boolean, mode: GatewayMode, production: boolean): { text: string; tone: Tone } | null {
  const missing = g.keys.filter((k) => !set(k.key));
  if (missing.length === g.keys.length) return { text: `Not set up — no workspace can pay through ${g.name} yet.`, tone: "neutral" };
  if (missing.some((k) => k.key.endsWith("webhookSecret"))) {
    return { text: "Its webhooks are turned away until the signing secret is set, so payments made there don't reach the platform.", tone: "warning" };
  }
  if (missing.length > 0) return { text: "Checkouts can't start until every key is set.", tone: "warning" };
  if (mode === "unknown") return { text: "Its key reads as neither a test nor a live key — check it was pasted whole.", tone: "warning" };
  if (production && mode === "test") return { text: "Test keys on the production installation: customers can't pay for real.", tone: "warning" };
  if (!production && mode === "live") return { text: "Live keys outside production: payments made here are real.", tone: "warning" };
  return null;
}

/**
 * What the typed value looks like — worked out in the browser as it is typed, and only ever said in
 * words (never echoed). A nudge, not a rule: the server decides what it accepts.
 */
function typedHint(key: SecretKey, value: string): { text: string; tone: Tone } | null {
  if (!value) return null;
  switch (key) {
    case "stripe.secretKey":
      if (/^(sk|rk)_test_/.test(value)) return { text: "A test-mode key: no real payments.", tone: "info" };
      if (/^(sk|rk)_live_/.test(value)) return { text: "A live-mode key: payments are real.", tone: "info" };
      if (/^pk_/.test(value)) return { text: "That is the publishable key. Paste the secret key instead.", tone: "warning" };
      return { text: "That doesn't look like a Stripe secret key.", tone: "warning" };
    case "stripe.webhookSecret":
      return /^whsec_/.test(value) ? null : { text: "That doesn't look like a Stripe signing secret.", tone: "warning" };
    case "razorpay.keyId":
      if (/^rzp_test_/.test(value)) return { text: "A test-mode key id: no real payments.", tone: "info" };
      if (/^rzp_live_/.test(value)) return { text: "A live-mode key id: payments are real.", tone: "info" };
      return { text: "That doesn't look like a Razorpay key id.", tone: "warning" };
    default:
      return null;
  }
}

export function GatewayKeysEditor({
  rows,
  modes,
  readOnly = false,
  production = false,
}: {
  rows: SettingRow[];
  modes: GatewayModes;
  /** Everybody but an owner: the same cards, no controls. */
  readOnly?: boolean;
  /** This is the production installation — test keys here are worth a warning. */
  production?: boolean;
}) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const isSet = (key: SecretKey) => byKey.get(key)?.set ?? false;

  const save = useConsoleAction<null>();
  const remove = useConsoleAction<null>();
  const [editing, setEditing] = useState<{ gateway: GatewayDef; def: KeyDef; replacing: boolean } | null>(null);
  const [removing, setRemoving] = useState<{ gateway: GatewayDef; def: KeyDef } | null>(null);

  function startEdit(gateway: GatewayDef, def: KeyDef) {
    save.reset();
    setEditing({ gateway, def, replacing: isSet(def.key) });
  }

  function closeEdit() {
    if (save.pending) return;
    setEditing(null);
    save.reset();
  }

  function startRemove(gateway: GatewayDef, def: KeyDef) {
    remove.reset();
    setRemoving({ gateway, def });
  }

  return (
    <>
      <div className="grid divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
        {GATEWAYS.map((g) => {
          const mode = modes[g.id];
          const pill = MODE[mode ?? "none"];
          const note = gatewayNote(g, isSet, mode, production);
          return (
            <div key={g.id} className="min-w-0 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-[13px] font-medium text-text">{g.name}</h3>
                  <p className="text-xs text-muted">{g.who}</p>
                </div>
                <StatusPill tone={pill.tone} dot>
                  {pill.label}
                </StatusPill>
              </div>
              {note && <p className={cn("mt-2 text-xs", TONE_TEXT[note.tone])}>{note.text}</p>}

              <dl aria-label={`${g.name} keys`} className="mt-2 divide-y divide-line">
                {g.keys.map((def) => {
                  const row = byKey.get(def.key);
                  const set = row?.set ?? false;
                  return (
                    <div key={def.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2.5">
                      <dt className="min-w-0">
                        <span className="block text-sm text-text">{def.label}</span>
                        <ChangedBy
                          change={row?.updatedAt ? { by: row.updatedByName, at: row.updatedAt } : null}
                          prefix={set ? "Changed by" : "Removed by"}
                          never={set ? "Set before changes were recorded" : "Never set"}
                        />
                      </dt>
                      <dd className="flex shrink-0 items-center gap-1.5">
                        <StatusPill tone={set ? "success" : "neutral"} icon={set ? <Check className="h-3 w-3" /> : undefined}>
                          {set ? "Set" : "Not set"}
                        </StatusPill>
                        {!readOnly && (
                          <>
                            <Button type="button" variant="secondary" size="sm" onClick={() => startEdit(g, def)} aria-label={`${set ? "Replace" : "Add"} the ${g.name} ${def.label.toLowerCase()}`}>
                              {set ? "Replace…" : "Add…"}
                            </Button>
                            {set && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => startRemove(g, def)}
                                aria-label={`Remove the ${g.name} ${def.label.toLowerCase()}`}
                                className="text-danger hover:bg-danger-bg hover:text-danger"
                              >
                                Remove
                              </Button>
                            )}
                          </>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          );
        })}
      </div>

      {!readOnly && (
        <>
          <Dialog open={editing !== null} onClose={closeEdit} title={editing ? `${editing.replacing ? "Replace" : "Add"} the ${editing.gateway.name} ${editing.def.label.toLowerCase()}` : ""}>
            {editing && (
              <KeyForm
                gateway={editing.gateway.name}
                def={editing.def}
                replacing={editing.replacing}
                action={save}
                onClose={closeEdit}
                onSaved={() => setEditing(null)}
              />
            )}
          </Dialog>

          <ConfirmDialog
            open={removing !== null}
            onClose={() => {
              setRemoving(null);
              remove.reset();
            }}
            title={removing ? `Remove the ${removing.gateway.name} ${removing.def.label.toLowerCase()}` : "Remove key"}
            confirmLabel="Remove key"
            tone="danger"
            pending={remove.pending}
            error={remove.error}
            onConfirm={() => {
              if (!removing) return;
              const { gateway, def } = removing;
              remove.run(() => consoleSaveGatewayKeys({ values: {}, clear: [def.key] }), {
                success: `${gateway.name} ${def.label.toLowerCase()} removed.`,
                onDone: () => setRemoving(null),
              });
            }}
          >
            {removing && <p>{removing.def.loss}</p>}
            <p className="text-xs text-muted">It is deleted from the platform, not kept aside: to use it again, paste it in again.</p>
          </ConfirmDialog>
        </>
      )}
    </>
  );
}

/**
 * The key field. Mounted only while its dialog is open, so it always starts empty and whatever was
 * typed is gone the moment the dialog closes; on success it is emptied before closing as well.
 */
function KeyForm({
  gateway,
  def,
  replacing,
  action,
  onClose,
  onSaved,
}: {
  gateway: string;
  def: KeyDef;
  replacing: boolean;
  action: ReturnType<typeof useConsoleAction<null>>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    // The dialog puts focus on its close button in its own effect, which runs after this one — wait
    // a frame, then put it where the typing starts.
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const key = value.trim();
  const hint = typedHint(def.key, key);
  const name = `${gateway} ${def.label.toLowerCase()}`;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!key || action.pending) return;
    const values: Partial<Record<SecretKey, string>> = { [def.key]: key };
    action.run(() => consoleSaveGatewayKeys({ values }), {
      success: `${name} ${replacing ? "replaced" : "saved"}.`,
      onDone: () => {
        setValue("");
        onSaved();
      },
    });
  }

  const fieldId = `${id}-key`;
  const hintId = `${id}-hint`;
  const typedId = `${id}-typed`;

  return (
    // p-0.5: the dialog body scrolls, and a scroll box clips the focus ring of a field at its edge.
    <form onSubmit={submit} autoComplete="off" className="space-y-4 p-0.5">
      <p className="text-sm text-text">
        {def.find}
        {replacing ? " The new one takes the place of the key saved now, straight away." : ""}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>{replacing ? `New ${def.label.toLowerCase()}` : def.label}</Label>
        {/*
          * new-password rather than off: browsers ignore "off" on a password field and would offer
          * the console's own saved sign-in here.
          */}
        <Input
          ref={inputRef}
          id={fieldId}
          name={`gateway-${def.key.replace(".", "-")}`}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          data-form-type="other"
          maxLength={500}
          readOnly={action.pending}
          aria-describedby={hint ? `${hintId} ${typedId}` : hintId}
          className="font-mono"
        />
        <p id={hintId} className="text-xs text-muted">
          Paste it exactly as {gateway} shows it. It is sealed when saved and never shown again — not even here.
        </p>
        {hint && (
          <p id={typedId} className={cn("text-xs", TONE_TEXT[hint.tone])}>
            {hint.text}
          </p>
        )}
      </div>

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        {/* Inert rather than disabled while pending, so focus stays inside the dialog. */}
        <Button
          type="submit"
          disabled={!key}
          aria-disabled={action.pending || undefined}
          aria-busy={action.pending || undefined}
          className={cn(action.pending && "cursor-wait opacity-70")}
        >
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save key
        </Button>
      </div>
    </form>
  );
}
