"use client";

import { useId, useState } from "react";
import { Plus, ReceiptText } from "lucide-react";
import { consoleAddPrice, consoleRetirePrice } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { CopyField } from "@/components/console/kit/copy-field";
import { EmptyState } from "@/components/console/kit/empty-state";
import { InsetBlock, Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { formatMoney } from "@/lib/billing/money";
import { dayMonthYear } from "@/lib/console-shared/format";
import { gatewayLabel, intervalLabel } from "@/lib/console-shared/labels";
import type { PlanDetail } from "@/lib/platform/console-data";

/**
 * A plan's prices (spec §3.10 › Prices). A price is made at its gateway as it is added — a Stripe
 * price, a Razorpay plan — and never changed there: a new one for the same gateway, currency and
 * interval replaces the one on sale, and workspaces already paying the old one keep it. So the only
 * two things done here are adding a price (T2, which says what it replaces) and taking one off sale
 * (T1). Internal plans are never sold and have no prices; the page leaves this out for them.
 */

type Price = PlanDetail["prices"][number];
type Gateway = "RAZORPAY" | "STRIPE";
type Interval = "MONTH" | "YEAR";

/** The largest amount a price holds — a 32-bit integer of the currency's smallest unit. */
const MAX_MINOR = 2_147_483_647;

const priceText = (p: { amount: number; currency: string; interval: Interval; perSeat: boolean }) =>
  `${formatMoney(p.amount, p.currency)} / ${intervalLabel(p.interval)}${p.perSeat ? " per person" : ""}`;

/** How many decimals the currency has (2 for INR and USD, 0 for JPY) — null for a code that is not a currency. */
function minorDigits(currency: string): number | null {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
}

/** The amount as typed (main units: 1499.50), in the currency's smallest unit — or why it cannot be. */
function parseAmount(text: string, currency: string): { minor: number | null; error: string | null } {
  if (!/^[A-Z]{3}$/.test(currency)) return { minor: null, error: "A currency is three letters, like USD or EUR." };
  const digits = minorDigits(currency);
  if (digits === null) return { minor: null, error: `${currency} is not a currency we know.` };
  const value = text.trim().replace(/,/g, "");
  if (value === "") return { minor: null, error: null };
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return { minor: null, error: "Type the amount as a number, like 1499 or 1499.50." };
  if ((match[2]?.length ?? 0) > digits) {
    return { minor: null, error: digits === 0 ? `${currency} has no smaller unit — type a whole amount.` : `${currency} goes to ${digits} decimal places.` };
  }
  const minor = Math.round(Number(value) * 10 ** digits);
  if (minor < 1) return { minor: null, error: "A price is more than nothing." };
  if (minor > MAX_MINOR) return { minor: null, error: "That is more than a price can hold." };
  return { minor, error: null };
}

export function PriceEditor({ planKey, prices, editable }: { planKey: string; prices: PlanDetail["prices"]; editable: boolean }) {
  const id = useId();
  const retire = useConsoleAction<null>();
  const add = useConsoleAction<{ id: string; externalId: string }>();
  const [retiring, setRetiring] = useState<Price | null>(null);

  const [adding, setAdding] = useState(false);
  const [gateway, setGateway] = useState<Gateway>("RAZORPAY");
  const [currency, setCurrency] = useState("INR");
  const [billed, setBilled] = useState<Interval>("MONTH");
  const [amount, setAmount] = useState("");
  const [perSeat, setPerSeat] = useState(false);

  const onSale = prices.filter((p) => p.active).length;
  const parsed = parseAmount(amount, currency);
  const replaced = prices.find((p) => p.active && p.gateway === gateway && p.currency === currency && p.interval === billed) ?? null;

  function openAdd() {
    add.reset();
    setGateway("RAZORPAY");
    setCurrency("INR");
    setBilled("MONTH");
    setAmount("");
    setPerSeat(false);
    setAdding(true);
  }

  function chooseGateway(value: string) {
    const next: Gateway = value === "STRIPE" ? "STRIPE" : "RAZORPAY";
    setGateway(next);
    // Razorpay charges in rupees here; Stripe is how anything else is charged.
    if (next === "RAZORPAY") setCurrency("INR");
    else if (currency === "INR") setCurrency("USD");
  }

  function createPrice() {
    if (parsed.minor === null) return;
    const input = { planKey, gateway, currency, interval: billed, amount: parsed.minor, perSeat };
    add.run(() => consoleAddPrice(input), {
      success: `Price created at ${gatewayLabel(gateway)} and put on sale.`,
      onDone: () => setAdding(false),
    });
  }

  function openRetire(price: Price) {
    retire.reset();
    setRetiring(price);
  }

  function takeOffSale() {
    if (!retiring) return;
    const priceId = retiring.id;
    retire.run(() => consoleRetirePrice(priceId), { success: "Price taken off sale.", onDone: () => setRetiring(null) });
  }

  const gatewayId = `${id}-gateway`;
  const currencyId = `${id}-currency`;
  const currencyHintId = `${id}-currency-hint`;
  const intervalId = `${id}-interval`;
  const amountId = `${id}-amount`;
  const amountHintId = `${id}-amount-hint`;

  return (
    <>
      <Panel
        title="Prices"
        description={
          prices.length === 0
            ? "Made at the gateway as they are added, and never changed there."
            : `${onSale} on sale. Made at the gateway as they are added and never changed there — a new one replaces the one on sale, and workspaces paying an older one keep it.`
        }
        actions={
          editable ? (
            <Button type="button" variant="secondary" size="sm" onClick={openAdd}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add price
            </Button>
          ) : undefined
        }
        padded={false}
      >
        {prices.length === 0 ? (
          <EmptyState
            icon={<ReceiptText className="h-5 w-5" />}
            title="No prices yet"
            body="Without a price the plan is not sold at checkout — staff can still give it by hand or as a trial."
          />
        ) : (
          <DataTable caption={`Prices of ${planKey}`} minWidth={820}>
            <THead>
              <Th>Gateway</Th>
              <Th numeric>Amount</Th>
              <Th>Currency</Th>
              <Th>Billed</Th>
              <Th>Charged</Th>
              <Th>At the gateway</Th>
              <Th>Status</Th>
              <Th>Added</Th>
              {editable && <Th srOnly>Actions</Th>}
            </THead>
            <TBody>
              {prices.map((price) => (
                <Tr key={price.id}>
                  <Td nowrap muted={!price.active}>
                    {gatewayLabel(price.gateway)}
                  </Td>
                  <Td numeric muted={!price.active} className="font-medium">
                    {formatMoney(price.amount, price.currency)}
                  </Td>
                  <Td mono muted>
                    {price.currency}
                  </Td>
                  <Td nowrap muted={!price.active}>
                    {price.interval === "YEAR" ? "Yearly" : "Monthly"}
                  </Td>
                  <Td nowrap muted={!price.active}>
                    {price.perSeat ? "Per person" : "Flat"}
                  </Td>
                  <Td>{price.externalId ? <CopyField value={price.externalId} label={`${gatewayLabel(price.gateway)} id`} /> : <span className="text-subtle">—</span>}</Td>
                  <Td nowrap>
                    <StatusPill tone={price.active ? "success" : "neutral"} dot>
                      {price.active ? "On sale" : "Off sale"}
                    </StatusPill>
                  </Td>
                  <Td nowrap muted className="tabular-nums">
                    {dayMonthYear(price.createdAt)}
                  </Td>
                  {editable && (
                    <RowActionsCell>
                      {price.active && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => openRetire(price)} className="h-7 px-2 text-xs">
                          Take off sale
                        </Button>
                      )}
                    </RowActionsCell>
                  )}
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </Panel>

      <ConfirmDialog
        open={retiring !== null}
        onClose={() => setRetiring(null)}
        title="Take price off sale"
        confirmLabel="Take off sale"
        pending={retire.pending}
        error={retire.error}
        onConfirm={takeOffSale}
      >
        {retiring && (
          <p>
            <span className="font-medium">{priceText(retiring)}</span> at {gatewayLabel(retiring.gateway)} stops being offered. Workspaces already paying
            it keep it.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add price"
        confirmLabel="Create price"
        pending={add.pending}
        error={add.error}
        confirmDisabled={parsed.minor === null}
        onConfirm={createPrice}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={gatewayId}>Gateway</Label>
            <Select id={gatewayId} value={gateway} onChange={(e) => chooseGateway(e.target.value)}>
              <option value="RAZORPAY">Razorpay</option>
              <option value="STRIPE">Stripe</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={currencyId}>Currency</Label>
            <Input
              id={currencyId}
              value={currency}
              disabled={gateway === "RAZORPAY"}
              maxLength={3}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={currencyHintId}
              onChange={(e) => setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
              className="font-mono"
            />
            <p id={currencyHintId} className="text-xs text-muted">
              {gateway === "RAZORPAY" ? "Razorpay charges in rupees here." : "Three letters, like USD, EUR or AED."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={intervalId}>Billed</Label>
            <Select id={intervalId} value={billed} onChange={(e) => setBilled(e.target.value === "YEAR" ? "YEAR" : "MONTH")}>
              <option value="MONTH">Monthly</option>
              <option value="YEAR">Yearly</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={amountId}>Amount</Label>
            <Input
              id={amountId}
              value={amount}
              inputMode="decimal"
              autoComplete="off"
              placeholder="1499.00"
              aria-describedby={amountHintId}
              aria-invalid={parsed.error ? true : undefined}
              onChange={(e) => setAmount(e.target.value.slice(0, 16))}
              className="tabular-nums"
            />
            <p id={amountHintId} className={parsed.error ? "text-xs text-danger" : "text-xs text-muted"}>
              {parsed.error ?? `In ${currency || "the currency"}, not its smallest unit.`}
            </p>
          </div>
        </div>
        <label className="flex cursor-pointer items-start gap-2.5">
          <Checkbox checked={perSeat} onChange={(e) => setPerSeat(e.target.checked)} className="mt-0.5 shrink-0" />
          <span>
            <span className="block text-sm text-text">Per person</span>
            <span className="block text-xs text-muted">The workspace pays it for each person — its quantity is the number of people.</span>
          </span>
        </label>
        <InsetBlock>
          <p className="text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">Customers see</p>
          <p className="mt-1 text-lg font-semibold text-text tabular-nums">
            {parsed.minor !== null ? priceText({ amount: parsed.minor, currency, interval: billed, perSeat }) : "—"}
          </p>
          <p className="text-xs text-muted">at {gatewayLabel(gateway)}</p>
        </InsetBlock>
        <p>
          This creates the price at {gatewayLabel(gateway)} now.{" "}
          {replaced
            ? `The previous active price for ${currency} / ${intervalLabel(billed)} (${priceText(replaced)}) is taken off sale — workspaces paying it keep it.`
            : `Nothing else is taken off sale.`}
        </p>
      </ConfirmDialog>
    </>
  );
}
