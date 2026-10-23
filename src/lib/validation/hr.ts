import { z } from "zod";
import { ifscSchema } from "@/lib/ifsc";

export const employmentTypeValues = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN", "CONSULTANT"] as const;
export const exitTypeValues = ["RESIGNED", "TERMINATED", "RETIRED", "CONTRACT_ENDED", "ABSCONDED"] as const;
export const genderValues = ["FEMALE", "MALE", "OTHER", "UNDISCLOSED"] as const;
export const leaveAccrualValues = ["ANNUAL", "MONTHLY"] as const;
export const attendanceStatusValues = [
  "PRESENT", "WORK_FROM_HOME", "HALF_DAY", "ON_LEAVE", "ABSENT", "WEEK_OFF", "HOLIDAY",
] as const;

export const employmentTypeLabels: Record<(typeof employmentTypeValues)[number], string> = {
  FULL_TIME: "Full time",
  PART_TIME: "Part time",
  CONTRACT: "Contract",
  INTERN: "Intern",
  CONSULTANT: "Consultant",
};

export const exitTypeLabels: Record<(typeof exitTypeValues)[number], string> = {
  RESIGNED: "Resigned",
  TERMINATED: "Terminated",
  RETIRED: "Retired",
  CONTRACT_ENDED: "Contract ended",
  ABSCONDED: "Absconded",
};

export const attendanceStatusLabels: Record<(typeof attendanceStatusValues)[number], string> = {
  PRESENT: "Present",
  WORK_FROM_HOME: "Work from home",
  HALF_DAY: "Half day",
  ON_LEAVE: "On leave",
  ABSENT: "Absent",
  WEEK_OFF: "Week off",
  HOLIDAY: "Holiday",
};

export const attendanceStatusTone: Record<
  (typeof attendanceStatusValues)[number],
  "default" | "green" | "blue" | "red" | "amber" | "brand"
> = {
  PRESENT: "green",
  WORK_FROM_HOME: "blue",
  HALF_DAY: "amber",
  ON_LEAVE: "brand",
  ABSENT: "red",
  WEEK_OFF: "default",
  HOLIDAY: "default",
};

export const leaveStatusTone: Record<string, "default" | "green" | "blue" | "red" | "amber"> = {
  PENDING: "amber",
  APPROVED: "green",
  REJECTED: "red",
  CANCELLED: "default",
};

const optionalText = (max = 200) => z.string().trim().max(max).optional().or(z.literal(""));
const optionalDate = z.string().trim().optional().or(z.literal(""));

/** PAN is a fixed, checkable shape — worth validating, because a wrong one fails silently at filing time. */
const pan = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "A PAN is five letters, four digits, then a letter.")
  .optional()
  .or(z.literal(""));

// Cleaned of what a paste carries before it's checked (src/lib/ifsc.ts).
const ifsc = ifscSchema("An IFSC is four letters, a zero, then six characters — like HDFC0001234.");

export const employeeProfileSchema = z.object({
  userId: z.string().min(1),
  employeeCode: optionalText(32),
  designation: optionalText(80),
  employmentType: z.enum(employmentTypeValues).default("FULL_TIME"),
  workLocation: optionalText(80),
  joinedOn: optionalDate,
  probationEndsOn: optionalDate,
  confirmedOn: optionalDate,

  dateOfBirth: optionalDate,
  gender: z.enum(genderValues).optional().or(z.literal("")),
  bloodGroup: optionalText(8),
  maritalStatus: optionalText(20),
  personalEmail: z.string().trim().email("That isn't a valid email.").optional().or(z.literal("")),
  personalPhone: optionalText(20),

  addressLine1: optionalText(160),
  addressLine2: optionalText(160),
  city: optionalText(80),
  /** Drives the professional-tax slab, so it is the one address field payroll depends on. */
  state: optionalText(80),
  pincode: optionalText(10),

  emergencyContactName: optionalText(80),
  emergencyContactPhone: optionalText(20),
  emergencyContactRelation: optionalText(40),

  panNumber: pan,
  aadhaarLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Only the last four digits — never the whole number.")
    .optional()
    .or(z.literal("")),
  uanNumber: optionalText(20),
  pfNumber: optionalText(32),
  esicNumber: optionalText(32),

  bankName: optionalText(80),
  bankAccountNumber: optionalText(32),
  bankIfsc: ifsc,
});

export const exitEmployeeSchema = z.object({
  userId: z.string().min(1),
  exitedOn: z.string().min(1, "Pick the last working day."),
  exitType: z.enum(exitTypeValues),
  exitReason: z.string().trim().max(500).optional().or(z.literal("")),
  /** Deactivating the login is the default — an ex-employee keeping access is the common mistake. */
  deactivateLogin: z.boolean().default(true),
});

export const holidaySchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Name the holiday."),
  date: z.string().min(1, "Pick a date."),
  optional: z.boolean().default(false),
  note: optionalText(200),
});

