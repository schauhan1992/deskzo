"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowLeftRight, LoaderCircle, TriangleAlert } from "lucide-react";
import { consolePartnerPicker, consoleSetAttribution } from "@/actions/platform/console-partners";
import { ImpactList } from "@/components/console/kit/impact";
import { LabelPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { PARTNER_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import type { PartnerPickerRow } from "@/lib/partners/console-data";
import { cn } from "@/lib/utils";

/**
 * "Change partner" (SELLERS; spec §4.4): which partner a workspace belongs to from now on — or none —
 * whether it earns commission, and why (10–500 characters, kept in the platform audit log). The
 * partner is found with the partner picker (live partners only); a partner not set up for the
 * workspace's country is allowed, with a warning first. Never backdated: invoices already paid keep
 * the partner they were paid under. Both partners' logs say a customer moved; neither sees the reason.
 */

type Current = { slug: string; displayName: string; commissionable: boolean } | null;
type Choice = { slug: string; displayName: string; territories: string[] } | null;
type Tenant = { id: string; name: string; country: string };
type Done = { from: string | null; to: string | null; commissionable: boolean; outsideTerritory: boolean };

const REASON = { min: 10, max: 500 };
const SEARCH_DELAY_MS = 250;
const PICK_FAILED = "Couldn't search for partners. Try again.";
const noSubscribe = () => () => {};

export function ChangePartnerButton({ tenant, current }: { tenant: Tenant; current: Current }) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<Done>();
  const [open, setOpen] = useState(false);

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <ArrowLeftRight aria-hidden="true" className="h-4 w-4" />
        Change partner
      </Button>
      <Dialog open={open && isClient} onClose={close} title={`Change ${tenant.name}'s partner`}>
        <AttributionForm tenant={tenant} current={current} action={action} onClose={close} />
      </Dialog>
    </>
  );
}

