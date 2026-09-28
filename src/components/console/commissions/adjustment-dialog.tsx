"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { LoaderCircle, Plus } from "lucide-react";
import { consoleAddAdjustment } from "@/actions/platform/console-commissions";
import { consolePartnerPicker } from "@/actions/platform/console-partners";
import { LabelPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatMoney } from "@/lib/billing/money";
import { PARTNER_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import type { PartnerPickerRow } from "@/lib/partners/console-data";
import { cn } from "@/lib/utils";
import { minorDigits, toMinor } from "./format";

/**
 * "Add adjustment" (SELLERS; spec §5.9): a staff correction owed to a partner, or taken back — in
 * one currency, with a note the partner reads on the entry. Optionally about one of its customers,
 * and dated to an earlier IST day; it waits for the next statement like any other entry.
 *
 * On a partner's own page the partner is fixed. On /commissions the dialog finds one with the
 * partner picker (live partners only — a terminated partner's corrections are made from its page).
 * The amount is typed in the currency's main unit and sent in its smallest; a minus takes money back.
 */

type Chosen = { slug: string; displayName: string };

const MAX_MINOR = 1_000_000_000;
const NOTE = { min: 3, max: 500 };
const SEARCH_DELAY_MS = 250;
const PICK_FAILED = "Couldn't search for partners. Try again.";

const noSubscribe = () => () => {};

export function AddAdjustmentButton({
  partner = null,
  currencies,
  defaultCurrency,
  todayKey,
  suggest,
}: {
  /** Fixed on a partner's page; null to choose one. */
  partner?: Chosen | null;
  currencies: string[];
  /** The currency picked to start with (the list's filter, or the partner's first); INR otherwise. */
  defaultCurrency?: string;
  /** Today on India's calendar (from the loader's clock): the latest day it may count from. */
  todayKey: string;
  /** What to search for first (the list's partner filter). */
  suggest?: string;
}) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ id: string }>();
  const [open, setOpen] = useState(false);

  // ── The partner picker (only without a fixed partner) ──────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<PartnerPickerRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(partner);
  const asked = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const pending = timer;
    return () => window.clearTimeout(pending.current);
  }, []);

  async function search(q: string) {
    const mine = ++asked.current;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await consolePartnerPicker(q);
      if (mine !== asked.current) return;
      if (result.ok) setRows(result.data);
      else setSearchError(result.error);
    } catch {
      if (mine === asked.current) setSearchError(PICK_FAILED);
    } finally {
      if (mine === asked.current) setSearching(false);
    }
  }

  function onQuery(next: string) {
    setQuery(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void search(next.trim()), SEARCH_DELAY_MS);
  }

  function openDialog() {
    action.reset();
    setChosen(partner);
    setOpen(true);
    if (!partner) {
      const first = (suggest ?? "").trim();
      setQuery(first);
      setRows([]);
      void search(first);
    }
  }

  function close() {
    if (action.pending) return;
    asked.current += 1;
    window.clearTimeout(timer.current);
    action.reset();
    setOpen(false);
  }

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={openDialog}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        Add adjustment
      </Button>
      <Dialog open={open && isClient} onClose={close} title={partner ? `Add an adjustment for ${partner.displayName}` : "Add an adjustment"}>
        <AdjustmentForm
          fixed={partner !== null}
          chosen={chosen}
          onChoose={setChosen}
          picker={{ query, rows, searching, error: searchError, onQuery }}
          currencies={currencies}
          defaultCurrency={defaultCurrency && currencies.includes(defaultCurrency) ? defaultCurrency : currencies.includes("INR") ? "INR" : (currencies[0] ?? "INR")}
          todayKey={todayKey}
          action={action}
          onClose={close}
        />
      </Dialog>
    </>
  );
}