export const leaveTypeSchema = z.object({
  id: z.string().optional(),
  code: z.string().trim().toUpperCase().min(1, "Give it a short code.").max(10),
  name: z.string().trim().min(1, "Name the leave type."),
  annualQuota: z.coerce.number().min(0, "Quota can't be negative.").max(365),
  accrual: z.enum(leaveAccrualValues).default("ANNUAL"),
  carryForward: z.boolean().default(false),
  maxCarryForward: z.coerce.number().min(0).max(365).optional(),
  paid: z.boolean().default(true),
  proofAfterDays: z.coerce.number().int().min(0).max(30).optional(),
  active: z.boolean().default(true),
});

export const leaveRequestSchema = z
  .object({
    typeId: z.string().min(1, "Pick a leave type."),
    fromDate: z.string().min(1, "Pick a start date."),
    toDate: z.string().min(1, "Pick an end date."),
    fromHalfDay: z.boolean().default(false),
    toHalfDay: z.boolean().default(false),
    reason: z.string().trim().min(3, "Say why — the approver has to decide on something."),
  })
  .superRefine((val, ctx) => {
    if (new Date(val.toDate) < new Date(val.fromDate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The end date is before the start date.", path: ["toDate"] });
    }
  });

export const leaveDecisionSchema = z.object({
  id: z.string().min(1),
  approve: z.boolean(),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

export const attendanceMarkSchema = z.object({
  userId: z.string().min(1),
  date: z.string().min(1),
  status: z.enum(attendanceStatusValues),
  checkInAt: optionalText(20),
  checkOutAt: optionalText(20),
  note: optionalText(200),
});

const fixedRupees = z.coerce
  .number()
  .int("PF, ESI and TDS are in whole rupees.")
  .min(0, "PF, ESI and TDS can't be negative.")
  .max(1e8, "That's more than any salary.")
  .optional();

export const salaryStructureSchema = z.object({
  userId: z.string().min(1),
  effectiveFrom: z
    .string()
    .min(1, "From when does this apply?")
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the day it applies from."),
  basic: z.coerce.number().min(0),
  hra: z.coerce.number().min(0).default(0),
  conveyance: z.coerce.number().min(0).default(0),
  medical: z.coerce.number().min(0).default(0),
  specialAllowance: z.coerce.number().min(0).default(0),
  otherAllowance: z.coerce.number().min(0).default(0),
  pfApplicable: z.boolean().default(true),
  esiApplicable: z.boolean().default(true),
  ptApplicable: z.boolean().default(true),
  note: optionalText(200),
  /**
   * The company's own components besides the six (owner, 21 Oct 2026), monthly rupees. Names are checked
   * against each other and the six in src/actions/payroll.ts.
   */
  customComponents: z
    .array(z.object({ name: z.string().trim().min(1, "Name every component.").max(40, "Keep a component's name under 40 characters."), amount: z.coerce.number().min(0) }))
    .max(15, "Up to 15 of the company's own components.")
    .default([]),
  /**
   * PF, ESI and TDS typed over Deskzo's figures at the split (owner, 23 Oct 2026), whole rupees a month. A share
   * left out is worked out; PF's and ESI's are dropped in src/actions/payroll.ts where the scheme is off.
   */
  statutoryFixed: z
    .object({ pfEmployee: fixedRupees, pfEmployer: fixedRupees, esiEmployee: fixedRupees, esiEmployer: fixedRupees, tds: fixedRupees })
    .default({}),
  /** The CTC it was split from, and how a revision was given — kept for the record and the letter. */
  annualCtc: z.coerce.number().positive().max(1e10).optional(),
  revisionBasis: z.enum(["PERCENT", "AMOUNT", "CTC"]).optional(),
  revisionValue: z.coerce.number().min(-1e10).max(1e10).optional(),
});

export const payrollRunSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
});

export const payslipAdjustSchema = z.object({
  id: z.string().min(1),
  incomeTax: z.coerce.number().min(0).default(0),
  /** Let Deskzo work the TDS out again, over a figure typed before. `incomeTax` is then ignored. */
  workOutTax: z.boolean().optional(),
  otherDeduction: z.coerce.number().min(0).default(0),
  otherDeductionNote: optionalText(120),
  note: optionalText(200),
});

export type EmployeeProfileInput = z.infer<typeof employeeProfileSchema>;
export type LeaveRequestInput = z.infer<typeof leaveRequestSchema>;
export type SalaryStructureInput = z.infer<typeof salaryStructureSchema>;

const rupees = z.coerce.number().min(0, "Amounts can't be negative.").max(1e10, "That's more than any salary.");

/** One person's income tax position for a tax year (src/lib/hr/income-tax.ts). */
export const taxDeclarationSchema = z.object({
  userId: z.string().min(1),
  taxYear: z.coerce.number().int().min(2025).max(2100),
  regime: z.enum(["NEW", "OLD"]),
  hraExemption: rupees.default(0),
  section80C: rupees.default(0),
  section80CCD1B: rupees.default(0),
  section80D: rupees.default(0),
  homeLoanInterest: rupees.default(0),
  otherDeductions: rupees.default(0),
  previousGross: rupees.default(0),
  previousTds: rupees.default(0),
  previousPt: rupees.default(0),
  previousPf: rupees.default(0),
  otherIncome: rupees.default(0),
  otherTds: rupees.default(0),
  note: optionalText(300),
});
