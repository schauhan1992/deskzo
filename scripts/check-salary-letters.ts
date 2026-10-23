/**
 * check:salary-letters — the HR batch of 21 Oct 2026, held to its figures and its wiring.
 *
 *   · A CTC splits into a structure that costs exactly that CTC — employer PF and ESI in — by the company's
 *     rules, its own components in, the special allowance taking up the rest. The old split left ESI out.
 *   · A revision is given as a percentage, an amount a year, or a new CTC; "keep their breakup" scales it.
 *   · The company's own components count towards gross, are pro-rated by name for loss of pay and a
 *     mid-month revision, and print on the payslip.
 *   · PF, ESI and TDS typed over Deskzo's figures at the split (owner, 23 Oct 2026): the employer's shares are
 *     what the CTC counts, a split still costs exactly the CTC, a payslip takes them pro-rated by the days it
 *     pays, a scheme switched off takes none; the dialog offers them, and a custom field, plainly.
 *   · An IFSC pasted with spaces, dashes, a letter O for the zero or an invisible character is cleaned
 *     before it is checked — everywhere one is typed, Accounting › Banking too.
 *   · HR's own letter templates fill {{fields}} from the person's record; a field that isn't one is refused
 *     on save; a template's code can't be a built-in letter's. A letter carries the signature only when
 *     marked signed, the copy it was issued with, and is dated the day it is issued.
 *
 * Pure — no database.
 *
 *   npm run check:salary-letters
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { annualCtcOf, computePayslip, monthlyGross, monthlyStatutory, type SalaryComponents } from "../src/lib/hr/payroll";
import {
  DEFAULT_SPLIT_RULES,
  balanceToCtc,
  componentsOfStructure,
  ctcOfStructure,
  customLinesOf,
  revisedCtc,
  revisionWords,
  scaleToCtc,
  splitCtc,
  statutoryFixedOf,
} from "../src/lib/hr/salary-split";
import { isIfsc, normaliseIfsc, ifscSchema } from "../src/lib/ifsc";
import { salaryStructureSchema } from "../src/lib/validation/hr";
import { LETTER_FIELDS, mergeLetterTemplate, unknownLetterFields } from "../src/lib/hr/letter-templates";
import { BUILT_IN_LETTER_CODES, letterNumberFor, type LetterPayload } from "../src/lib/hr/letters";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const both = { pfApplicable: true, esiApplicable: true };

section("A CTC splits into a structure that costs exactly the CTC");
for (const ctc of [180000, 240000, 300000, 360000, 600000, 960000, 2400000]) {
  for (const flags of [both, { pfApplicable: false, esiApplicable: true }, { pfApplicable: true, esiApplicable: false }, { pfApplicable: false, esiApplicable: false }]) {
    const { components, short } = splitCtc(ctc, DEFAULT_SPLIT_RULES, [], flags);
    const cost = annualCtcOf(components, flags);
    ok(`₹${ctc} (PF ${flags.pfApplicable ? "on" : "off"}, ESI ${flags.esiApplicable ? "on" : "off"}) costs ₹${Math.round(cost)}`, short === 0 && Math.abs(cost - ctc) < 1, { cost, short });
  }
}
{
  const { components } = splitCtc(600000, DEFAULT_SPLIT_RULES, [], both);
  ok("basic is 40% of the monthly CTC", components.basic === 20000, components.basic);
  ok("HRA is half of basic", components.hra === 10000, components.hra);
  ok("the special allowance takes up the rest", components.specialAllowance > 0, components.specialAllowance);
}
{
  // ₹2,40,000 is where the old split went wrong: its gross is under the ESI limit, and ESI was left out.
  const { components } = splitCtc(240000, DEFAULT_SPLIT_RULES, [], both);
  ok("₹2,40,000 with ESI comes out at ₹2,40,000, not ₹2,47,428", Math.abs(annualCtcOf(components, both) - 240000) < 1, annualCtcOf(components, both));
}
{
  const rules = { basicPercent: 50, hraPercent: 40, conveyance: 1600, medical: 1250 };
  const defaults = [
    { name: "Food allowance", mode: "FIXED" as const, value: 2200 },
    { name: "Shift allowance", mode: "PERCENT_OF_BASIC" as const, value: 10 },
    { name: "Nothing yet", mode: "FIXED" as const, value: 0 },
  ];
  const { components, short } = splitCtc(900000, rules, defaults, both);
  ok("the company's rules: basic 50%", components.basic === 37500, components.basic);
  ok("HRA 40% of basic", components.hra === 15000, components.hra);
  ok("conveyance and medical at their fixed amounts", components.conveyance === 1600 && components.medical === 1250);
  ok("a fixed component at its amount", components.custom?.find((l) => l.name === "Food allowance")?.amount === 2200, components.custom);
  ok("a percentage-of-basic component on basic", components.custom?.find((l) => l.name === "Shift allowance")?.amount === 3750, components.custom);
  ok("a component at nothing is left off", !components.custom?.some((l) => l.name === "Nothing yet"));
  ok("…and the whole still costs the CTC", short === 0 && Math.abs(annualCtcOf(components, both) - 900000) < 1, annualCtcOf(components, both));
  ok("custom components count towards gross", monthlyGross(components) === components.basic + components.hra + 1600 + 1250 + 2200 + 3750 + components.specialAllowance);
}
{
  const { components, short } = balanceToCtc({ basic: 30000, hra: 15000, conveyance: 0, medical: 0, otherAllowance: 0 }, 300000, both);
  ok("parts that already cost more than the CTC: no special allowance, and how much over", components.specialAllowance === 0 && short > 0, { short });
}

section("A revision: a percentage, an amount a year, or a new CTC");
ok("+10% of ₹6,00,000 is ₹6,60,000", revisedCtc(600000, "PERCENT", 10) === 660000);
ok("+₹75,000 a year on ₹6,00,000 is ₹6,75,000", revisedCtc(600000, "AMOUNT", 75000) === 675000);
ok("a new CTC is that CTC", revisedCtc(600000, "CTC", 720000) === 720000);
ok("a decimal percentage rounds to the rupee", revisedCtc(612345, "PERCENT", 7.5) === Math.round(612345 * 1.075));
ok("reads +10%", revisionWords("PERCENT", 10) === "+10%");
ok("reads +₹75,000 a year", revisionWords("AMOUNT", 75000) === "+₹75,000 a year");
ok("reads old → new for a new CTC", revisionWords("CTC", 720000, 600000) === "₹6,00,000 → ₹7,20,000");
{
  const current: SalaryComponents = { basic: 24000, hra: 9600, conveyance: 1600, medical: 1250, specialAllowance: 8000, otherAllowance: 0, custom: [{ name: "Food allowance", amount: 2200 }] };
  const currentCtc = annualCtcOf(current, both);
  const next = revisedCtc(currentCtc, "PERCENT", 10);
  const { components, short } = scaleToCtc(current, currentCtc, next, both);
  ok("keeping their breakup scales every part by the same factor", Math.abs(components.basic / current.basic - next / currentCtc) < 0.001, { basic: components.basic });
  ok("their own components scale with it", components.custom?.[0]?.name === "Food allowance" && Math.abs(components.custom[0].amount - 2200 * (next / currentCtc)) < 0.02, components.custom);
  ok("and it costs the new CTC exactly", short === 0 && Math.abs(annualCtcOf(components, both) - next) < 1, annualCtcOf(components, both));
}

section("A stored structure, its own components included");
{
  const row = { basic: "20000", hra: "10000", conveyance: 0, medical: null, specialAllowance: "5000.50", otherAllowance: 0, customComponents: [{ name: " Food allowance ", amount: "2200" }, { name: "", amount: 5 }, { amount: 9 }, "nonsense", { name: "Negative", amount: -40 }], pfApplicable: true, esiApplicable: false };
  const c = componentsOfStructure(row);
  ok("reads the six from strings and decimals", c.basic === 20000 && c.medical === 0 && c.specialAllowance === 5000.5);
  ok("keeps a named component, trimmed", c.custom?.[0]?.name === "Food allowance" && c.custom[0].amount === 2200, c.custom);
  ok("drops an unnamed one and junk; a negative amount is nothing", customLinesOf(row.customComponents).length === 2 && customLinesOf(row.customComponents)[1]!.amount === 0, customLinesOf(row.customComponents));
  ok("no custom key on a structure without any", !("custom" in componentsOfStructure({ ...row, customComponents: null })));
  ok("its CTC is gross and the employer's PF, a year of it", Math.abs(ctcOfStructure(row) - annualCtcOf(c, { pfApplicable: true, esiApplicable: false })) < 0.01);
}

section("The company's own components on a payslip");
{
  const components: SalaryComponents = { basic: 15000, hra: 6000, conveyance: 0, medical: 0, specialAllowance: 3000, otherAllowance: 0, custom: [{ name: "Food allowance", amount: 3000 }] };
  const full = computePayslip({ components, flags: { ...both, ptApplicable: false }, monthDays: 30, lopDays: 0, month: 10, year: 2026 });
  ok("a full month pays the component in full", full.components.custom?.[0]?.amount === 3000, full.components.custom);
  ok("…and it's in gross", full.grossEarnings === 27000, full.grossEarnings);
  const lop = computePayslip({ components, flags: { ...both, ptApplicable: false }, monthDays: 30, lopDays: 3, month: 10, year: 2026 });
  ok("three days' loss of pay pro-rates it like basic", lop.components.custom?.[0]?.amount === 2700, lop.components.custom);
  const revised = computePayslip({
    components: { ...components, custom: [{ name: "Food allowance", amount: 6000 }] },
    parts: [
      { components, firstDay: 1, lastDay: 15, lopDays: 0 },
      { components: { ...components, custom: [{ name: "Food allowance", amount: 6000 }, { name: "Shift allowance", amount: 3000 }] }, firstDay: 16, lastDay: 30, lopDays: 0 },
    ],
    flags: { ...both, ptApplicable: false },
    monthDays: 30,
    lopDays: 0,
    month: 10,
    year: 2026,
  });
  const food = revised.components.custom?.find((l) => l.name === "Food allowance")?.amount;
  const shift = revised.components.custom?.find((l) => l.name === "Shift allowance")?.amount;
  ok("revised mid-month, each half at its own rate, by name", food === 4500 && shift === 1500, revised.components.custom);
  const plain = computePayslip({ components: { ...components, custom: undefined }, flags: { ...both, ptApplicable: false }, monthDays: 30, lopDays: 0, month: 10, year: 2026 });
  ok("a structure without any has no custom lines on its payslip", !plain.components.custom);
}

section("PF, ESI and TDS fixed at the split");
{
  const read = statutoryFixedOf({ pfEmployee: "1800", pfEmployer: 1800.4, esiEmployee: -5, esiEmployer: "", tds: null, junk: 9 });
  ok("read from a structure: whole rupees, a negative or empty one left out", JSON.stringify(read) === JSON.stringify({ pfEmployee: 1800, pfEmployer: 1800 }), read);
  ok("nothing stored is nothing fixed", JSON.stringify(statutoryFixedOf(null)) === "{}" && JSON.stringify(statutoryFixedOf([1, 2])) === "{}");

  const c: SalaryComponents = { basic: 30000, hra: 15000, conveyance: 0, medical: 0, specialAllowance: 5000, otherAllowance: 0 };
  const worked = monthlyStatutory(c, both);
  ok("Deskzo's own: PF 12% of the ₹25,000 ceiling, no ESI above its limit", worked.pfEmployee === 3000 && worked.pfEmployer === 3000 && worked.esiEmployee === 0, worked);
  const pf1800 = { pfEmployee: 1800, pfEmployer: 1800 };
  ok("fixed, PF is ₹1,800 a side", JSON.stringify(monthlyStatutory(c, both, pf1800)) === JSON.stringify({ pfEmployee: 1800, pfEmployer: 1800, esiEmployee: 0, esiEmployer: 0 }));
  ok("…and the CTC counts the employer's ₹1,800, not ₹3,000", annualCtcOf(c, both, pf1800) === (50000 + 1800) * 12, annualCtcOf(c, both, pf1800));
  ok("PF switched off: a fixed PF counts for nothing", annualCtcOf(c, { pfApplicable: false, esiApplicable: true }, pf1800) === 50000 * 12);
  ok("a stored structure's CTC has its fixed PF in", ctcOfStructure({ ...c, statutoryFixed: pf1800, pfApplicable: true, esiApplicable: true }) === (50000 + 1800) * 12);

  for (const ctc of [240000, 300000, 600000, 960000]) {
    for (const fixed of [pf1800, { esiEmployer: 650 }, { pfEmployer: 2000, esiEmployer: 0 }]) {
      const { components, short } = splitCtc(ctc, DEFAULT_SPLIT_RULES, [], both, fixed);
      const cost = annualCtcOf(components, both, fixed);
      ok(`₹${ctc} split with ${JSON.stringify(fixed)} costs ₹${Math.round(cost)}`, short === 0 && Math.abs(cost - ctc) < 1, { cost, short });
    }
  }
  const revised = scaleToCtc(c, annualCtcOf(c, both, pf1800), 720000, both, pf1800);
  ok("a revision keeps to the new CTC with PF still ₹1,800", revised.short === 0 && Math.abs(annualCtcOf(revised.components, both, pf1800) - 720000) < 1);

  const slipOf = (fixed: object, more: object = {}) => computePayslip({ components: c, flags: { ...both, ptApplicable: false }, fixed, monthDays: 30, lopDays: 0, month: 10, year: 2026, incomeTax: 1, ...more });
  const full = slipOf({ ...pf1800, esiEmployee: 375, esiEmployer: 1625 });
  ok("a full month takes them as fixed", full.pfEmployee === 1800 && full.pfEmployer === 1800 && full.esiEmployee === 375 && full.esiEmployer === 1625, full);
  ok("…in deductions, net and cost", full.totalDeductions === 1800 + 375 + 1 && full.netPay === 50000 - 2176 && full.employerCost === 50000 + 1800 + 1625);
  ok("…and ESI fixed above its limit says nothing about the limit", !full.warnings.some((w) => w.includes("ESI limit")), full.warnings);
  const lop = slipOf(pf1800, { lopDays: 3 });
  ok("three days' loss of pay: 27/30 of it, ₹1,620", lop.pfEmployee === 1620 && lop.pfEmployer === 1620, lop.pfEmployee);
  const joiner = slipOf(pf1800, { employment: { firstDay: 21, lastDay: 30 } });
  ok("joining on the 21st: 10/30 of it, ₹600", joiner.pfEmployee === 600, joiner.pfEmployee);
  const off = computePayslip({ components: c, flags: { pfApplicable: false, esiApplicable: false, ptApplicable: false }, fixed: { ...pf1800, esiEmployee: 375 }, monthDays: 30, lopDays: 0, month: 10, year: 2026, incomeTax: 1 });
  ok("PF and ESI off: nothing taken, fixed or not", off.pfEmployee === 0 && off.esiEmployee === 0);
  ok("nothing fixed: Deskzo's own figures, as before", slipOf({}).pfEmployee === 3000);
}

section("An IFSC, cleaned of what a paste carries");
const ifscCases: [string, string, boolean][] = [
  ["HDFC0001234", "HDFC0001234", true],
  ["hdfc0001234", "HDFC0001234", true],
  [" HDFC 0001 234 ", "HDFC0001234", true],
  ["HDFC-0001234", "HDFC0001234", true],
  ["HDFC​0001234", "HDFC0001234", true],
  ["﻿SBIN0005943 ", "SBIN0005943", true],
  ["HDFCO001234", "HDFC0001234", true],
  ["SBIN0ABC123", "SBIN0ABC123", true],
  ["HDFC1001234", "HDFC1001234", false],
  ["HDF0001234", "HDF0001234", false],
  ["1234", "1234", false],
];
for (const [raw, cleaned, valid] of ifscCases) {
  const code = normaliseIfsc(raw);
  ok(`${JSON.stringify(raw)} → ${code} (${valid ? "valid" : "refused"})`, code === cleaned && isIfsc(code) === valid);
}
{
  const schema = ifscSchema("bad");
  ok("the schema stores the cleaned code", schema.safeParse(" icic 0000 123 ").data === "ICIC0000123");
  ok("the schema lets an empty one through", schema.safeParse("").success && schema.safeParse(undefined).success);
  ok("the schema refuses a wrong one", !schema.safeParse("ICIC1000123").success);
}
for (const file of ["src/lib/validation/hr.ts", "src/lib/validation/intake.ts", "src/lib/validation/company.ts"]) {
  ok(`${file} checks an IFSC with ifscSchema`, read(file).includes("ifscSchema("));
}
ok("Accounting › Banking cleans and checks an IFSC too", /normaliseIfsc|isIfsc/.test(read("src/actions/bank.ts")));
ok("the payroll importer cleans an IFSC", read("src/lib/portability/importers/payroll.ts").includes("normaliseIfsc"));

section("HR's own letter templates");
const payload = {
  employeeName: "Priya Sharma",
  employeeCode: "EMP-0042",
  designation: "Sales Manager",
  department: null,
  companyName: "Acme Industries Pvt Ltd",
  companyAddress: "12 MG Road\nPune",
  annualCtc: 960000,
  monthlyGross: 75000,
  joinedOn: "2024-04-01",
  signatoryName: "Anita Rao",
  signatoryTitle: "Head of HR",
} as unknown as LetterPayload;
{
  const text = "Dear {{employee.name}} ({{ employee.code }}), you joined on {{employee.joinedOn}} at {{salary.annualCtc}} a year, in {{employee.department|our team}}. Notice: {{employee.noticePeriodDays}}. Dated {{today}}. {{not.afield}}";
  const merged = mergeLetterTemplate(text, payload, "2026-10-21");
  ok("fills a field", merged.includes("Dear Priya Sharma (EMP-0042)"), merged);
  ok("spells a date out", merged.includes("joined on 1 April 2024"), merged);
  ok("puts rupees the Indian way", merged.includes("₹9,60,000 a year"), merged);
  ok("says the 'instead' for a field with nothing", merged.includes("in our team."), merged);
  ok("leaves a blank line for a field with nothing and no 'instead'", merged.includes("Notice: __________."), merged);
  ok("today is the day given", merged.includes("Dated 21 October 2026"), merged);
  ok("leaves a non-field as it was", merged.includes("{{not.afield}}"), merged);
  ok("names the fields that aren't fields", JSON.stringify(unknownLetterFields(text)) === JSON.stringify(["not.afield"]), unknownLetterFields(text));
  ok("every field has an example and a label", LETTER_FIELDS.every((f) => f.label && f.example));
}
ok("a template's code goes in the number", letterNumberFor("CUSTOM", 2026, 7, "WRF", "BON") === "WRF/BON/2026/007");
ok("the built-in codes are known, so a template can't take one — DOC, the generic one, included", BUILT_IN_LETTER_CODES.includes("OFR") && BUILT_IN_LETTER_CODES.includes("DOC"));
{
  const actions = read("src/actions/letter-templates.ts");
  ok("saving refuses a field that isn't one", actions.includes("unknownLetterFields("));
  ok("saving refuses a built-in letter's code", actions.includes("BUILT_IN_LETTER_CODES.includes(code)"));
  ok("templates are HR's — hr.manage", actions.includes('hasEffectivePermission(user.id, "hr.manage")'));
  ok("the signature image never goes in the audit log", !/entityLabel:[^\n]*dataUrl/.test(actions));
  ok("a template with letters is switched off, not deleted", actions.includes("_count.letters > 0") && actions.includes("active: false"));
}

section("The signature on a letter");
{
  const docs = read("src/actions/employee-docs.ts");
  ok("a new letter starts signed or not as the company says", (docs.match(/\.\.\.\(await signedByDefault\(\)\)/g) ?? []).length === 2);
  ok("only a draft's signature can be switched", /setLetterSigned[\s\S]*?status !== "DRAFT"/.test(docs));
  ok("issuing freezes the signature as it is now", /issueLetter[\s\S]*?signatureDataUrl: signature/.test(docs));
  ok("signed with nothing to sign with is issued unsigned", docs.includes("signed: !!signature"));
  ok("a letter is dated the day it's issued", /issueLetter[\s\S]*?issuedOn,/.test(docs));
  ok("a template's letters are numbered by the number, so a re-made template carries on", docs.includes("letterNumber: { startsWith: stem }"));
  const print = read("src/app/(print)/letters/[id]/print/page.tsx");
  ok("the print page signs only a signed letter", print.includes("!letter.signed") && print.includes("letter.signatureDataUrl ??"));
  ok("an issued letter prints the copy it was issued with", /letter\.signatureDataUrl \?\? \(letter\.status === "DRAFT"/.test(print));
  const editor = read("src/components/hr/letter-editor.tsx");
  ok("the draft has an Add digital signature switch", editor.includes("Add digital signature") && editor.includes("setLetterSigned("));
}

section("Wiring");
{
  const card = read("src/components/hr/salary-card.tsx");
  ok("the salary dialog splits as a CTC is typed", card.includes("splitCtc(amount, rules, defaults, flags, fixed)"));
  ok("…revises by %, ₹ a year or a new CTC", card.includes('value="PERCENT"') && card.includes('value="AMOUNT"') && card.includes('value="CTC"'));
  ok("…keeps the CTC as a part changes", card.includes("balanceToCtc(rest, target, f, fx)"));
  ok("…offers PF, ESI and TDS to be typed over, and back to Deskzo's figure", card.includes("STATUTORY_ROWS.map") && card.includes("statutoryFixed: fixed") && card.includes("back to Deskzo's figure"));
  ok("…an employer's share typed keeps to the CTC", card.includes('if (key === "pfEmployer" || key === "esiEmployer") rebalance('));
  ok("…and a custom field is one button away", card.includes("Add custom field") && card.includes('addCustom("other")'));
  ok("…a correction keeps its own day, not String() of the date", card.includes("toKey(current.effectiveFrom)") && !card.includes("String(current.effectiveFrom)"));
  const structure = { userId: "u", basic: 1 };
  ok("a structure's day is a calendar day: “Fri Oct 23” is refused, not read as 2001", !salaryStructureSchema.safeParse({ ...structure, effectiveFrom: "Fri Oct 23" }).success && salaryStructureSchema.safeParse({ ...structure, effectiveFrom: "2026-10-23" }).success);
  ok("…saves the components, the CTC and how it was revised", ["customComponents:", "annualCtc:", "revisionBasis:", "revisionValue:"].every((k) => card.includes(k)));
  ok("…corrects the current structure in place while it may", card.includes("updateSalaryStructure(") && card.includes("current?.editable"));
  const payroll = read("src/actions/payroll.ts");
  ok("a correction is refused once a locked month paid from it", /export async function updateSalaryStructure[\s\S]*?lockedRunFrom/.test(payroll));
  ok("the run stores the components it paid", payroll.includes("customEarnings"));
  ok("the run pays PF and ESI fixed on the structure, and its TDS as FIXED", payroll.includes("statutoryFixedOf(structure.statutoryFixed)") && payroll.includes('fixedTds ? ("FIXED" as const)'));
  ok("PF and ESI fixed are kept only for a scheme that's on", /function statutoryFixedOrRefusal[\s\S]*?if \(data\.pfApplicable\)[\s\S]*?if \(data\.esiApplicable\)/.test(payroll));
  ok("the register says a TDS was fixed", read("src/components/hr/payroll-register.tsx").includes('s.incomeTaxBasis === "FIXED"'));
  ok("the payslip prints them", read("src/app/(print)/payslips/[id]/print/page.tsx").includes("customLinesOf(slip.customEarnings)"));
  ok("Settings › Salary structure is in the catalogue, payroll's", /key: "salary-structure"[\s\S]*?permission: "payroll\.manage"[\s\S]*?module: "payroll"/.test(read("src/lib/settings/catalogue.ts")));
  ok("People › Letters is in the menu, HR's", read("src/lib/modules.ts").includes('{ href: "/people/letters", label: "Letters", icon: FileText, permission: "hr.manage" }'));
  ok("the letter-templates actions are the HR module's", read("src/lib/module-actions.ts").includes('"letter-templates.ts": ["hr"]'));
  const clients = read("src/lib/tenancy/clients.ts");
  ok("the new columns are read by name until every workspace has them", ["customEarnings", "revisionBasis", "signatureDataUrl", "letterSignByDefault", "statutoryFixed"].every((c) => clients.includes(c)));
  ok("the migration adds the column and FIXED", /ADD COLUMN "statutoryFixed" JSONB[\s\S]*ADD VALUE 'FIXED'/.test(read("prisma/migrations/20261123100000_salary_statutory_fixed/migration.sql")));
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
