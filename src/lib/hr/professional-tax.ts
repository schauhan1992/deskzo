/**
 * Professional tax — a state levy on salary, so it follows where somebody works, not where the company
 * is registered. Pure, like the payroll engine beside it (src/lib/hr/payroll.ts), so every figure can
 * be re-run without a database.
 *
 * ## Dated rules, per state
 *
 * Each state carries the rules it has had, by the day they took effect, the way `PF_WAGE_CEILINGS`
 * does: a month is charged by the rule in force on its first day, so a run for a past month gives the
 * answer it gave then. A state the table doesn't know returns nothing and says so, rather than
 * applying another state's slabs.
 *
 * Three shapes:
 *   · **Monthly** — a slab on the month's gross. A slab may name a different February amount, which is
 *     how Maharashtra and Karnataka reach ₹2,500 a year (₹200 × 11 + ₹300). Maharashtra has a separate
 *     table for women.
 *   · **Half-yearly** — Tamil Nadu's: a slab on the half-year's income (April–September,
 *     October–March), charged once a half — on the half's last month, or the month somebody leaves in,
 *     on the pay of the half so far. Charging its half-yearly amounts every month, as this engine did,
 *     took ₹8,280 a year from somebody on ₹50,000 a month.
 *   · **Income-tax payers** — Punjab's State Development Tax: a flat amount a month from anyone whose
 *     income is taxable, read as "this payslip deducts income tax".
 *
 * Whatever the shape, nobody pays more than ₹2,500 in a financial year: Article 276(2) of the
 * Constitution caps it, and the cap is a hard stop on what earlier payslips that year have taken.
 *
 * ## Awaiting the CA
 *
 * Every rule here comes from secondary sources (docs/hrms-roadmap.md §3 lists them) and is marked
 * `awaitingCa` until a chartered accountant confirms the state's table. The flag changes nothing that
 * is charged; it is what `check:payroll` and the roadmap read to say what is unconfirmed.
 */

export const PT_ANNUAL_CAP = 2500;

/** A slab: everything up to `upTo` (inclusive), or above the last one; `february` where that month differs. */
export type PtSlab = { upTo: number | null; amount: number; february?: number };

export type PtRule =
  | { kind: "MONTHLY"; slabs: PtSlab[]; womenSlabs?: PtSlab[] }
  | { kind: "HALF_YEARLY"; slabs: PtSlab[]; note?: string }
  | { kind: "INCOME_TAX_PAYERS"; amount: number };

type Day = { year: number; month: number; day: number };
export type PtState = {
  label: string;
  /** Oldest first; the last whose day has come applies. */
  rules: { from: Day; rule: PtRule; source: string }[];
  awaitingCa: boolean;
};

const since = (year: number, month: number, day = 1): Day => ({ year, month, day });
const ANY_TIME = since(2000, 4);

const MAHARASHTRA_MEN: PtSlab[] = [
  { upTo: 7500, amount: 0 },
  { upTo: 10000, amount: 175 },
  { upTo: null, amount: 200, february: 300 },
];
const TAMIL_NADU_BEFORE_2024: PtSlab[] = [
  { upTo: 21000, amount: 0 },
  { upTo: 30000, amount: 135 },
  { upTo: 45000, amount: 315 },
  { upTo: 60000, amount: 690 },
  { upTo: 75000, amount: 1025 },
  { upTo: null, amount: 1250 },
];

