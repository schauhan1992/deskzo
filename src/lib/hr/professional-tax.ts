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
 *     income is taxable, read as "this payslip deducts income tax", and never from a senior citizen.
 *
 * A slab's `upTo` is inside it: the Acts say "not exceeding" (Maharashtra, West Bengal, Gujarat) or
 * "below" the next figure (Karnataka's "₹25,000 and above" is `upTo: 24999`).
 *
 * Whatever the shape, nobody pays more than ₹2,500 in a financial year: Article 276(2) of the
 * Constitution caps it, and the cap is a hard stop on what earlier payslips that year have taken.
 *
 * ## Checked against the law, 17 Oct 2026
 *
 * Every rule names the instrument it comes from. They were checked on 17 Oct 2026 against the state
 * Acts, amending Acts and notifications where those could be read, and against payroll publishers
 * where only they could be (`checked.confidence` says which, and `checked.note` what is still open).
 * That is a check, not a chartered accountant's sign-off: a state that changes its schedule changes
 * it here by a new dated rule, never by editing an old one.
 */

export const PT_ANNUAL_CAP = 2500;

/**
 * A slab: everything up to `upTo` (inclusive), or above the last one. `february` or `march` where that
 * month's amount differs — the month that rounds the year to its total (₹200 × 11 + ₹300 in Maharashtra's
 * February; ₹208 × 11 + ₹212 in Madhya Pradesh's March).
 */
export type PtSlab = { upTo: number | null; amount: number; february?: number; march?: number };

export type PtRule =
  /**
   * A monthly amount. `annualised`: the slab is read on the year's salary — the month's rate × 12 — as
   * the states whose Acts tax annual salary but collect it monthly do (Madhya Pradesh, Jharkhand).
   */
  | { kind: "MONTHLY"; slabs: PtSlab[]; womenSlabs?: PtSlab[]; annualised?: boolean }
  /**
   * A half-yearly amount on the half-year's income, charged in `dueMonths` (the halves' last months,
   * September and March, unless the state collects earlier: Kerala's local bodies in August and
   * February, with the rest of the half taken at this month's rate).
   */
  | { kind: "HALF_YEARLY"; slabs: PtSlab[]; dueMonths?: [first: number, second: number]; note?: string }
  /**
   * A year's tax on the year's salary, charged once — Bihar takes it from September's salary, and from
   * February's anyone not charged then or owing more.
   */
  | { kind: "ANNUAL_ONCE"; slabs: PtSlab[]; dueMonth: number; catchUpMonth: number }
  | { kind: "INCOME_TAX_PAYERS"; amount: number; seniorCitizensExempt: boolean }
  /** No professional tax from this day — Odisha repealed its Act from 1 Apr 2026. */
  | { kind: "NONE"; reason: string };

type Day = { year: number; month: number; day: number };
export type PtState = {
  label: string;
  /** Oldest first; the last whose day has come applies. */
  rules: { from: Day; rule: PtRule; source: string }[];
  /** When the table was last checked against the law, how firmly, and what is still open. */
  checked: { on: string; confidence: "high" | "medium" | "low"; note?: string };
};

const since = (year: number, month: number, day = 1): Day => ({ year, month, day });
const ANY_TIME = since(2000, 4);
const CHECKED = "2026-10-17";

const MAHARASHTRA_MEN: PtSlab[] = [
  { upTo: 7500, amount: 0 },
  { upTo: 10000, amount: 175 },
  { upTo: null, amount: 200, february: 300 },
];
/** Greater Chennai Corporation's half-yearly bands; only the amounts change between revisions. */
const chennai = (amounts: [number, number, number, number, number]): PtSlab[] => [
  { upTo: 21000, amount: 0 },
  { upTo: 30000, amount: amounts[0] },
  { upTo: 45000, amount: amounts[1] },
  { upTo: 60000, amount: amounts[2] },
  { upTo: 75000, amount: amounts[3] },
  { upTo: null, amount: amounts[4] },
];
const CHENNAI_NOTE = "Greater Chennai Corporation's table; other corporations and municipalities in Tamil Nadu set their own (Coimbatore's and Madurai's differ).";

export const PT_STATES: Record<string, PtState> = {
  MAHARASHTRA: {
    label: "Maharashtra",
    checked: { on: CHECKED, confidence: "high", note: "Before 1 Jul 2014 the table isn't confirmed; the one from then is used for anything earlier." },
    rules: [
      { from: ANY_TIME, rule: { kind: "MONTHLY", slabs: MAHARASHTRA_MEN }, source: "Maharashtra State Tax on Professions, Trades, Callings and Employments Act, 1975, Schedule I entry 1, as in force from 1 Jul 2014" },
      {
        // Women earning up to ₹10,000 a month pay nothing.
        from: since(2015, 4),
        rule: { kind: "MONTHLY", slabs: MAHARASHTRA_MEN, womenSlabs: [{ upTo: 10000, amount: 0 }, { upTo: null, amount: 200, february: 300 }] },
        source: "Mah. Act XVII of 2015 (gazette 18 Apr 2015); MahaGST rate schedule, mahagst.gov.in",
      },
      {
        // Women earning up to ₹25,000 a month pay nothing.
        from: since(2023, 4),
        rule: { kind: "MONTHLY", slabs: MAHARASHTRA_MEN, womenSlabs: [{ upTo: 25000, amount: 0 }, { upTo: null, amount: 200, february: 300 }] },
        source: "Mah. Act XIX of 2023, s.1(2) in force 1 Apr 2023 (gazette 6 Apr 2023), substituting Schedule I entry 1",
      },
    ],
  },
  KARNATAKA: {
    label: "Karnataka",
    checked: { on: CHECKED, confidence: "high", note: "The tables before 1 Apr 2023 are from payroll publishers (medium); Act 14 of 2015's text wasn't read." },
    rules: [
      {
        from: ANY_TIME,
        rule: { kind: "MONTHLY", slabs: [{ upTo: 9999, amount: 0 }, { upTo: 14999, amount: 150 }, { upTo: null, amount: 200 }] },
        source: "Karnataka Tax on Professions, Trades, Callings and Employments Act, 1976, Schedule entry 1, before 2015 (payroll publishers)",
      },
      {
        from: since(2015, 4),
        rule: { kind: "MONTHLY", slabs: [{ upTo: 14999, amount: 0 }, { upTo: null, amount: 200 }] },
        source: "Karnataka Act 14 of 2015, as payroll publishers record it",
      },
      {
        from: since(2023, 4),
        rule: { kind: "MONTHLY", slabs: [{ upTo: 24999, amount: 0 }, { upTo: null, amount: 200 }] },
        source: "Karnataka Act No. 14 of 2023 (gazette 14 Mar 2023, in force 1 Apr 2023), substituting the Schedule",
      },
      {
        // ₹300 in February, so the year totals ₹2,500.
        from: since(2025, 4),
        rule: { kind: "MONTHLY", slabs: [{ upTo: 24999, amount: 0 }, { upTo: null, amount: 200, february: 300 }] },
        source: "Karnataka Act No. 33 of 2025 (gazette 15 Apr 2025, in force 1 Apr 2025)",
      },
    ],
  },
  TAMIL_NADU: {
    label: "Tamil Nadu",
    checked: {
      on: CHECKED,
      confidence: "medium",
      note: "Greater Chennai Corporation's table only — each local body sets its own. No Government Order approving the 2024 revision was found; the corporation has applied it since. The table before 1 Apr 2018 is from payroll publishers.",
    },
    rules: [
      { from: ANY_TIME, rule: { kind: "HALF_YEARLY", slabs: chennai([100, 235, 510, 760, 1095]), note: CHENNAI_NOTE }, source: "Greater Chennai Corporation, before 1 Apr 2018 (payroll publishers)" },
      { from: since(2018, 4), rule: { kind: "HALF_YEARLY", slabs: chennai([135, 315, 690, 1025, 1250]), note: CHENNAI_NOTE }, source: "Greater Chennai Corporation notification no. 70, from 1 Apr 2018" },
      {
        // The 35% rise on the three lower bands, from the second half of 2024-25.
        from: since(2024, 10),
        rule: { kind: "HALF_YEARLY", slabs: chennai([180, 425, 930, 1025, 1250]), note: CHENNAI_NOTE },
        source: "Greater Chennai Corporation notice R.D.(HQ).C.No.PT/SPL/2024 (6 Mar 2025), under the Tamil Nadu Urban Local Bodies Act, 1998, ss.117-B to 117-F",
      },
    ],
  },
  PUNJAB: {
    label: "Punjab",
    checked: {
      on: CHECKED,
      confidence: "high",
      note: "The optional ₹2,200 lump sum a year (2025 amendment) isn't applied — its commencement notification wasn't found. The Act's income test still names the Income-tax Act, 1961.",
    },
    // The Punjab State Development Tax — not called professional tax, collected the same way.
    rules: [
      {
        from: since(2018, 4, 19),
        rule: { kind: "INCOME_TAX_PAYERS", amount: 200, seniorCitizensExempt: true },
        source: "Punjab State Development Tax Act, 2018 (Punjab Act No. 11 of 2018, gazette 19 Apr 2018), s.4 and the Schedule",
      },
    ],
  },
  WEST_BENGAL: {
    label: "West Bengal",
    checked: {
      on: CHECKED,
      confidence: "medium",
      note: "The 1 Oct 2026 schedule is notification 1607-F.T. (16 Sep 2026); its gazette text wasn't read — the draft (1407-F.T.) and four payroll publishers agree on the salary slabs.",
    },
    rules: [
      {
        from: ANY_TIME,
        rule: { kind: "MONTHLY", slabs: [{ upTo: 8500, amount: 0 }, { upTo: 10000, amount: 90 }, { upTo: 15000, amount: 110 }, { upTo: 25000, amount: 130 }, { upTo: 40000, amount: 150 }, { upTo: null, amount: 200 }] },
        source: "West Bengal Finance Act, 2014 (440-L, 11 Mar 2014) with 848-F.T. (28 May 2014)",
      },
      {
        from: since(2016, 8),
        rule: { kind: "MONTHLY", slabs: [{ upTo: 10000, amount: 0 }, { upTo: 15000, amount: 110 }, { upTo: 25000, amount: 130 }, { upTo: 40000, amount: 150 }, { upTo: null, amount: 200 }] },
        source: "West Bengal Finance Act, 2016 (682-L, 28 Jul 2016) with 1197-F.T. (16 Aug 2016); comtax.wb.gov.in schedule",
      },
      {
        from: since(2026, 10),
        rule: { kind: "MONTHLY", slabs: [{ upTo: 20000, amount: 0 }, { upTo: 30000, amount: 100 }, { upTo: 50000, amount: 140 }, { upTo: 100000, amount: 170 }, { upTo: null, amount: 208 }] },
        source: "West Bengal Finance Act, 2026 (XIII of 2026, s.3(2A)); notification 1607-F.T. of 16 Sep 2026, salaries from 1 Oct 2026",
      },
    ],
  },
  TELANGANA: {
    label: "Telangana",
    checked: { on: CHECKED, confidence: "medium", note: "The Andhra Pradesh schedule of 2013, carried over; no change since was found." },
    rules: [
      {
        from: ANY_TIME,
        rule: { kind: "MONTHLY", slabs: [{ upTo: 15000, amount: 0 }, { upTo: 20000, amount: 150 }, { upTo: null, amount: 200 }] },
        source: "Andhra Pradesh Tax on Professions, Trades, Callings and Employments (Amendment) Act, 2013 (Act 12 of 2013; G.O.Ms. No. 82, 4 Feb 2013), as adapted by Telangana",
      },
    ],
  },
  GUJARAT: {
    label: "Gujarat",
    checked: { on: CHECKED, confidence: "medium", note: "Notification GHN-35-PFT-2022 is known from payroll publishers only; most give 1 Apr 2022, one 24 May 2022." },
    rules: [
      {
        from: ANY_TIME,
        rule: { kind: "MONTHLY", slabs: [{ upTo: 5999, amount: 0 }, { upTo: 8999, amount: 80 }, { upTo: 11999, amount: 150 }, { upTo: null, amount: 200 }] },
        source: "Gujarat's notification of 1 Apr 2008 (payroll publishers)",
      },
      {
        // ₹12,000 itself is nil: "if pay exceeds ₹12,000".
        from: since(2022, 4),
        rule: { kind: "MONTHLY", slabs: [{ upTo: 12000, amount: 0 }, { upTo: null, amount: 200 }] },
        source: "Notification GHN-35-PFT-2022-S.3(2)(10)-Th, under the Gujarat … State Tax on Professions, Traders, Callings and Employments Act, 1976",
      },
    ],
  },
  ANDHRA_PRADESH: {
    label: "Andhra Pradesh",
    checked: { on: CHECKED, confidence: "high" },
    rules: [
      {
        from: ANY_TIME,
        rule: { kind: "MONTHLY", slabs: [{ upTo: 15000, amount: 0 }, { upTo: 20000, amount: 150 }, { upTo: null, amount: 200 }] },
        source: "Andhra Pradesh Tax on Professions, Trades, Callings and Employments (Amendment) Act, 2013 (Act 12 of 2013, deemed in force 6 Feb 2013), First Schedule",
      },
    ],
  },
  KERALA: {
    label: "Kerala",
    checked: {
      on: CHECKED,
      confidence: "medium",
      note: "The rates are certain; the deduction months are practice (local bodies collect by 31 Aug and the end of February). Somebody employed fewer than 60 days in a half isn't liable — not checked here. No table before 1 Oct 2024 on file.",
    },
    rules: [
      {
        from: since(2024, 10),
        rule: {
          kind: "HALF_YEARLY",
          dueMonths: [8, 2],
          slabs: [
            { upTo: 11999, amount: 0 },
            { upTo: 17999, amount: 320 },
            { upTo: 29999, amount: 450 },
            { upTo: 44999, amount: 600 },
            { upTo: 99999, amount: 750 },
            { upTo: 124999, amount: 1000 },
            { upTo: null, amount: 1250 },
          ],
          note: "Kerala's local bodies collect it by the end of August and of February.",
        },
        source: "G.O.(Rt) No.1149/2024/LSGD (27 Jun 2024), under the Kerala Municipality Act, 1994 s.245 and the Kerala Panchayat Raj Act, 1994 s.204",
      },
    ],
  },
  MADHYA_PRADESH: {
    label: "Madhya Pradesh",
    checked: { on: CHECKED, confidence: "high", note: "Read on the year's salary as this month's rate × 12. No table before 1 Apr 2018 on file." },
    rules: [
      {
        from: since(2018, 4),
        rule: {
          kind: "MONTHLY",
          annualised: true,
          slabs: [
            { upTo: 225000, amount: 0 },
            { upTo: 300000, amount: 125 },
            { upTo: 400000, amount: 166, march: 174 },
            { upTo: null, amount: 208, march: 212 },
          ],
        },
        source: "Madhya Pradesh Vritti Kar (Sanshodhan) Adhiniyam, 2018 (Act 20 of 2018, in force 1 Apr 2018), Schedule entry 1",
      },
    ],
  },
  ODISHA: {
    label: "Odisha",
    checked: {
      on: CHECKED,
      confidence: "high",
      note: "Repealed from 1 Apr 2026 by Ordinance 02 of 2026; a bill to replace it was before the Assembly in Sep 2026 — if it isn't enacted, the ordinance lapses (early Nov 2026).",
    },
    rules: [
      {
        from: ANY_TIME,
        rule: { kind: "MONTHLY", annualised: true, slabs: [{ upTo: 159999, amount: 0 }, { upTo: 300000, amount: 125 }, { upTo: null, amount: 200, march: 300 }] },
        source: "Odisha State Tax on Professions, Trades, Callings and Employments Act, 2000 (odishatax portal)",
      },
      {
        from: since(2026, 4),
        rule: { kind: "NONE", reason: "Odisha repealed professional tax from 1 Apr 2026." },
        source: "Odisha State Tax on Professions, Trades, Callings and Employments (Repeal) Ordinance, 2026 (Ordinance 02 of 2026, Gazette No.1496, 21 Apr 2026)",
      },
    ],
  },
  ASSAM: {
    label: "Assam",
    checked: { on: CHECKED, confidence: "high", note: "The 2025 table was in force on publication, 2 Apr 2025; applied here from April 2025's salary, as payroll providers did." },
    rules: [
      {
        from: ANY_TIME,
        rule: { kind: "MONTHLY", slabs: [{ upTo: 10000, amount: 0 }, { upTo: 14999, amount: 150 }, { upTo: 24999, amount: 180 }, { upTo: null, amount: 208 }] },
        source: "Assam Professions, Trades, Callings and Employments Taxation Act, 1947, Schedule entry 1 as of 15 Oct 2014",
      },
      {
        from: since(2025, 4),
        rule: { kind: "MONTHLY", slabs: [{ upTo: 15000, amount: 0 }, { upTo: 24999, amount: 180 }, { upTo: null, amount: 208 }] },
        source: "Notification eCF No.169350/124 (1 Apr 2025), Assam Gazette Extraordinary No.139",
      },
    ],
  },
  BIHAR: {
    label: "Bihar",
    checked: { on: CHECKED, confidence: "medium", note: "From the Bihar Professional Tax Rules, 2011 (rule 5); the Act's text wasn't read. Read on the year's salary as this month's rate × 12." },
    rules: [
      {
        from: ANY_TIME,
        rule: {
          kind: "ANNUAL_ONCE",
          dueMonth: 9,
          catchUpMonth: 2,
          slabs: [{ upTo: 300000, amount: 0 }, { upTo: 500000, amount: 1000 }, { upTo: 1000000, amount: 2000 }, { upTo: null, amount: 2500 }],
        },
        source: "Bihar Professional Tax Act, 2011, and Rules, 2011, r.5(1) (September's salary) and r.5(4)(a) (February's)",
      },
    ],
  },
  JHARKHAND: {
    label: "Jharkhand",
    checked: {
      on: CHECKED,
      confidence: "medium",
      note: "The Act taxes the year's salary and doesn't split it by month — ₹100/₹150/₹175, and ₹208 with ₹212 in March, is payroll practice. Read as this month's rate × 12. Liability needs 120 days' work in the year — not checked here.",
    },
    rules: [
      {
        from: ANY_TIME,
        rule: {
          kind: "MONTHLY",
          annualised: true,
          slabs: [
            { upTo: 300000, amount: 0 },
            { upTo: 500000, amount: 100 },
            { upTo: 800000, amount: 150 },
            { upTo: 1000000, amount: 175 },
            { upTo: null, amount: 208, march: 212 },
          ],
        },
        source: "Jharkhand Tax on Profession, Trades, Callings and Employments Act, 2011, s.3 and the Schedule (ctax.jharkhand.gov.in)",
      },
    ],
  },
  SIKKIM: {
    label: "Sikkim",
    checked: { on: CHECKED, confidence: "medium" },
    rules: [
      {
        from: ANY_TIME,
        rule: { kind: "MONTHLY", slabs: [{ upTo: 20000, amount: 0 }, { upTo: 30000, amount: 125 }, { upTo: 40000, amount: 150 }, { upTo: null, amount: 200 }] },
        source: "Sikkim Tax on Professions, Trades, Callings and Employments Act, 2006 (Act 5 of 2006), Schedule",
      },
    ],
  },
  TRIPURA: {
    label: "Tripura",
    checked: { on: CHECKED, confidence: "high", note: "No table before 25 Jul 2018 on file." },
    rules: [
      {
        from: since(2018, 7, 25),
        rule: { kind: "MONTHLY", slabs: [{ upTo: 7500, amount: 0 }, { upTo: 15000, amount: 150 }, { upTo: null, amount: 208 }] },
        source: "Notification No.F.II-1(7)-TAX/99(P-I) (25 Jul 2018), Gazette Extraordinary No.443, with the corrigendum of 30 Oct 2018",
      },
    ],
  },
  MIZORAM: {
    label: "Mizoram",
    checked: { on: CHECKED, confidence: "medium", note: "The notification applies 'with reference to the return period 2024-25'; taken here from its date, 11 Jul 2024. No table before it on file." },
    rules: [
      {
        from: since(2024, 7, 11),
        rule: {
          kind: "MONTHLY",
          slabs: [
            { upTo: 5000, amount: 0 },
            { upTo: 8000, amount: 75 },
            { upTo: 10000, amount: 120 },
            { upTo: 12000, amount: 150 },
            { upTo: 15000, amount: 180 },
            { upTo: 20000, amount: 195 },
            { upTo: null, amount: 208 },
          ],
        },
        source: "Notification No.J.17011/1/2017-TAX (11 Jul 2024), superseding that of 24 May 2013",
      },
    ],
  },
  NAGALAND: {
    label: "Nagaland",
    checked: { on: CHECKED, confidence: "medium", note: "The rates are from the Commissioner's public notice of 21 Feb 2022; the amending Act and its date weren't confirmed." },
    rules: [
      {
        from: ANY_TIME,
        rule: {
          kind: "MONTHLY",
          slabs: [
            { upTo: 3999, amount: 0 },
            { upTo: 4999, amount: 35 },
            { upTo: 6999, amount: 75 },
            { upTo: 8999, amount: 110 },
            { upTo: 11999, amount: 180 },
            { upTo: null, amount: 208 },
          ],
        },
        source: "Commissioner of State Taxes, Nagaland, public notice CT/LEG/P.TAX/2/2022/1011 (21 Feb 2022)",
      },
    ],
  },
};

/**
 * Not in the table above, on purpose — their current law couldn't be confirmed on 17 Oct 2026, so a
 * payslip there says "no slab on file" rather than guessing: Meghalaya (its 2022 Act left the rates to
 * a notification that wasn't found), Manipur (its 2020 table's commencement wasn't found), Puducherry
 * (the Act's amounts are maxima, the government's order calls them minima), and Jammu & Kashmir and
 * Dadra & Nagar Haveli and Daman & Diu (Acts on the books, no collection found).
 */

/**
 * States and union territories with no professional tax on salary — named so the payslip can say so
 * rather than look broken. Checked 17 Oct 2026: no Act, or (Goa) a bill never brought into force, or
 * (Chhattisgarh) everyone exempted from the whole Act since 1 Apr 2011 (notification F-10/22/2011/CT/V(22)).
 * Ladakh's is medium confidence: whether Jammu & Kashmir's 2005 Act carried over wasn't confirmed.
 */
export const PT_EXEMPT_STATES = [
  "Delhi",
  "Haryana",
  "Uttar Pradesh",
  "Rajasthan",
  "Goa",
  "Himachal Pradesh",
  "Uttarakhand",
  "Chandigarh",
  "Arunachal Pradesh",
  "Andaman & Nicobar Islands",
  "Lakshadweep",
  "Ladakh",
  "Chhattisgarh",
];

/** A state name reduced to its letters: "Tamil Nadu", "TAMIL_NADU" and "tamil-nadu" are one state, as are "&" and "and". */
const letters = (name: string) =>
  name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word && word !== "and" && word !== "the")
    .join("");
