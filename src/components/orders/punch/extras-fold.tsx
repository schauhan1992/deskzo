"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Controller, useFieldArray, useWatch } from "react-hook-form";
import { listCommissionPartyAccountOptions } from "@/actions/commission-party";
import { orderExpenseTypeLabels, orderExpenseTypeValues } from "@/lib/validation/order";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { PersonCombobox } from "@/components/ui/person-combobox";
import { FieldError, Fold } from "./parts";
import { invalidProps, type CommissionPartyOption, type PersonOption, type PunchErrors, type PunchForm } from "./types";

type AccountOption = { id: string; label: string; isDefault: boolean };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * What the order costs besides the product — commission, freight, installation — and who else should
 * follow it. Both are set only here, when the order is punched; the order page shows them read-only.
 *
 * A commission is paid to a commission party, and once one is chosen their payee accounts are fetched
 * so the row can say which of them it was paid into.
 */
export function ExtrasFold({
  form,
  errors,
  commissionParties,
  linkedPartyIds,
  users,
  open,
  hasError,
  onOpenChange,
}: {
  form: PunchForm;
  errors: PunchErrors;
  commissionParties: CommissionPartyOption[];
  /** The parties tied to the chosen customer, listed first. */
  linkedPartyIds: string[];
  users: PersonOption[];
  open: boolean | undefined;
  hasError: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { control } = form;
  const { fields, append, remove } = useFieldArray({ control, name: "expenses" });
  const [expenses, watcherUserIds] = useWatch({ control, name: ["expenses", "watcherUserIds"] });
  const rows = expenses ?? [];
  const watching = watcherUserIds ?? [];

  const linked = new Set(linkedPartyIds);
  // Linked parties first, the rest in the order they came (by name); `sort` keeps ties where they were.
  const partyOptions: CompanyComboOption[] = [...commissionParties]
    .sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)))
    .map((p) => ({ id: p.id, name: p.name, hint: linked.has(p.id) ? "(linked to this customer)" : undefined }));

  // Once a Commission expense row has a payee, fetch that commission party's payee accounts so the
  // row can offer "which account" — their labels only: the PAN and bank details stay on the server.
  const [accountsByParty, setAccountsByParty] = useState<Record<string, AccountOption[]>>({});
  const fetchedPartyIdsRef = useRef<Set<string>>(new Set());
  const payeeIdsKey = rows.map((e) => (e?.type === "COMMISSION" ? e.payeeCompanyId || "" : "")).join(",");
  useEffect(() => {
    const payeeIds = Array.from(new Set(payeeIdsKey.split(",").filter(Boolean)));
    const missing = payeeIds.filter((id) => !fetchedPartyIdsRef.current.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map((id) =>
        listCommissionPartyAccountOptions(id)
          .then((accs) => [id, accs] as const)
          // Only remember a party as fetched once it actually succeeded, so a transient failure
          // doesn't permanently hide the account picker for it.
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const loaded = results.filter((r): r is NonNullable<typeof r> => r !== null);
      loaded.forEach(([id]) => fetchedPartyIdsRef.current.add(id));
      setAccountsByParty((prev) => {
        const next = { ...prev };
        for (const [id, accs] of loaded) next[id] = accs;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [payeeIdsKey]);

  const summary = [
    fields.length > 0 ? plural(fields.length, "expense") : null,
    watching.length > 0 ? plural(watching.length, "watcher") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Fold
      title="Expenses and watchers"
      summary={summary}
      open={open ?? (fields.length > 0 || watching.length > 0 || hasError)}
      onOpenChange={onOpenChange}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-text">Expenses</p>
            <p className="text-xs text-subtle">Commission, freight, installation — what the order costs besides the product.</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => append({ type: "COMMISSION", amount: "", notes: "", payeeCompanyId: "", payeeAccountId: "" })}
          >
            + Add expense
          </Button>
        </div>
        {fields.length === 0 && <p className="text-xs text-subtle">No expenses added.</p>}
        {fields.map((field, index) => {
          const payeeId = rows[index]?.payeeCompanyId || "";
          return (
            <ExpenseRow
              key={field.id}
              index={index}
              form={form}
              errors={errors}
              isCommission={rows[index]?.type === "COMMISSION"}
              payeeId={payeeId}
              partyOptions={partyOptions}
              accounts={payeeId ? (accountsByParty[payeeId] ?? []) : []}
              onRemove={() => remove(index)}
            />
          );
        })}
      </div>

      {/* A wrapper carries the rule: on the fieldset itself the border would run through its legend. */}
      <div className="border-t border-line pt-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text">Watchers</legend>
          <p className="text-xs text-subtle">They follow the order and its updates — tech support for an installation, say.</p>
          <Controller
            name="watcherUserIds"
            control={control}
            render={({ field }) => {
              const chosen = field.value ?? [];
              const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? "Someone";
              return (
                <div className="space-y-2">
                  {chosen.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {chosen.map((id) => (
                        <li
                          key={id}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunken",
                            "py-0.5 pl-2.5 pr-1 text-xs text-text",
                          )}
                        >
                          {nameOf(id)}
                          <button
                            type="button"
                            aria-label={`Remove ${nameOf(id)} as a watcher`}
                            onClick={() => field.onChange(chosen.filter((w) => w !== id))}
                            className="rounded-full p-0.5 text-subtle hover:bg-surface hover:text-text"
                          >
                            <X aria-hidden="true" className="h-3 w-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="sm:max-w-sm">
                    <Label htmlFor="watcherPicker" className="sr-only">
                      Add a watcher
                    </Label>
                    {/*
                      Chosen people leave the list, and the field empties itself once somebody is picked.
                      Enter on a typed name adds the top match: the field sits inside the order's form,
                      where Enter would otherwise punch the order and drop the watcher being added.
                    */}
                    <PersonCombobox
                      id="watcherPicker"
                      autoHighlightFirst="typed"
                      people={users.filter((u) => !chosen.includes(u.id))}
                      value=""
                      onSelect={(person) => {
                        if (person) field.onChange([...chosen, person.id]);
                      }}
                      placeholder="Add a person…"
                      emptyText={users.length === 0 ? "Nobody else to add." : "Nobody matches that."}
                    />
                  </div>
                </div>
              );
            }}
          />
        </fieldset>
      </div>
    </Fold>
  );
}

/**
 * One expense. Its fields are named by aria-label rather than a `<Label htmlFor>` pairing: they repeat
 * per row, so a label would need a unique id anyway, and the row number is what tells a screen reader
 * which of five amount boxes it has landed in. Ids built from the row's key would differ between the
 * server's markup and the browser's (scripts/check-address.ts), so the error ids use the index.
 */
function ExpenseRow({
  index,
  form,
  errors,
  isCommission,
  payeeId,
  partyOptions,
  accounts,
  onRemove,
}: {
  index: number;
  form: PunchForm;
  errors: PunchErrors;
  isCommission: boolean;
  payeeId: string;
  partyOptions: CompanyComboOption[];
  accounts: AccountOption[];
  onRemove: () => void;
}) {
  const { control, register, setValue } = form;
  const rowError = errors.expenses?.[index];
  // The schema's own words for a blank amount are about types, not money.
  const amountError = rowError?.amount ? "Enter an amount above zero." : undefined;
  return (
    <div className="space-y-2 rounded-md border border-line p-2.5">
      {/* By the fold's width, not the screen's (see `Fold`): one to a line, then two, then all four once the notes have room. */}
      <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2 @sm:items-start @lg:grid-cols-[9rem_8rem_minmax(0,1fr)_auto]">
        <Select {...register(`expenses.${index}.type`)} aria-label={`Expense ${index + 1} type`}>
          {orderExpenseTypeValues.map((t) => (
            <option key={t} value={t}>
              {orderExpenseTypeLabels[t]}
            </option>
          ))}
        </Select>
        <div className="space-y-1">
          <Input
            type="number"
            step="0.01"
            placeholder="Amount"
            aria-label={`Expense ${index + 1} amount`}
            className="aria-[invalid=true]:border-danger"
            {...register(`expenses.${index}.amount`)}
            {...invalidProps(`expenses.${index}.amount`, amountError)}
          />
          <FieldError id={`expenses.${index}.amount`} message={amountError} />
        </div>
        <Input placeholder="Notes (optional)" aria-label={`Expense ${index + 1} notes`} {...register(`expenses.${index}.notes`)} />
        <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {isCommission && (
        <div className="grid grid-cols-1 gap-2 @sm:grid-cols-[minmax(0,16rem)_minmax(0,14rem)] @sm:items-start">
          <div className="space-y-1">
            <Controller
              name={`expenses.${index}.payeeCompanyId`}
              control={control}
              render={({ field }) => (
                <CompanyCombobox
                  inputRef={field.ref}
                  companies={partyOptions}
                  value={field.value ?? ""}
                  autoHighlightFirst="typed"
                  {...invalidProps(`expenses.${index}.payeeCompanyId`, rowError?.payeeCompanyId?.message)}
                  onSelect={(party) => {
                    field.onChange(party?.id ?? "");
                    // The account list belongs to the previous payee — clear it, or the order
                    // records a payout into an account owned by a different commission party.
                    setValue(`expenses.${index}.payeeAccountId`, "");
                  }}
                  placeholder="Paid to — search commission parties…"
                />
              )}
            />
            {partyOptions.length === 0 && (
              <p className="text-xs text-subtle">No commission parties on file yet — add one from the Commission Parties module first.</p>
            )}
            <FieldError id={`expenses.${index}.payeeCompanyId`} message={rowError?.payeeCompanyId?.message} />
          </div>
          {payeeId && accounts.length > 0 && (
            <Select {...register(`expenses.${index}.payeeAccountId`)} aria-label={`Expense ${index + 1} payee account`}>
              <option value="">Which account? (optional)</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.isDefault ? " (default)" : ""}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}
    </div>
  );
}