/** Mounted only while the dialog is open: it searches on opening, and every field starts fresh. */
function AttributionForm({ tenant, current, action, onClose }: { tenant: Tenant; current: Current; action: ReturnType<typeof useConsoleAction<Done>>; onClose: () => void }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<PartnerPickerRow[]>([]);
  const [searching, setSearching] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Choice | "direct" | undefined>(undefined);
  const [commissionable, setCommissionable] = useState(current?.commissionable ?? true);
  const [reason, setReason] = useState("");
  const asked = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    // The first page of partners, before anything is typed: the answer lands in a callback, not here.
    const first = window.setTimeout(() => void search(""), 0);
    const pending = timer;
    const counter = asked;
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(first);
      window.clearTimeout(pending.current);
      counter.current += 1;
    };
  }, []);

  function onQuery(next: string) {
    setQuery(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void search(next.trim()), SEARCH_DELAY_MS);
  }

  const direct = chosen === "direct";
  const partner = chosen && chosen !== "direct" ? chosen : null;
  const outside = partner && tenant.country && !partner.territories.includes(tenant.country);
  const toSlug = direct ? null : (partner?.slug ?? undefined);
  const sameAsNow = toSlug !== undefined && (toSlug ?? null) === (current?.slug ?? null) && (direct || commissionable === current?.commissionable);
  const reasonLeft = Math.max(0, REASON.min - reason.trim().length);
  const ready = toSlug !== undefined && !sameAsNow && reasonLeft === 0 && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || toSlug === undefined) return;
    const toName = partner?.displayName ?? null;
    action.run(() => consoleSetAttribution(tenant.id, { partnerSlug: toSlug, reason: reason.trim(), commissionable: direct ? false : commissionable }), {
      success: (d) =>
        d.to === null
          ? "Workspace made direct — no partner from now on."
          : `Workspace moved to ${toName ?? d.to}${d.commissionable ? "" : " (no commission)"}${d.outsideTerritory ? " — outside its territories" : ""}.`,
      onDone: onClose,
    });
  }

  const searchId = `${id}-search`;
  const reasonId = `${id}-reason`;
  const reasonHint = `${id}-reason-hint`;
  const radioName = `${id}-partner`;

  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-muted">{`Now: ${current ? current.displayName : "Direct — no partner"}. Move it to`}</legend>
        <label className={cn("flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3 py-2 text-sm", direct && "bg-brand-subtle")}>
          <input type="radio" name={radioName} value="" checked={direct} onChange={() => setChosen("direct")} disabled={action.pending} className="h-4 w-4 accent-brand" />
          <span className="font-medium text-text">Direct (no partner)</span>
        </label>
        <Label htmlFor={searchId} className="sr-only">
          Find a partner by name or address
        </Label>
        <Input
          id={searchId}
          ref={searchRef}
          type="search"
          placeholder="Find a partner by name or address"
          value={query}
          maxLength={100}
          onChange={(e) => onQuery(e.target.value)}
          autoComplete="off"
          data-1p-ignore=""
          readOnly={action.pending}
        />
        <div className="max-h-56 overflow-y-auto rounded-lg border border-line" aria-busy={searching || undefined}>
          {rows.length === 0 ? (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
              {searching && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
              {searching ? "Searching…" : searchError ? "" : "No live partner matches."}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((row) => {
                const on = partner?.slug === row.slug;
                return (
                  <li key={row.slug}>
                    <label className={cn("flex cursor-pointer items-center gap-3 px-3 py-2 text-sm", on && "bg-brand-subtle")}>
                      <input
                        type="radio"
                        name={radioName}
                        value={row.slug}
                        checked={on}
                        onChange={() => setChosen({ slug: row.slug, displayName: row.displayName, territories: row.territories })}
                        disabled={action.pending}
                        className="h-4 w-4 accent-brand"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-text">{row.displayName}</span>
                        <span className="block font-mono text-[11px] text-subtle">{`${row.slug} · ${row.territories.join(", ") || "no territories"}`}</span>
                      </span>
                      <LabelPill map={PARTNER_KIND} value={row.kind} />
                      <LabelPill map={PARTNER_STATUS} value={row.status} />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <ActionNoticeRegion notice={searchError ? { tone: "error", message: searchError } : null} />
      </fieldset>

      {outside && partner && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          {`${partner.displayName} is not set up for ${tenant.country}. You can still assign it — the attribution is recorded as outside its territories.`}
        </p>
      )}

      {!direct && (
        <label className="flex cursor-pointer items-start gap-2 text-sm text-text">
          <Checkbox checked={commissionable} onChange={(e) => setCommissionable(e.target.checked)} disabled={action.pending} className="mt-0.5" />
          <span>
            Earns commission
            <span className="block text-xs text-muted">Untick for a partner&apos;s own workspace, or one it supports without selling.</span>
          </span>
        </label>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={reasonId}>Reason (kept in the audit log, never shown to a partner)</Label>
        <Textarea
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={REASON.max}
          rows={3}
          placeholder="e.g. the customer moved to the Mumbai reseller, as agreed with both"
          aria-describedby={reasonHint}
          aria-required="true"
          readOnly={action.pending}
        />
        <p id={reasonHint} className="text-xs text-muted tabular-nums">
          {reasonLeft > 0 ? `${reasonLeft} more character${reasonLeft === 1 ? "" : "s"}` : `${reason.length} / ${REASON.max}`}
        </p>
      </div>

      {toSlug !== undefined && (
        <ImpactList
          items={[
            { label: "From", value: current ? current.displayName : "Direct" },
            { label: "To", value: direct ? "Direct — no partner" : (partner?.displayName ?? "") },
            { label: "Commission", value: direct ? "None" : commissionable ? "On invoices paid from now" : "None (not commissionable)", tone: !direct && commissionable ? "success" : "neutral" },
            { label: "Starts", value: "Now — never backdated" },
          ]}
        />
      )}

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : sameAsNow ? { tone: "info", message: "Nothing to change." } : null} />

      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Change partner
        </Button>
      </div>
    </form>
  );
}
