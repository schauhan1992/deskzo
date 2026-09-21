import type { AccountType, ExpenseCategory } from "@prisma/client";

/**
 * The accounts the posting engine needs by name.
 *
 * Postings look accounts up by these keys rather than by code or title, because a business will
 * renumber its chart and rename "Sales — Software" to whatever its accountant prefers, and neither
 * should stop an invoice from posting. An account carrying a system key can't be deleted.
 */
export const SYSTEM_ACCOUNTS = {
  BANK: "BANK",
  CASH: "CASH",
  AR: "AR",
  AP: "AP",
  INPUT_CGST: "INPUT_CGST",
  INPUT_SGST: "INPUT_SGST",
  INPUT_IGST: "INPUT_IGST",
  OUTPUT_CGST: "OUTPUT_CGST",
  OUTPUT_SGST: "OUTPUT_SGST",
  OUTPUT_IGST: "OUTPUT_IGST",
  TDS_RECEIVABLE: "TDS_RECEIVABLE",
  TCS_PAYABLE: "TCS_PAYABLE",
  TDS_PAYABLE: "TDS_PAYABLE",
  EMPLOYEE_PAYABLE: "EMPLOYEE_PAYABLE",
  SALES: "SALES",
  SALES_RETURNS: "SALES_RETURNS",
  FREIGHT_RECOVERED: "FREIGHT_RECOVERED",
  PURCHASES: "PURCHASES",
  ROUND_OFF: "ROUND_OFF",
  ADJUSTMENTS: "ADJUSTMENTS",
  OPENING_BALANCE_EQUITY: "OPENING_BALANCE_EQUITY",
  RETAINED_EARNINGS: "RETAINED_EARNINGS",

  /**
   * Cheques are money promised, not money moved. They sit here until they clear, which is the
   * difference between a bank balance that reconciles and one that never does.
   */
  CHEQUES_IN_HAND: "CHEQUES_IN_HAND",
  CHEQUES_ISSUED: "CHEQUES_ISSUED",

  /** Payroll: the cost, the employer's own share, and what is owed to staff and the authorities. */
  SALARIES: "SALARIES",
  EMPLOYER_CONTRIBUTIONS: "EMPLOYER_CONTRIBUTIONS",
  SALARY_PAYABLE: "SALARY_PAYABLE",
  PF_PAYABLE: "PF_PAYABLE",
  ESI_PAYABLE: "ESI_PAYABLE",
  PT_PAYABLE: "PT_PAYABLE",

  DEPRECIATION: "DEPRECIATION",
  ACCUMULATED_DEPRECIATION: "ACCUMULATED_DEPRECIATION",

  /** The difference between the rate a foreign invoice was raised at and the rate it settled at. */
  FX_GAIN_LOSS: "FX_GAIN_LOSS",

  /**
   * One per expense category, so the mapping from a claim to an account is total and the compiler
   * catches a category that nobody gave a home to.
   */
  EXP_TRAVEL: "EXP_TRAVEL",
  EXP_FUEL: "EXP_FUEL",
  EXP_MILEAGE: "EXP_MILEAGE",
  EXP_TOLL_PARKING: "EXP_TOLL_PARKING",
  EXP_ACCOMMODATION: "EXP_ACCOMMODATION",
  EXP_MEALS: "EXP_MEALS",
  EXP_CLIENT_ENTERTAINMENT: "EXP_CLIENT_ENTERTAINMENT",
  EXP_COURIER: "EXP_COURIER",
  EXP_PHONE_INTERNET: "EXP_PHONE_INTERNET",
  EXP_OFFICE_SUPPLIES: "EXP_OFFICE_SUPPLIES",
  EXP_SOFTWARE_SUBSCRIPTION: "EXP_SOFTWARE_SUBSCRIPTION",
  EXP_MARKETING: "EXP_MARKETING",
  EXP_TRAINING: "EXP_TRAINING",
  EXP_REPAIRS_MAINTENANCE: "EXP_REPAIRS_MAINTENANCE",
  EXP_PROFESSIONAL_FEES: "EXP_PROFESSIONAL_FEES",
  EXP_OTHER: "EXP_OTHER",
} as const;

export type SystemAccountKey = (typeof SYSTEM_ACCOUNTS)[keyof typeof SYSTEM_ACCOUNTS];

type Seed = {
  code: string;
  name: string;
  type: AccountType;
  isGroup?: boolean;
  systemKey?: SystemAccountKey;
  parent?: string;
  description?: string;
};