export const PT_STATES: Record<string, PtState> = {
  MAHARASHTRA: {
    label: "Maharashtra",
    awaitingCa: true,
    rules: [
      { from: ANY_TIME, rule: { kind: "MONTHLY", slabs: MAHARASHTRA_MEN }, source: "Maharashtra's schedule, as this engine had it" },
      {
        // Women earning up to ₹25,000 a month pay nothing (Khaitan & Co, April 2023).
        from: since(2023, 4),
        rule: { kind: "MONTHLY", slabs: MAHARASHTRA_MEN, womenSlabs: [{ upTo: 25000, amount: 0 }, { upTo: null, amount: 200, february: 300 }] },
        source: "Khaitan & Co, Apr 2023 (docs/hrms-roadmap.md §3)",
      },
    ],
  },
  KARNATAKA: {
    label: "Karnataka",
    awaitingCa: true,
    rules: [
      { from: ANY_TIME, rule: { kind: "MONTHLY", slabs: [{ upTo: 24999, amount: 0 }, { upTo: null, amount: 200 }] }, source: "Karnataka's schedule, as this engine had it" },
      {
        // ₹300 in February so the year totals ₹2,500 (AscentHR).
        from: since(2025, 4),
        rule: { kind: "MONTHLY", slabs: [{ upTo: 24999, amount: 0 }, { upTo: null, amount: 200, february: 300 }] },
        source: "AscentHR (docs/hrms-roadmap.md §3)",
      },
    ],
  },
  TAMIL_NADU: {
    label: "Tamil Nadu",
    awaitingCa: true,
    rules: [
      { from: ANY_TIME, rule: { kind: "HALF_YEARLY", slabs: TAMIL_NADU_BEFORE_2024 }, source: "Greater Chennai Corporation's half-yearly table, as this engine had it" },
      {
        // Greater Chennai Corporation's revision from the second half of 2024-25. AscentHR and greytHR
        // disagree on the date; the CA confirms it, and other local bodies set their own amounts.
        from: since(2024, 10),
        rule: {
          kind: "HALF_YEARLY",
          slabs: [
            { upTo: 21000, amount: 0 },
            { upTo: 30000, amount: 180 },
            { upTo: 45000, amount: 425 },
            { upTo: 60000, amount: 930 },
            { upTo: 75000, amount: 1025 },
            { upTo: null, amount: 1250 },
          ],
          note: "Greater Chennai Corporation's table; other local bodies in Tamil Nadu set their own.",
        },
        source: "Greater Chennai Corporation revision, H2 2024-25: AscentHR, greytHR (docs/hrms-roadmap.md §3)",
      },
    ],
  },
  PUNJAB: {
    label: "Punjab",
    awaitingCa: true,
    // The Punjab State Development Tax — not called professional tax, collected the same way.
    rules: [{ from: since(2018, 4), rule: { kind: "INCOME_TAX_PAYERS", amount: 200 }, source: "Punjab State Development Tax: ClearTax, unconfirmed against the Act (docs/hrms-roadmap.md §3)" }],
  },
  WEST_BENGAL: {
    label: "West Bengal",
    awaitingCa: true,
    rules: [
      {
        from: ANY_TIME,
        rule: {
          kind: "MONTHLY",
          slabs: [
            { upTo: 10000, amount: 0 },
            { upTo: 15000, amount: 110 },
            { upTo: 25000, amount: 130 },
            { upTo: 40000, amount: 150 },
            { upTo: null, amount: 200 },
          ],
        },
        source: "West Bengal's schedule, as this engine had it",
      },
    ],
  },
  TELANGANA: {
    label: "Telangana",
    awaitingCa: true,
    rules: [
      {
        from: ANY_TIME,
        rule: { kind: "MONTHLY", slabs: [{ upTo: 15000, amount: 0 }, { upTo: 20000, amount: 150 }, { upTo: null, amount: 200 }] },
        source: "Telangana's schedule, as this engine had it",
      },
    ],
  },
  GUJARAT: {
    label: "Gujarat",
    awaitingCa: true,
    rules: [{ from: ANY_TIME, rule: { kind: "MONTHLY", slabs: [{ upTo: 12000, amount: 0 }, { upTo: null, amount: 200 }] }, source: "Gujarat's schedule, as this engine had it" }],
  },
};

/** States with no professional tax at all — named so the payslip can say so rather than look broken. */
export const PT_EXEMPT_STATES = ["DELHI", "HARYANA", "UTTAR PRADESH", "RAJASTHAN", "GOA"];

export function normaliseState(state: string | null | undefined) {
  return (state ?? "").trim().toUpperCase().replace(/\s+/g, "_");
}

/** The rule in force for a month: the last whose first day is on or before the month's first day. */
export function ptRuleFor(stateKey: string, year: number, month: number) {
  const state = PT_STATES[stateKey];
  if (!state) return null;
  const key = year * 10000 + month * 100 + 1;
  let found: (typeof state.rules)[number] | null = null;
  for (const r of state.rules) if (r.from.year * 10000 + r.from.month * 100 + r.from.day <= key) found = r;
  return found;
}

/** The half of the financial year a month is in: April–September, or October–March. */
export function halfYearOf(month: number): "FIRST" | "SECOND" {
  return month >= 4 && month <= 9 ? "FIRST" : "SECOND";
}

