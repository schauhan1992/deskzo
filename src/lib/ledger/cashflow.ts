/**
 * The cash flow statement.
 *
 * Built by the *indirect* method, which is what Indian companies file and what an accountant
 * expects to see: start from the profit, add back what never moved any cash, then adjust for the
 * changes in working capital. The direct method — listing actual receipts and payments — is easier
 * to build from a ledger but nobody files it, so it would be a statement that answers a question
 * nobody asked.
 *
 * The whole point of this statement is the gap between profit and cash. A business can be
 * comfortably profitable and unable to pay salaries, because the profit is sitting in receivables;
 * a P&L cannot show that and this can.
 */

export type AccountMovement = {
  accountId: string;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  systemKey: string | null;
  /** Closing less opening, in the account's natural direction. */
  movement: number;
  opening: number;
  closing: number;
};

export type CashFlowLine = { label: string; amount: number; hint?: string };

export type CashFlow = {
  from: Date;
  to: Date;
  netProfit: number;
  operating: { lines: CashFlowLine[]; total: number };
  investing: { lines: CashFlowLine[]; total: number };
  financing: { lines: CashFlowLine[]; total: number };
  openingCash: number;
  closingCash: number;
  netChange: number;
  /** Whether the statement actually reconciles to the movement in cash. */
  reconciles: boolean;
  difference: number;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** The accounts that *are* cash — the thing the statement explains the movement in. */
const CASH_KEYS = new Set(["BANK", "CASH", "CHEQUES_IN_HAND"]);

/** Assets and liabilities that move with trading, as opposed to with investing or financing. */
const WORKING_CAPITAL_KEYS = new Set([
  "AR",
  "AP",
  "INPUT_CGST",
  "INPUT_SGST",
  "INPUT_IGST",
  "OUTPUT_CGST",
  "OUTPUT_SGST",
  "OUTPUT_IGST",
  "TDS_RECEIVABLE",
  "TDS_PAYABLE",
  "TCS_PAYABLE",
  "EMPLOYEE_PAYABLE",
  "SALARY_PAYABLE",
  "PF_PAYABLE",
  "ESI_PAYABLE",
  "PT_PAYABLE",
  "CHEQUES_ISSUED",
]);

/**
 * Accounts whose movement is not a cash flow at all.
 *
 * Accumulated depreciation is the one that catches people: it looks like an asset moving, so it
 * lands in investing — but the same figure has already been added back in operating as a non-cash
 * cost. Counting both makes the statement fail to reconcile by exactly the depreciation charged.
 */
const NON_CASH_KEYS = new Set(["ACCUMULATED_DEPRECIATION"]);

/**
 * Which section an account's movement belongs in.
 *
 * Fixed assets are investing — buying a laptop is not an operating cost, it is cash converted into
 * something you own. Equity and borrowings are financing. Everything else that is not cash is
 * working capital, and therefore operating.
 */
export function sectionFor(account: Pick<AccountMovement, "type" | "code" | "systemKey">): "CASH" | "OPERATING" | "INVESTING" | "FINANCING" | "PROFIT" | "NON_CASH" {
  if (account.systemKey && CASH_KEYS.has(account.systemKey)) return "CASH";
  if (account.systemKey && NON_CASH_KEYS.has(account.systemKey)) return "NON_CASH";
  if (account.type === "INCOME" || account.type === "EXPENSE") return "PROFIT";
  if (account.type === "EQUITY") return "FINANCING";
  // Fixed assets and their accumulated depreciation, by code range — the chart puts them in 12xx.
  if (account.type === "ASSET" && account.code.startsWith("12")) return "INVESTING";
  if (account.systemKey && WORKING_CAPITAL_KEYS.has(account.systemKey)) return "OPERATING";
  // An unrecognised long-term liability is financing; an unrecognised current asset is operating.
  if (account.type === "LIABILITY" && account.code.startsWith("22")) return "FINANCING";
  return "OPERATING";
}

/**
 * Builds the statement.
 *
 * `movement` on an asset is the increase in what we hold, which is a *use* of cash — receivables
 * going up by ₹5 lakh means ₹5 lakh of profit that has not arrived. On a liability it is the
 * reverse. Getting that sign backwards is the classic way to produce a cash flow statement that
 * looks plausible and reconciles to nothing, so the sign is applied in one place here rather than
 * at each line.
 */
export function buildCashFlow(params: {
  from: Date;
  to: Date;
  netProfit: number;
  movements: AccountMovement[];
  depreciationCharged: number;
}): CashFlow {
  const operating: CashFlowLine[] = [];
  const investing: CashFlowLine[] = [];
  const financing: CashFlowLine[] = [];

  operating.push({ label: "Net profit for the period", amount: round2(params.netProfit) });
  if (params.depreciationCharged !== 0) {
    operating.push({
      label: "Add back: depreciation",
      amount: round2(params.depreciationCharged),
      hint: "A cost that moved no cash — the money left when the asset was bought.",
    });
  }

  let openingCash = 0;
  let closingCash = 0;

  for (const m of params.movements) {
    const section = sectionFor(m);
    if (section === "CASH") {
      openingCash = round2(openingCash + m.opening);
      closingCash = round2(closingCash + m.closing);
      continue;
    }
    if (section === "PROFIT") {
      // Already inside the profit figure.
      continue;
    }
    if (section === "NON_CASH") {
      // Already added back above. Including it here as well is the classic way to produce a cash
      // flow statement that is out by exactly the depreciation charged.
      continue;
    }
    if (m.movement === 0) continue;

    // An asset going up consumes cash; a liability going up releases it.
    const isAsset = m.type === "ASSET";
    const amount = round2(isAsset ? -m.movement : m.movement);
    const label = isAsset
      ? `${m.movement > 0 ? "Increase" : "Decrease"} in ${m.name}`
      : `${m.movement > 0 ? "Increase" : "Decrease"} in ${m.name}`;

    if (section === "OPERATING") operating.push({ label, amount });
    else if (section === "INVESTING") {
      investing.push({ label, amount });
    } else financing.push({ label, amount });
  }

  const total = (lines: CashFlowLine[]) => round2(lines.reduce((t, l) => t + l.amount, 0));
  const operatingTotal = total(operating);
  const investingTotal = total(investing);
  const financingTotal = total(financing);

  const netChange = round2(operatingTotal + investingTotal + financingTotal);
  const actualChange = round2(closingCash - openingCash);
  const difference = round2(netChange - actualChange);

  return {
    from: params.from,
    to: params.to,
    netProfit: round2(params.netProfit),
    operating: { lines: operating, total: operatingTotal },
    investing: { lines: investing, total: investingTotal },
    financing: { lines: financing, total: financingTotal },
    openingCash,
    closingCash,
    netChange,
    // A cash flow statement that doesn't reconcile to the movement in cash is not a cash flow
    // statement, so it says so rather than presenting a number that happens to be wrong.
    reconciles: difference === 0,
    difference,
  };
}
