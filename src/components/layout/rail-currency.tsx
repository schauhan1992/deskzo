"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { lookupExchangeRate } from "@/actions/finance";
import { BASE_CURRENCY, CURRENCIES, formatMoney, formatRate } from "@/lib/currency";
import { Input, Label, Select } from "@/components/ui/input";

/**
 * What a foreign figure comes to in rupees, and back again.
 *
 * This business quotes in dollars, dirhams and riyals and is paid in them, and the question "so
 * what is that in rupees" comes up in the middle of reading something else — which is exactly the
 * test for being in this rail rather than on a page.
 *
 * The rate comes from `lookupExchangeRate`, the same source a document uses when it is raised, and
 * the date it applies to is shown beside it. That last part is the point: a converter quoting a
 * different rate from the one the invoice will use is worse than no converter, because the figure
 * looks authoritative and is not the one the customer will see.
 */
const FOREIGN = CURRENCIES.filter((c) => c.code !== BASE_CURRENCY);

export function RailCurrency() {
  const [code, setCode] = useState("USD");
  const [amount, setAmount] = useState("");
  const [toBase, setToBase] = useState(true);
  const [rate, setRate] = useState<{ rate: number; source: string; onDate: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Clearing the last currency's answer as the choice changes, during render rather than in an
   * effect.
   *
   * Setting state synchronously inside an effect body causes a second render pass, and the React
   * compiler refuses it. Adjusting during render is what React recommends for exactly this shape:
   * state that has to follow a prop or another piece of state. Without it there is a moment where
   * the dirham rate is shown under the heading for riyals — brief, plausible and wrong.
   */
  const [loadedFor, setLoadedFor] = useState(code);
  if (loadedFor !== code) {
    setLoadedFor(code);
    setRate(null);
    setError(null);
  }

  useEffect(() => {
    let live = true;
    const today = new Date().toISOString().slice(0, 10);
    lookupExchangeRate(code, today)
      .then((result) => {
        if (!live) return;
        if (result.ok) setRate({ rate: result.rate, source: result.source, onDate: result.onDate });
        // Said plainly rather than falling back to a made-up number. Somebody who knows the rate
        // can work without this; somebody given a wrong one cannot tell.
        else setError(result.reason);
      })
      .catch(() => live && setError("Could not reach the rate service."));
    return () => {
      live = false;
    };
  }, [code]);

  // Derived rather than stored: it is true precisely while neither answer has arrived.
  const loading = rate === null && error === null;
  const value = Number(amount.replace(/,/g, ""));
  const entered = amount.trim() !== "" && Number.isFinite(value);
  const converted = rate ? (toBase ? value * rate.rate : value / rate.rate) : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="rail-ccy">Currency</Label>
          <Select id="rail-ccy" value={code} onChange={(e) => setCode(e.target.value)}>
            {FOREIGN.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rail-ccy-amount">Amount</Label>
          <Input
            id="rail-ccy-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            autoComplete="off"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setToBase((v) => !v)}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-line-strong py-1.5 text-xs font-medium text-muted hover:bg-surface-sunken hover:text-text"
      >
        {toBase ? code : BASE_CURRENCY}
        <ArrowLeftRight className="h-3.5 w-3.5" />
        {toBase ? BASE_CURRENCY : code}
      </button>

      {loading && <p className="text-sm text-muted">Fetching today&apos;s rate…</p>}
      {error && <p className="rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">{error}</p>}

      {rate && (
        <>
          {entered && (
            <div className="rounded-base bg-surface-sunken px-3 py-2.5">
              <div className="font-mono text-lg tabular-nums text-text">
                {formatMoney(converted, toBase ? BASE_CURRENCY : code)}
              </div>
            </div>
          )}
          <p className="text-xs text-subtle">
            {/*
              Six decimal places, like the rate printed on a document. Showing 26.07 where the
              system will use 26.0682 is how a converter and an invoice come to disagree by a few
              hundred rupees on a large figure.
            */}
            1 {code} = {formatRate(rate.rate)} {BASE_CURRENCY} · {rate.onDate} · {rate.source}
          </p>
        </>
      )}
    </div>
  );
}