const slabFor = (slabs: PtSlab[], income: number) => slabs.find((s) => s.upTo === null || income <= s.upTo);

export type PtInput = {
  /** The month's gross earnings — what the slab is read on, for a monthly state. */
  monthGross: number;
  state: string | null | undefined;
  /** The wage month (1–12) and its year. */
  month: number;
  year: number;
  applicable: boolean;
  /** For Maharashtra's women's table. Unknown is read as the general table, with a warning where it matters. */
  gender?: "FEMALE" | "MALE" | "OTHER" | "UNDISCLOSED" | null;
  /** Half-yearly states: gross on this half's earlier payslips. */
  halfYearGrossBefore?: number;
  /** Professional tax on this financial year's earlier payslips — what the ₹2,500 cap counts down from. */
  paidThisYear?: number;
  /** Punjab: this payslip deducts income tax, so its income is taxable. */
  deductsIncomeTax?: boolean;
  /** Half-yearly states: their last month of employment, when the half's tax is due now rather than at its end. */
  leavingThisMonth?: boolean;
};

export type PtResult = { amount: number; known: boolean; stateLabel: string | null; awaitingCa: boolean; notes: string[] };

const rupees = (v: number) => `₹${v.toLocaleString("en-IN")}`;

export function computeProfessionalTax(input: PtInput): PtResult {
  const none = (known: boolean, stateLabel: string | null): PtResult => ({ amount: 0, known, stateLabel, awaitingCa: false, notes: [] });
  if (!input.applicable) return none(true, null);

  const key = normaliseState(input.state);
  if (!key) return none(false, null);
  if (PT_EXEMPT_STATES.includes(key.replace(/_/g, " "))) return none(true, key.replace(/_/g, " "));
  const state = PT_STATES[key];
  const found = ptRuleFor(key, input.year, input.month);
  if (!state || !found) return none(false, state?.label ?? key.replace(/_/g, " "));

  const notes: string[] = [];
  const rule = found.rule;
  let amount = 0;
  if (rule.kind === "MONTHLY") {
    const women = rule.womenSlabs && input.gender === "FEMALE";
    const slab = slabFor(women ? rule.womenSlabs! : rule.slabs, input.monthGross);
    amount = input.month === 2 && slab?.february !== undefined ? slab.february : (slab?.amount ?? 0);
    // The women's table matters only where it would answer differently — say so then, and only then.
    if (rule.womenSlabs && !input.gender) {
      const asWoman = slabFor(rule.womenSlabs, input.monthGross);
      const herAmount = input.month === 2 && asWoman?.february !== undefined ? asWoman.february : (asWoman?.amount ?? 0);
      if (herAmount !== amount) {
        notes.push(`No gender on the employee record, so ${state.label}'s general table was used (${rupees(amount)}). For a woman it would be ${rupees(herAmount)}.`);
      }
    }
  } else if (rule.kind === "HALF_YEARLY") {
    const due = input.month === 9 || input.month === 3 || input.leavingThisMonth === true;
    if (due) {
      const income = (input.halfYearGrossBefore ?? 0) + input.monthGross;
      amount = slabFor(rule.slabs, income)?.amount ?? 0;
      const half = halfYearOf(input.month) === "FIRST" ? "April to September" : "October to March";
      notes.push(`${state.label}'s professional tax is half-yearly: ${rupees(amount)} on the ${rupees(Math.round(income))} earned ${half}${input.leavingThisMonth && input.month !== 9 && input.month !== 3 ? ", charged now as this is their last month" : ""}.${rule.note ? ` ${rule.note}` : ""}`);
    }
  } else {
    amount = input.deductsIncomeTax ? rule.amount : 0;
  }

  // The cap is a hard stop on what this financial year's earlier payslips have taken.
  const room = Math.max(0, PT_ANNUAL_CAP - (input.paidThisYear ?? 0));
  if (amount > room) {
    notes.push(`Professional tax capped at ${rupees(room)}: ${rupees(input.paidThisYear ?? 0)} already deducted this financial year, and the year's limit is ${rupees(PT_ANNUAL_CAP)}.`);
    amount = room;
  }
  return { amount, known: true, stateLabel: state.label, awaitingCa: state.awaitingCa, notes };
}