/**
 * The chart a fresh install starts with — a small Indian trading business's books: GST in and out
 * kept separate because they're netted off at filing time, TDS receivable because customers deduct
 * it from what they pay us, and TCS payable because on some sales we collect it for them.
 *
 * Everything here is editable afterwards. It's a starting point, not a fixed structure.
 */
export const DEFAULT_CHART: Seed[] = [
  { code: "1000", name: "Assets", type: "ASSET", isGroup: true },
  { code: "1100", name: "Current Assets", type: "ASSET", isGroup: true, parent: "1000" },
  { code: "1110", name: "Bank Accounts", type: "ASSET", parent: "1100", systemKey: "BANK" },
  { code: "1120", name: "Cash in Hand", type: "ASSET", parent: "1100", systemKey: "CASH" },
  {
    code: "1130",
    name: "Accounts Receivable",
    type: "ASSET",
    parent: "1100",
    systemKey: "AR",
    description: "What customers owe us. Broken down per customer by the party on each line.",
  },
  {
    code: "1115",
    name: "Cheques in Hand",
    type: "ASSET",
    parent: "1100",
    systemKey: "CHEQUES_IN_HAND",
    description: "Cheques received but not yet cleared. They become bank once they do.",
  },
  { code: "1140", name: "Input CGST", type: "ASSET", parent: "1100", systemKey: "INPUT_CGST" },
  { code: "1141", name: "Input SGST", type: "ASSET", parent: "1100", systemKey: "INPUT_SGST" },
  { code: "1142", name: "Input IGST", type: "ASSET", parent: "1100", systemKey: "INPUT_IGST" },
  {
    code: "1150",
    name: "TDS / TCS Receivable",
    type: "ASSET",
    parent: "1100",
    systemKey: "TDS_RECEIVABLE",
    description: "Tax others deducted or collected from us, claimable against our own liability.",
  },
  { code: "1200", name: "Fixed Assets", type: "ASSET", isGroup: true, parent: "1000" },
  { code: "1210", name: "Computers & Equipment", type: "ASSET", parent: "1200" },
  { code: "1220", name: "Furniture & Fixtures", type: "ASSET", parent: "1200" },
  { code: "1230", name: "Vehicles", type: "ASSET", parent: "1200" },
  {
    code: "1290",
    name: "Accumulated Depreciation",
    type: "ASSET",
    parent: "1200",
    systemKey: "ACCUMULATED_DEPRECIATION",
    description:
      "What has been written off the assets above. A contra-asset — it carries a credit balance and nets against cost, so the balance sheet shows both what was paid and what is left.",
  },

  { code: "2000", name: "Liabilities", type: "LIABILITY", isGroup: true },
  { code: "2100", name: "Current Liabilities", type: "LIABILITY", isGroup: true, parent: "2000" },
  {
    code: "2110",
    name: "Accounts Payable",
    type: "LIABILITY",
    parent: "2100",
    systemKey: "AP",
    description: "What we owe vendors. Broken down per vendor by the party on each line.",
  },
  {
    code: "2115",
    name: "Cheques Issued, Not Presented",
    type: "LIABILITY",
    parent: "2100",
    systemKey: "CHEQUES_ISSUED",
    description: "Cheques written but not yet presented. Still our money until they are.",
  },
  { code: "2120", name: "Output CGST", type: "LIABILITY", parent: "2100", systemKey: "OUTPUT_CGST" },
  { code: "2121", name: "Output SGST", type: "LIABILITY", parent: "2100", systemKey: "OUTPUT_SGST" },
  { code: "2122", name: "Output IGST", type: "LIABILITY", parent: "2100", systemKey: "OUTPUT_IGST" },
  {
    code: "2130",
    name: "TCS Payable",
    type: "LIABILITY",
    parent: "2100",
    systemKey: "TCS_PAYABLE",
    description: "TCS collected from customers, owed onwards to the government.",
  },
  {
    code: "2135",
    name: "TDS Payable",
    type: "LIABILITY",
    parent: "2100",
    systemKey: "TDS_PAYABLE",
    description: "Tax we withheld from vendors, owed to the government rather than to them.",
  },
  {
    code: "2140",
    name: "Employee Reimbursements Payable",
    type: "LIABILITY",
    parent: "2100",
    systemKey: "EMPLOYEE_PAYABLE",
    description: "Approved expense claims not yet paid out.",
  },

  {
    code: "2141",
    name: "Salaries Payable",
    type: "LIABILITY",
    parent: "2100",
    systemKey: "SALARY_PAYABLE",
    description: "Net pay owed to staff for a month that has been run but not yet paid out.",
  },
  {
    code: "2142",
    name: "PF Payable",
    type: "LIABILITY",
    parent: "2100",
    systemKey: "PF_PAYABLE",
    description: "Both halves — what was deducted from staff and the employer's own share — owed to EPFO by the 15th.",
  },
  {
    code: "2143",
    name: "ESI Payable",
    type: "LIABILITY",
    parent: "2100",
    systemKey: "ESI_PAYABLE",
    description: "Employee and employer shares, owed by the 15th.",
  },
  {
    code: "2144",
    name: "Professional Tax Payable",
    type: "LIABILITY",
    parent: "2100",
    systemKey: "PT_PAYABLE",
    description: "Deducted from staff and paid to the state.",
  },

  { code: "3000", name: "Equity", type: "EQUITY", isGroup: true },
  { code: "3100", name: "Owner's Capital", type: "EQUITY", parent: "3000" },
  {
    code: "3800",
    name: "Opening Balance Equity",
    type: "EQUITY",
    parent: "3000",
    systemKey: "OPENING_BALANCE_EQUITY",
    description: "The other side of opening balances, until they're written off to capital.",
  },
  {
    code: "3900",
    name: "Retained Earnings",
    type: "EQUITY",
    parent: "3000",
    systemKey: "RETAINED_EARNINGS",
    description: "Accumulated profit. The balance sheet computes this rather than posting to it.",
  },

  { code: "4000", name: "Income", type: "INCOME", isGroup: true },
  { code: "4100", name: "Sales", type: "INCOME", parent: "4000", systemKey: "SALES" },
  {
    code: "4110",
    name: "Sales Returns",
    type: "INCOME",
    parent: "4000",
    systemKey: "SALES_RETURNS",
    description: "Credit notes land here rather than reducing Sales, so both figures stay visible.",
  },
  { code: "4200", name: "Freight Recovered", type: "INCOME", parent: "4000", systemKey: "FREIGHT_RECOVERED" },
  { code: "4900", name: "Other Income", type: "INCOME", parent: "4000", systemKey: "ADJUSTMENTS" },
  {
    code: "4950",
    name: "Exchange Gain / (Loss)",
    type: "INCOME",
    parent: "4000",
    systemKey: "FX_GAIN_LOSS",
    description:
      "The difference between the rate a foreign-currency invoice was raised at and the rate it settled at. Income-natured, so a loss simply shows as a negative.",
  },

  { code: "5000", name: "Expenses", type: "EXPENSE", isGroup: true },
  { code: "5100", name: "Purchases", type: "EXPENSE", parent: "5000", systemKey: "PURCHASES" },
  { code: "5200", name: "Salaries & Wages", type: "EXPENSE", parent: "5000", systemKey: "SALARIES" },
  {
    code: "5210",
    name: "Employer PF & ESI Contributions",
    type: "EXPENSE",
    parent: "5000",
    systemKey: "EMPLOYER_CONTRIBUTIONS",
    description:
      "The employer's own share. Kept apart from wages because it is a cost of employing somebody that never appears on their payslip as pay.",
  },
  { code: "5300", name: "Travel & Conveyance", type: "EXPENSE", parent: "5000", systemKey: "EXP_TRAVEL" },
  { code: "5301", name: "Fuel", type: "EXPENSE", parent: "5000", systemKey: "EXP_FUEL" },
  { code: "5302", name: "Mileage Reimbursement", type: "EXPENSE", parent: "5000", systemKey: "EXP_MILEAGE" },
  { code: "5303", name: "Tolls & Parking", type: "EXPENSE", parent: "5000", systemKey: "EXP_TOLL_PARKING" },
  { code: "5310", name: "Meals & Entertainment", type: "EXPENSE", parent: "5000", systemKey: "EXP_MEALS" },
  { code: "5311", name: "Client Entertainment", type: "EXPENSE", parent: "5000", systemKey: "EXP_CLIENT_ENTERTAINMENT" },
  { code: "5320", name: "Accommodation", type: "EXPENSE", parent: "5000", systemKey: "EXP_ACCOMMODATION" },
  { code: "5330", name: "Courier & Postage", type: "EXPENSE", parent: "5000", systemKey: "EXP_COURIER" },
  { code: "5340", name: "Phone & Internet", type: "EXPENSE", parent: "5000", systemKey: "EXP_PHONE_INTERNET" },
  { code: "5350", name: "Office Supplies", type: "EXPENSE", parent: "5000", systemKey: "EXP_OFFICE_SUPPLIES" },
  { code: "5400", name: "Rent", type: "EXPENSE", parent: "5000" },
  { code: "5500", name: "Software Subscriptions", type: "EXPENSE", parent: "5000", systemKey: "EXP_SOFTWARE_SUBSCRIPTION" },
  { code: "5510", name: "Marketing", type: "EXPENSE", parent: "5000", systemKey: "EXP_MARKETING" },
  { code: "5520", name: "Training", type: "EXPENSE", parent: "5000", systemKey: "EXP_TRAINING" },
  { code: "5530", name: "Repairs & Maintenance", type: "EXPENSE", parent: "5000", systemKey: "EXP_REPAIRS_MAINTENANCE" },
  { code: "5600", name: "Professional Fees", type: "EXPENSE", parent: "5000", systemKey: "EXP_PROFESSIONAL_FEES" },
  { code: "5700", name: "Other Expenses", type: "EXPENSE", parent: "5000", systemKey: "EXP_OTHER" },
  {
    code: "5800",
    name: "Depreciation",
    type: "EXPENSE",
    parent: "5000",
    systemKey: "DEPRECIATION",
    description: "This period's write-down on the fixed assets.",
  },
  { code: "5900", name: "Round Off", type: "EXPENSE", parent: "5000", systemKey: "ROUND_OFF" },
];

