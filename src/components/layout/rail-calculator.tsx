"use client";

import { useState } from "react";
import { GST_RATES, marginOf, splitTax } from "@/lib/side-rail";
import { Input, Label, Select } from "@/components/ui/input";

/**
 * The two sums this business does all day.
 *
 * Both live here rather than on a page because both are needed *while* looking at something else —
 * a quote on screen, a vendor's price list open, somebody on the phone. Opening a calculator app
 * and typing the rate in by hand is how the inclusive/exclusive mistake gets made.
 */
export function RailCalculator() {
  return (
    <div className="space-y-5">
      <GstPanel />
      <div className="border-t border-line pt-4">
        <MarginPanel />
      </div>
    </div>
  );
}

const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

function GstPanel() {
  const [amount, setAmount] = useState("");
  const [rate, setRate] = useState(18);
  const [inclusive, setInclusive] = useState(false);
  const [interState, setInterState] = useState(false);

  const value = Number(amount.replace(/,/g, ""));
  const split = splitTax(Number.isFinite(value) ? value : 0, rate, interState, inclusive);
  const entered = amount.trim() !== "" && Number.isFinite(value);

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium uppercase tracking-wide text-subtle">GST</div>

      <div className="space-y-1.5">
        <Label htmlFor="rail-amount">Amount</Label>
        <Input
          id="rail-amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          autoComplete="off"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="rail-rate">Rate</Label>
          <Select id="rail-rate" value={String(rate)} onChange={(e) => setRate(Number(e.target.value))}>
            {GST_RATES.map((r) => (
              <option key={r} value={r}>
                {r}%
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rail-supply">Supply</Label>
          <Select
            id="rail-supply"
            value={interState ? "inter" : "intra"}
            onChange={(e) => setInterState(e.target.value === "inter")}
          >
            <option value="intra">Within state</option>
            <option value="inter">Interstate</option>
          </Select>
        </div>
      </div>

      {/*
        The control that earns this panel its place. The tax inside an inclusive figure is
        amount × rate / (100 + rate), not amount × rate / 100 — on ₹1,18,000 at 18% that is the
        difference between ₹18,000 and ₹21,240, and the wrong one looks perfectly plausible.
      */}
      <div className="flex rounded-md border border-line-strong p-0.5 text-xs">
        {[
          { on: false, label: "Add tax" },
          { on: true, label: "Tax included" },
        ].map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={inclusive === option.on}
            onClick={() => setInclusive(option.on)}
            className={`flex-1 rounded px-2 py-1.5 font-medium transition-colors ${
              inclusive === option.on ? "bg-brand text-brand-contrast" : "text-muted hover:bg-surface-sunken"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {entered && (
        <dl className="space-y-1 rounded-base bg-surface-sunken px-3 py-2.5 text-sm">
          <Row label="Taxable" value={inr(split.taxable)} />
          {interState ? (
            <Row label={`IGST ${rate}%`} value={inr(split.igst)} />
          ) : (
            <>
              <Row label={`CGST ${rate / 2}%`} value={inr(split.cgst)} />
              <Row label={`SGST ${rate / 2}%`} value={inr(split.sgst)} />
            </>
          )}
          <div className="border-t border-line pt-1">
            <Row label="Total" value={inr(split.total)} strong />
          </div>
        </dl>
      )}
    </div>
  );
}

function MarginPanel() {
  const [cost, setCost] = useState("");
  const [price, setPrice] = useState("");

  const c = Number(cost.replace(/,/g, ""));
  const p = Number(price.replace(/,/g, ""));
  const result = marginOf(Number.isFinite(c) ? c : 0, Number.isFinite(p) ? p : 0);
  const entered = cost.trim() !== "" && price.trim() !== "";

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium uppercase tracking-wide text-subtle">Margin</div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="rail-cost">We pay</Label>
          <Input
            id="rail-cost"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="0.00"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rail-price">We sell</Label>
          <Input
            id="rail-price"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            autoComplete="off"
          />
        </div>
      </div>

      {entered && (
        <dl className="space-y-1 rounded-base bg-surface-sunken px-3 py-2.5 text-sm">
          <Row label="Profit" value={inr(result.profit)} strong />
          <Row label="Margin" value={`${result.marginPercent}%`} />
          <Row label="Markup" value={`${result.markupPercent}%`} />
          {/*
            Both, always. People say "thirty per cent" and mean either, and a 30% markup is a 23%
            margin — quoting the wrong one is how a deal that looked profitable turns out not to be.
          */}
          <p className="pt-1 text-xs text-subtle">Margin is on the selling price; markup is on what we pay.</p>
        </dl>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`font-mono tabular-nums ${strong ? "font-semibold text-text" : "text-muted"}`}>{value}</dd>
    </div>
  );
}
