"use client";

import { useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { GSTIN_PATTERN, GST_STATE_CODES, isValidGstin, stateCodeFromGstin } from "@/lib/gst-engine";
import { Input, Label } from "@/components/ui/input";

/**
 * Checking a GSTIN somebody has just read out.
 *
 * It happens on the phone, constantly, and a wrong one is not a typo you notice — it is an invoice
 * the customer cannot claim credit on and a return that has to be amended. The number carries its
 * own answer: the first two digits are the state and the fifteenth is a checksum over the other
 * fourteen, so a single mistyped character is detectable without asking anybody.
 *
 * Reuses `isValidGstin` from the GST engine rather than re-deriving the checksum. There is exactly
 * one implementation of that rule and this is not going to be a second one — a validator that
 * disagreed with the one guarding the invoice form would be worse than no validator.
 */
export function RailLookup() {
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);

  const gstin = value.trim().toUpperCase();
  const entered = gstin.length > 0;
  const shaped = GSTIN_PATTERN.test(gstin);
  const valid = shaped && isValidGstin(gstin);
  const stateCode = stateCodeFromGstin(gstin);
  const state = stateCode ? GST_STATE_CODES[stateCode] : null;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="rail-gstin">GSTIN</Label>
        <Input
          id="rail-gstin"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setCopied(false);
          }}
          placeholder="27AAAPZ1234C1ZX"
          autoComplete="off"
          spellCheck={false}
          className="font-mono uppercase"
        />
      </div>

      {entered && (
        <div className="space-y-2">
          <div
            className={`flex items-start gap-2 rounded-base px-3 py-2 text-sm ${
              valid ? "bg-success-bg text-success" : "bg-danger-bg text-danger"
            }`}
          >
            {valid ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <X className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>
              {valid
                ? "Valid."
                : gstin.length !== 15
                  ? `${gstin.length} of 15 characters.`
                  : !shaped
                    ? "Wrong shape for a GSTIN."
                    : /* Shaped correctly and still failing means the check digit does not agree —
                         which is what catches a single mistyped character. */
                      "The check digit does not match. One character is wrong."}
            </span>
          </div>

          {shaped && (
            <dl className="space-y-1 rounded-base bg-surface-sunken px-3 py-2.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-muted">State</dt>
                <dd className="text-text">{state ?? `Unknown code ${stateCode}`}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-muted">PAN</dt>
                <dd className="flex items-center gap-1.5">
                  {/* The PAN is characters 3–12. Worth pulling out because it is what somebody is
                      usually reaching for next, and counting it off by hand is its own mistake. */}
                  <span className="font-mono text-text">{gstin.slice(2, 12)}</span>
                  <button
                    type="button"
                    aria-label="Copy the PAN"
                    onClick={async () => {
                      await navigator.clipboard.writeText(gstin.slice(2, 12));
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="text-muted hover:text-text"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}

      <p className="text-xs text-subtle">
        The first two digits are the state and the last is a checksum, so a single wrong character shows up here
        rather than on a return that has to be amended.
      </p>
    </div>
  );
}
