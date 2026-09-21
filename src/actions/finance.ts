"use server";

import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { cashFlow, incomeAndExpense, topExpenses, type Basis, type CashFlow, type IncomeExpense } from "@/lib/finance/dashboard";
import { resolvePeriod, type PeriodKey } from "@/lib/finance/periods";
import { lookupRate, type RateLookup } from "@/lib/finance/exchange-rate";
import type { ActionResult } from "@/actions/company";

/**
 * Re-reading one finance card for a different window.
 *
 * Gated on the same permission the cards are rendered behind. The card is already on their screen,
 * so it is tempting to treat this as harmless — but it is a `"use server"` export, which means it is
 * a URL anybody signed in can call with any arguments they like. The check has to be here, not in
 * whatever rendered the card.
 *
 * `now` is read here rather than passed from the browser, for the same reason: a client that chose
 * its own idea of today could ask for a window the period list does not offer.
 */

async function gate() {
  const user = await requireUser();
  if (!(await isModuleEnabled("accounting"))) return { error: "The accounting module is switched off." };
  if (!(await can(user.id, "payments.manage"))) return { error: "You can't see the company's books." };
  return { error: null };
}

export type FinancePeriodResult = {
  incomeExpense: IncomeExpense;
  topExpenses: { name: string; amount: number }[];
  periodLabel: string;
};

/** The income-and-expense card and its top-expenses companion, which share a window. */
export async function financeForPeriod(
  period: PeriodKey,
  basis: Basis,
): Promise<ActionResult<FinancePeriodResult>> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const window = resolvePeriod(period, new Date());
  const [ie, top] = await Promise.all([
    incomeAndExpense(window.from, window.to, basis),
    topExpenses(window.from, window.to),
  ]);

  return { ok: true, data: { incomeExpense: ie, topExpenses: top, periodLabel: window.label } };
}

export type CashFlowResult = { cashFlow: CashFlow; from: Date; to: Date; periodLabel: string };

export async function cashFlowForPeriod(period: PeriodKey): Promise<ActionResult<CashFlowResult>> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const window = resolvePeriod(period, new Date());
  return {
    ok: true,
    data: {
      cashFlow: await cashFlow(window.from, window.to),
      from: window.from,
      to: window.to,
      periodLabel: window.label,
    },
  };
}

/**
 * What a currency was worth in rupees on a given day.
 *
 * A `"use server"` export, so it checks a session — but nothing stronger: the only thing it reveals
 * is a published exchange rate, which is not the company's information. The outbound call happens
 * here rather than in the browser; see lib/finance/exchange-rate.ts for why.
 */
export async function lookupExchangeRate(code: string, onDate: string): Promise<RateLookup> {
  await requireUser();
  return lookupRate(code, onDate);
}