export const accountTypeLabels: Record<AccountType, string> = {
  ASSET: "Asset",
  LIABILITY: "Liability",
  EQUITY: "Equity",
  INCOME: "Income",
  EXPENSE: "Expense",
};

/**
 * Which side increases an account. Assets and expenses are debit-natured; everything else is
 * credit-natured. This is what turns a signed balance into "₹4,52,110 Dr".
 */
export function isDebitNatured(type: AccountType) {
  return type === "ASSET" || type === "EXPENSE";
}

/** Income and expenses close into retained earnings at year end; the rest carry forward. */
export function isProfitAndLoss(type: AccountType) {
  return type === "INCOME" || type === "EXPENSE";
}


/**
 * Where each kind of claim lands.
 *
 * A total `Record` on purpose: add a category to the enum and the compiler stops until it has an
 * account, rather than the claim quietly posting to "Other" — or worse, to nothing.
 */
export const EXPENSE_CATEGORY_ACCOUNT: Record<ExpenseCategory, SystemAccountKey> = {
  TRAVEL: SYSTEM_ACCOUNTS.EXP_TRAVEL,
  FUEL: SYSTEM_ACCOUNTS.EXP_FUEL,
  MILEAGE: SYSTEM_ACCOUNTS.EXP_MILEAGE,
  TOLL_PARKING: SYSTEM_ACCOUNTS.EXP_TOLL_PARKING,
  ACCOMMODATION: SYSTEM_ACCOUNTS.EXP_ACCOMMODATION,
  MEALS: SYSTEM_ACCOUNTS.EXP_MEALS,
  CLIENT_ENTERTAINMENT: SYSTEM_ACCOUNTS.EXP_CLIENT_ENTERTAINMENT,
  COURIER: SYSTEM_ACCOUNTS.EXP_COURIER,
  PHONE_INTERNET: SYSTEM_ACCOUNTS.EXP_PHONE_INTERNET,
  OFFICE_SUPPLIES: SYSTEM_ACCOUNTS.EXP_OFFICE_SUPPLIES,
  SOFTWARE_SUBSCRIPTION: SYSTEM_ACCOUNTS.EXP_SOFTWARE_SUBSCRIPTION,
  MARKETING: SYSTEM_ACCOUNTS.EXP_MARKETING,
  TRAINING: SYSTEM_ACCOUNTS.EXP_TRAINING,
  REPAIRS_MAINTENANCE: SYSTEM_ACCOUNTS.EXP_REPAIRS_MAINTENANCE,
  PROFESSIONAL_FEES: SYSTEM_ACCOUNTS.EXP_PROFESSIONAL_FEES,
  OTHER: SYSTEM_ACCOUNTS.EXP_OTHER,
};

/**
 * Accumulated depreciation is an asset account that carries a credit balance, so it must not be
 * read as "we own this much more". The balance sheet nets it against cost instead.
 */
export const CONTRA_ASSET_KEYS: SystemAccountKey[] = [SYSTEM_ACCOUNTS.ACCUMULATED_DEPRECIATION];