/** The form, mounted only while the dialog is open — so every field starts empty each time. */
function AdjustmentForm({
  fixed,
  chosen,
  onChoose,
  picker,
  currencies,
  defaultCurrency,
  todayKey,
  action,
  onClose,
}: {
  fixed: boolean;
  chosen: Chosen | null;
  onChoose: (partner: Chosen) => void;
  picker: { query: string; rows: PartnerPickerRow[]; searching: boolean; error: string | null; onQuery: (q: string) => void };
  currencies: string[];
  defaultCurrency: string;
  todayKey: string;
  action: ReturnType<typeof useConsoleAction<{ id: string }>>;
  onClose: () => void;
}) {
  const id = useId();
  const [currency, setCurrency] = useState(defaultCurrency);
  const [amountText, setAmountText] = useState("");
  const [note, setNote] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [day, setDay] = useState("");
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The dialog focuses its close button in its own effect, which runs after this one.
    const frame = window.requestAnimationFrame(() => firstRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const amount = amountText.trim() ? toMinor(amountText, currency, { signed: true }) : null;
  const amountOk = amount !== null && amount !== 0 && Math.abs(amount) <= MAX_MINOR;
  const noteLeft = Math.max(0, NOTE.min - note.trim().length);
  const dayOk = day === "" || (/^\d{4}-\d{2}-\d{2}$/.test(day) && day <= todayKey);
  const workspaceOk = workspace.trim() === "" || /^[a-z0-9][a-z0-9-]{0,62}$/i.test(workspace.trim());
  const ready = chosen !== null && amountOk && noteLeft === 0 && dayOk && workspaceOk && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || !chosen || amount === null) return;
    action.run(
      () =>
        consoleAddAdjustment(chosen.slug, {
          currency,
          amount,
          note: note.trim(),
          tenantSlug: workspace.trim() ? workspace.trim().toLowerCase() : null,
          earnedOn: day || null,
        }),
      { success: `Adjustment added for ${chosen.displayName}: ${formatMoney(amount, currency)}.`, onDone: onClose },
    );
  }

  const currencyId = `${id}-currency`;
  const amountId = `${id}-amount`;
  const amountHint = `${id}-amount-hint`;
  const noteId = `${id}-note`;
  const noteHint = `${id}-note-hint`;
  const workspaceId = `${id}-workspace`;
  const workspaceHint = `${id}-workspace-hint`;
  const dayId = `${id}-day`;
  const dayHint = `${id}-day-hint`;
  const digits = minorDigits(currency);

  return (
    // p-0.5: the dialog body scrolls, and a scroll box clips the focus ring of a field at its edge.
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      {!fixed && (
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-muted">Partner</legend>
          <Input
            ref={firstRef}
            type="search"
            aria-label="Find a partner by name or slug"
            placeholder="Find a partner by name or slug"
            value={picker.query}
            maxLength={100}
            onChange={(e) => picker.onQuery(e.target.value)}
            autoComplete="off"
            data-1p-ignore=""
            readOnly={action.pending}
          />
          <div className="max-h-52 overflow-y-auto rounded-lg border border-line" aria-busy={picker.searching || undefined}>
            {picker.rows.length === 0 ? (
              <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
                {picker.searching && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
                {picker.searching ? "Searching…" : picker.error ? "" : "No live partner matches."}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {picker.rows.map((row) => (
                  <li key={row.slug}>
                    <label className={cn("flex cursor-pointer items-center gap-3 px-3 py-2 text-sm", chosen?.slug === row.slug && "bg-brand-subtle")}>
                      <input
                        type="radio"
                        name={`${id}-partner`}
                        value={row.slug}
                        checked={chosen?.slug === row.slug}
                        onChange={() => onChoose({ slug: row.slug, displayName: row.displayName })}
                        disabled={action.pending}
                        className="h-4 w-4 accent-brand"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-text">{row.displayName}</span>
                        <span className="block font-mono text-[11px] text-subtle">{row.slug}</span>
                      </span>
                      <LabelPill map={PARTNER_KIND} value={row.kind} />
                      <LabelPill map={PARTNER_STATUS} value={row.status} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <ActionNoticeRegion notice={picker.error ? { tone: "error", message: picker.error } : null} />
          {chosen && <p className="text-xs text-muted">{`For ${chosen.displayName} (${chosen.slug}).`}</p>}
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor={currencyId}>Currency</Label>
          <Select id={currencyId} value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={action.pending}>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={amountId}>Amount</Label>
          <Input
            id={amountId}
            ref={fixed ? firstRef : undefined}
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder={digits ? "500.00, or -500.00 to take back" : "500, or -500 to take back"}
            autoComplete="off"
            aria-invalid={(amountText.trim() !== "" && !amountOk) || undefined}
            aria-describedby={amountHint}
            readOnly={action.pending}
          />
          <p id={amountHint} className={cn("text-xs", amountText.trim() !== "" && !amountOk ? "text-danger" : "text-muted")}>
            {amountText.trim() === ""
              ? `In ${currency}, with at most ${digits} decimal places. A minus takes money back.`
              : !amountOk || amount === null
                ? `A non-zero amount in ${currency}, with at most ${digits} decimal places, up to ${formatMoney(MAX_MINOR, currency)} either way.`
                : amount > 0
                  ? `${formatMoney(amount, currency)} owed to the partner.`
                  : `${formatMoney(-amount, currency)} taken back from the partner.`}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={noteId}>Note</Label>
        <Textarea
          id={noteId}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE.max}
          rows={3}
          placeholder="Goodwill credit for the delayed onboarding in August"
          aria-describedby={noteHint}
          aria-required="true"
          readOnly={action.pending}
        />
        <p id={noteHint} className="text-xs text-muted tabular-nums">
          {noteLeft > 0 ? `The partner reads this on the entry. ${noteLeft} more character${noteLeft === 1 ? "" : "s"}.` : `The partner reads this on the entry. ${note.length} / ${NOTE.max}`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={workspaceId}>Workspace (optional)</Label>
          <Input
            id={workspaceId}
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            maxLength={63}
            placeholder="acme"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={!workspaceOk || undefined}
            aria-describedby={workspaceHint}
            readOnly={action.pending}
            className="font-mono"
          />
          <p id={workspaceHint} className={cn("text-xs", workspaceOk ? "text-muted" : "text-danger")}>
            {workspaceOk ? "Its address — only a workspace that has been this partner's customer." : "A workspace address: letters, digits and hyphens."}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={dayId}>Counts from (optional)</Label>
          <Input
            id={dayId}
            type="date"
            max={todayKey}
            value={day}
            onChange={(e) => setDay(e.target.value)}
            aria-invalid={!dayOk || undefined}
            aria-describedby={dayHint}
            readOnly={action.pending}
          />
          <p id={dayHint} className={cn("text-xs", dayOk ? "text-muted" : "text-danger")}>
            {dayOk ? "A day in India time; today when left empty." : "Not later than today."}
          </p>
        </div>
      </div>

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />

      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Add adjustment
        </Button>
      </div>
    </form>
  );
}
