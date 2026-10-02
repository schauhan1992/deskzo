"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OrderStatus } from "@prisma/client";
import { saveWording } from "@/actions/wording";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import {
  DEFAULT_TERMS,
  ORDER_STATUSES,
  ORDER_STATUS_DEFAULTS,
  ORDER_STATUS_HINTS,
  TERM_HINTS,
  TERM_KEYS,
  WORD_LIMIT,
  renderTerm,
  type Term,
  type TermKey,
  type Wording,
} from "@/lib/terms/dictionary";

/**
 * Settings → Wording (src/actions/wording.ts): each of the app's words with the workspace's own, and
 * how it reads in a sentence; then an order's statuses. Saved together.
 */
export function WordingManager({ wording }: { wording: Wording }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [terms, setTerms] = useState<Record<TermKey, Term>>(wording.terms);
  const [statuses, setStatuses] = useState<Record<OrderStatus, string>>(wording.orderStatus);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const setTerm = (key: TermKey, patch: Partial<Term>) => {
    setSaved(false);
    setTerms((t) => ({ ...t, [key]: { ...t[key], ...patch } }));
  };

  function save(next: { terms: Record<TermKey, Term>; orderStatus: Record<OrderStatus, string> }) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveWording(next);
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
      <Card>
        <CardHeader className="text-sm font-medium text-text">Words</CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="pb-2 text-xs text-subtle">
            Change a word and it changes in the menu, page titles and buttons. Addresses, spreadsheet headings, record numbers and module names stay as they
            are.
          </p>
          <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_5rem_minmax(0,1.2fr)] gap-2 px-1 text-xs font-medium text-muted md:grid">
            <span>The app says</span>
            <span>One</span>
            <span>Many</span>
            <span>a / an</span>
            <span>Reads as</span>
          </div>
          {TERM_KEYS.map((key) => {
            const t = terms[key];
            const d = DEFAULT_TERMS[key];
            const id = `wording-${key}`;
            return (
              <div key={key} className="grid grid-cols-1 items-center gap-2 border-t border-line px-1 py-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_5rem_minmax(0,1.2fr)]">
                <div className="min-w-0">
                  <p className="font-medium text-text">{d.one}</p>
                  <p className="text-xs text-subtle">{TERM_HINTS[key]}</p>
                </div>
                <label className="sr-only" htmlFor={`${id}-one`}>
                  The word for one {d.one.toLowerCase()}
                </label>
                <Input id={`${id}-one`} value={t.one} maxLength={WORD_LIMIT} onChange={(e) => setTerm(key, { one: e.target.value })} />
                <label className="sr-only" htmlFor={`${id}-many`}>
                  The word for {d.many.toLowerCase()}
                </label>
                <Input id={`${id}-many`} value={t.many} maxLength={WORD_LIMIT} onChange={(e) => setTerm(key, { many: e.target.value })} />
                <label className="sr-only" htmlFor={`${id}-a`}>
                  The article before it
                </label>
                <Select id={`${id}-a`} value={t.a} onChange={(e) => setTerm(key, { a: e.target.value === "an" ? "an" : "a" })}>
                  <option value="a">a</option>
                  <option value="an">an</option>
                </Select>
                <p className="text-xs text-muted">{renderTerm("New {one:lower} · All {many:lower} · {a}", { one: t.one || d.one, many: t.many || d.many, a: t.a })}</p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Order statuses</CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="pb-2 text-xs text-subtle">
            Only the names change: approval, purchase and fulfilment work as they always have. For steps within a status, see Settings → Pipeline.
          </p>
          {ORDER_STATUSES.map((status) => (
            <div key={status} className="grid grid-cols-1 items-center gap-2 border-t border-line px-1 py-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]">
              <div className="min-w-0">
                <p className="font-medium text-text">{ORDER_STATUS_DEFAULTS[status]}</p>
                <p className="text-xs text-subtle">{ORDER_STATUS_HINTS[status]}</p>
              </div>
              <label className="sr-only" htmlFor={`wording-status-${status.toLowerCase()}`}>
                The name for {ORDER_STATUS_DEFAULTS[status].toLowerCase()}
              </label>
              <Input
                id={`wording-status-${status.toLowerCase()}`}
                value={statuses[status]}
                maxLength={WORD_LIMIT}
                onChange={(e) => {
                  setSaved(false);
                  setStatuses((s) => ({ ...s, [status]: e.target.value }));
                }}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {error && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={isPending} onClick={() => save({ terms, orderStatus: statuses })}>
          {isPending ? "Saving…" : "Save the wording"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={isPending}
          onClick={() => {
            if (!window.confirm("Go back to the app's own words? Every word and status name changed here goes back to the app's.")) return;
            setTerms(DEFAULT_TERMS);
            setStatuses(ORDER_STATUS_DEFAULTS);
            save({ terms: DEFAULT_TERMS, orderStatus: ORDER_STATUS_DEFAULTS });
          }}
        >
          Back to the app&apos;s words
        </Button>
        {saved && (
          <span role="status" className="text-sm text-success">
            Saved.
          </span>
        )}
      </div>
    </div>
  );
}
