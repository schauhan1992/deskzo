import {
  annualCtcOf,
  computeEsi,
  ESI_EMPLOYER_RATE,
  monthlyGross,
  monthlyStatutory,
  round2,
  STATUTORY_FIXED_KEYS,
  type SalaryComponents,
  type SalaryCustomLine,
  type StatutoryFixed,
  type StatutoryFlags,
} from "@/lib/hr/payroll";

/**
 * A CTC split into a salary structure, and a revision given as a percentage or an amount (owner, 21 Oct
 * 2026: "Auto CTC split, HR can edit it, and more custom fields in the salary breakup").
 *
 * The CTC is what the person costs the company in a year: twelve months of gross plus the employer's PF
 * and ESI (`annualCtcOf`). A split puts basic at the company's percentage of it, HRA at its percentage of
 * basic, the fixed allowances and the company's own components at what they're set to, and lets the
 * special allowance take up what's left — so the structure costs exactly the CTC typed. The old split
 * left the employer's ESI out, and a CTC of ₹2,40,000 came out as ₹2,47,428.
 *
 * PF and ESI typed over Deskzo's figures at the split (owner, 23 Oct 2026; StatutoryFixed) are what the CTC
 * counts: an employer's PF fixed at ₹1,800 costs ₹1,800, whatever basic is.
 *
 * Pure, so the salary dialog splits as HR types and check:salary-split can hold every figure to it.
 */

export type SplitRules = {
  /** Of the monthly CTC. */
  basicPercent: number;
  /** Of basic. */
  hraPercent: number;
  /** Fixed monthly amounts. */
  conveyance: number;
  medical: number;
};

/** No rules set: basic at 40% of the CTC and HRA at half of basic, as the split always was. */
export const DEFAULT_SPLIT_RULES: SplitRules = { basicPercent: 40, hraPercent: 50, conveyance: 0, medical: 0 };

/** One of the company's own components, with what a split starts it at. */
export type ComponentDefault = { name: string; mode: "FIXED" | "PERCENT_OF_BASIC"; value: number };

export type RevisionBasis = "PERCENT" | "AMOUNT" | "CTC";

/** The `omit` that reads a structure's columns from 21 Oct 2026 by name (src/lib/tenancy/clients.ts). */
export const STRUCTURE_EXTRAS_READ = { customComponents: false, annualCtc: false, revisionBasis: false, revisionValue: false, statutoryFixed: false } as const;