const KEY_BY_LETTERS = new Map(Object.entries(PT_STATES).map(([key, s]) => [letters(s.label), key]));
const EXEMPT_BY_LETTERS = new Map(PT_EXEMPT_STATES.map((name) => [letters(name), name]));

/** The table's key for a state however it was written ("Tamil Nadu", "tamil_nadu"), or its letters when the table has no such state. */
export function normaliseState(state: string | null | undefined) {
  const l = letters(state ?? "");
  return KEY_BY_LETTERS.get(l) ?? l;
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
/** A slab's amount for a month: its February or March figure where it has one. */
const amountIn = (slab: PtSlab | undefined, month: number) => (!slab ? 0 : month === 2 && slab.february !== undefined ? slab.february : month === 3 && slab.march !== undefined ? slab.march : slab.amount);

export type PtInput = {
  /** The month's gross earnings — what the slab is read on, for a monthly state. */
  monthGross: number;
  /**
   * The month's full rate, before loss of pay — what a state taxing the year's salary reads (× 12), and
   * a half-yearly one collecting early takes for the half's months still to come. Left out, `monthGross`.
   */
  monthRate?: number;
  state: string | null | undefined;
  /** The wage month (1–12) and its year. */
  month: number;
  year: number;
  applicable: boolean;
  /** For Maharashtra's women's table. Unknown is read as the general table, with a warning where it matters. */
  gender?: "FEMALE" | "MALE" | "OTHER" | "UNDISCLOSED" | null;
  /** Half-yearly states: gross on this half's earlier payslips. */
  halfYearGrossBefore?: number;
  /** Half-yearly states: the tax this half's earlier payslips took — the half is charged once. */
  paidThisHalf?: number;
  /** Professional tax on this financial year's earlier payslips — what the ₹2,500 cap counts down from. */
  paidThisYear?: number;
  /** Punjab: this payslip deducts income tax, so its income is taxable. */
  deductsIncomeTax?: boolean;
  /** Punjab: 60 or over at some point in the financial year — exempt, as the Income-tax Act's senior citizens. */
  seniorCitizen?: boolean;
  /** Half-yearly states: their last month of employment, when the half's tax is due now rather than at its end. */
  leavingThisMonth?: boolean;
};

export type PtResult = { amount: number; known: boolean; stateLabel: string | null; notes: string[] };

const rupees = (v: number) => `₹${v.toLocaleString("en-IN")}`;

export function computeProfessionalTax(input: PtInput): PtResult {
  const none = (known: boolean, stateLabel: string | null): PtResult => ({ amount: 0, known, stateLabel, notes: [] });
  if (!input.applicable) return none(true, null);

  const l = letters(input.state ?? "");
  if (!l) return none(false, null);
  const exempt = EXEMPT_BY_LETTERS.get(l);
  if (exempt) return none(true, exempt);
  const key = KEY_BY_LETTERS.get(l);
  const state = key ? PT_STATES[key] : undefined;
  const found = key ? ptRuleFor(key, input.year, input.month) : null;
  if (!state || !found) return none(false, state?.label ?? (input.state ?? "").trim());

  const notes: string[] = [];
  const rule = found.rule;
  const rate = input.monthRate ?? input.monthGross;
  let amount = 0;
  if (rule.kind === "MONTHLY") {
    const income = rule.annualised ? rate * 12 : input.monthGross;
    const women = rule.womenSlabs && input.gender === "FEMALE";
    amount = amountIn(slabFor(women ? rule.womenSlabs! : rule.slabs, income), input.month);
    // The women's table matters only where it would answer differently — say so then, and only then.
    if (rule.womenSlabs && !input.gender) {
      const herAmount = amountIn(slabFor(rule.womenSlabs, income), input.month);
      if (herAmount !== amount) {
        notes.push(`No gender on the employee record, so ${state.label}'s general table was used (${rupees(amount)}). For a woman it would be ${rupees(herAmount)}.`);
      }
    }
  } else if (rule.kind === "HALF_YEARLY") {
    const [firstDue, secondDue] = rule.dueMonths ?? [9, 3];
    const half = halfYearOf(input.month);
    const due = input.month === (half === "FIRST" ? firstDue : secondDue) || input.leavingThisMonth === true;
    if (due) {
      // Collected before the half ends, the months still to come are taken at this month's rate.
      const lastOfHalf = half === "FIRST" ? 9 : 3;
      const monthsToCome = input.leavingThisMonth ? 0 : (lastOfHalf - input.month + 12) % 12;
      const income = (input.halfYearGrossBefore ?? 0) + input.monthGross + rate * monthsToCome;
      const owed = slabFor(rule.slabs, income)?.amount ?? 0;
      amount = Math.max(0, owed - (input.paidThisHalf ?? 0));
      const span = half === "FIRST" ? "April to September" : "October to March";
      const early = monthsToCome > 0 ? `, the rest of the half at this month's rate` : "";
      const leaving = input.leavingThisMonth && input.month !== firstDue && input.month !== secondDue ? ", charged now as this is their last month" : "";
      notes.push(`${state.label}'s professional tax is half-yearly: ${rupees(amount)} on ${rupees(Math.round(income))} for ${span}${early}${leaving}.${rule.note ? ` ${rule.note}` : ""}`);
    }
  } else if (rule.kind === "ANNUAL_ONCE") {
    if (input.month === rule.dueMonth || input.month === rule.catchUpMonth) {
      const owed = slabFor(rule.slabs, rate * 12)?.amount ?? 0;
      amount = Math.max(0, owed - (input.month === rule.catchUpMonth ? (input.paidThisYear ?? 0) : 0));
      if (amount > 0) notes.push(`${state.label}'s professional tax is a year's, taken once: ${rupees(amount)} on a year's salary of ${rupees(Math.round(rate * 12))}.`);
    }
  } else if (rule.kind === "INCOME_TAX_PAYERS") {
    if (input.deductsIncomeTax && rule.seniorCitizensExempt && input.seniorCitizen) {
      notes.push(`No ${state.label} development tax: they're a senior citizen this financial year.`);
    } else {
      amount = input.deductsIncomeTax ? rule.amount : 0;
    }
  }
  // "NONE": the state's tax has been repealed — nothing, and nothing to say.

  // The cap is a hard stop on what this financial year's earlier payslips have taken.
  const room = Math.max(0, PT_ANNUAL_CAP - (input.paidThisYear ?? 0));
  if (amount > room) {
    notes.push(`Professional tax capped at ${rupees(room)}: ${rupees(input.paidThisYear ?? 0)} already deducted this financial year, and the year's limit is ${rupees(PT_ANNUAL_CAP)}.`);
    amount = room;
  }
  return { amount, known: true, stateLabel: state.label, notes };
}

/**
 * Whether somebody counts as a senior citizen for a financial year starting in April of `fyStart`: 60
 * or over at some point in it. In law a birthday's age is reached the day before it, so somebody born
 * on 1 April turns 60 on 31 March — inside the year.
 */
export function seniorCitizenIn(dateOfBirth: Date | null | undefined, fyStart: number): boolean {
  if (!dateOfBirth) return false;
  return dateOfBirth.getTime() <= Date.UTC(fyStart - 59, 3, 1);
}