/** A structure's custom components as stored — anything that isn't a named, non-negative amount dropped. */
export function customLinesOf(json: unknown): SalaryCustomLine[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((l): l is { name: string; amount: number } => !!l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string" && Number.isFinite(Number((l as { amount?: unknown }).amount)))
    .map((l) => ({ name: l.name.trim(), amount: round2(Math.max(0, Number(l.amount))) }))
    .filter((l) => l.name !== "");
}

/** A structure's PF, ESI and TDS fixed at the split, as stored — whole, non-negative rupees; anything else left out. */
export function statutoryFixedOf(json: unknown): StatutoryFixed {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const fixed: StatutoryFixed = {};
  for (const key of STATUTORY_FIXED_KEYS) {
    const value = (json as Record<string, unknown>)[key];
    if (value === null || value === undefined || value === "") continue;
    const amount = Number(value);
    if (Number.isFinite(amount) && amount >= 0) fixed[key] = Math.round(amount);
  }
  return fixed;
}

type Money = number | string | { toString(): string } | null | undefined;
type StructureRow = {
  basic: Money;
  hra: Money;
  conveyance: Money;
  medical: Money;
  specialAllowance: Money;
  otherAllowance: Money;
  customComponents?: unknown;
  statutoryFixed?: unknown;
  pfApplicable?: boolean;
  esiApplicable?: boolean;
};
const n = (v: Money) => Number(v ?? 0);

/** A stored structure as the payroll engine takes it, its own components included. */
export function componentsOfStructure(row: StructureRow): SalaryComponents {
  const custom = customLinesOf(row.customComponents);
  return {
    basic: n(row.basic),
    hra: n(row.hra),
    conveyance: n(row.conveyance),
    medical: n(row.medical),
    specialAllowance: n(row.specialAllowance),
    otherAllowance: n(row.otherAllowance),
    ...(custom.length ? { custom } : {}),
  };
}

/** A stored structure's annual CTC, worked out from it as the salary card shows it — PF and ESI fixed on it in. */
export function ctcOfStructure(row: StructureRow): number {
  return annualCtcOf(componentsOfStructure(row), { pfApplicable: row.pfApplicable ?? true, esiApplicable: row.esiApplicable ?? true }, statutoryFixedOf(row.statutoryFixed));
}

type Flags = Pick<StatutoryFlags, "pfApplicable" | "esiApplicable">;

/**
 * Everything but the special allowance, and the CTC it should come to: the special allowance that makes it
 * so. `short` is how much a year the other parts already go over the CTC by — then there's no special
 * allowance, and the structure costs more than the CTC typed.
 */
export function balanceToCtc(
  parts: Omit<SalaryComponents, "specialAllowance">,
  annualCtc: number,
  flags: Flags,
  fixed: StatutoryFixed = {},
): { components: SalaryComponents; short: number } {
  const monthlyCtc = annualCtc / 12;
  const employerPf = monthlyStatutory({ ...parts, specialAllowance: 0 }, flags, fixed).pfEmployer;
  const fixedGross = monthlyGross({ ...parts, specialAllowance: 0 });
  // Gross plus the employer's PF and ESI is the monthly CTC. ESI is a share of gross, and only up to its
  // wage limit — so the gross is solved for with it first, and without it if that gross is over the limit.
  // Fixed, the employer's ESI is a sum like PF, and nothing to solve for.
  const esiFixed = flags.esiApplicable && fixed.esiEmployer !== undefined;
  const withEsi = (monthlyCtc - employerPf) / (1 + ESI_EMPLOYER_RATE);
  let gross = esiFixed
    ? monthlyCtc - employerPf - fixed.esiEmployer!
    : flags.esiApplicable && computeEsi(withEsi, { applicable: true }).applied
      ? withEsi
      : monthlyCtc - employerPf;
  let special = round2(gross - fixedGross);
  if (special < 0) {
    const components = { ...parts, specialAllowance: 0 };
    return { components, short: round2(annualCtcOf(components, flags, fixed) - annualCtc) };
  }
  // ESI is rounded up to the rupee, so the solved gross can be a rupee or two off: settled on the special
  // allowance, which absorbs it, rather than shown as a CTC that isn't the one typed.
  for (let i = 0; i < 3; i += 1) {
    const off = annualCtcOf({ ...parts, specialAllowance: special }, flags, fixed) - annualCtc;
    if (Math.abs(off) < 0.5) break;
    const esiOn = !esiFixed && flags.esiApplicable && computeEsi(gross, { applicable: true }).applied;
    special = round2(Math.max(0, special - off / 12 / (esiOn ? 1 + ESI_EMPLOYER_RATE : 1)));
    gross = fixedGross + special;
  }
  return { components: { ...parts, specialAllowance: special }, short: 0 };
}

/** The company's own components at what a split starts them at, for a basic. */
export function customDefaultsFor(basic: number, defaults: readonly ComponentDefault[]): SalaryCustomLine[] {
  return defaults
    .map((d) => ({ name: d.name, amount: round2(d.mode === "PERCENT_OF_BASIC" ? (basic * d.value) / 100 : d.value) }))
    .filter((l) => l.amount > 0);
}

/** A CTC split by the company's rules, its own components in, the special allowance taking up the rest. */
export function splitCtc(annualCtc: number, rules: SplitRules, defaults: readonly ComponentDefault[], flags: Flags, fixed: StatutoryFixed = {}) {
  const monthlyCtc = Math.max(0, annualCtc) / 12;
  const basic = round2((monthlyCtc * rules.basicPercent) / 100);
  const hra = round2((basic * rules.hraPercent) / 100);
  const custom = customDefaultsFor(basic, defaults);
  return balanceToCtc(
    { basic, hra, conveyance: round2(rules.conveyance), medical: round2(rules.medical), otherAllowance: 0, ...(custom.length ? { custom } : {}) },
    annualCtc,
    flags,
    fixed,
  );
}

/** The new CTC a revision comes to: up by a percentage, up by an amount a year, or a new CTC. Whole rupees. */
export function revisedCtc(currentCtc: number, basis: RevisionBasis, value: number): number {
  if (basis === "PERCENT") return Math.round(currentCtc * (1 + value / 100));
  if (basis === "AMOUNT") return Math.round(currentCtc + value);
  return Math.round(value);
}

/** How a revision reads: "+10%", "+₹60,000 a year", or the new CTC. */
export function revisionWords(basis: RevisionBasis, value: number, fromCtc?: number | null): string {
  const rupees = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
  if (basis === "PERCENT") return `+${value}%`;
  if (basis === "AMOUNT") return `+${rupees(value)} a year`;
  return fromCtc ? `${rupees(fromCtc)} → ${rupees(value)}` : `${rupees(value)} CTC`;
}

/**
 * The current structure grown to a new CTC, its shape kept: every part but the special allowance scaled by
 * the same factor, the special allowance balancing to the CTC exactly. What a revision does by default —
 * the person's breakup stays theirs, only bigger. PF, ESI and TDS fixed on it stay as they are: a sum, not a share.
 */
export function scaleToCtc(current: SalaryComponents, currentCtc: number, newCtc: number, flags: Flags, fixed: StatutoryFixed = {}) {
  const factor = currentCtc > 0 ? newCtc / currentCtc : 1;
  const scale = (v: number) => round2(v * factor);
  const custom = (current.custom ?? []).map((l) => ({ name: l.name, amount: scale(l.amount) }));
  return balanceToCtc(
    {
      basic: scale(current.basic),
      hra: scale(current.hra),
      conveyance: scale(current.conveyance),
      medical: scale(current.medical),
      otherAllowance: scale(current.otherAllowance),
      ...(custom.length ? { custom } : {}),
    },
    newCtc,
    flags,
    fixed,
  );
}
