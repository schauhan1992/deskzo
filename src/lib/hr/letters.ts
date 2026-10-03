import type { LetterType } from "@prisma/client";
import { MONTH_NAMES, monthLabel } from "@/lib/hr/calendar";

/**
 * The letters a company issues about its people.
 *
 * Pure text generation over a frozen payload — no database, no live lookups. That matters because
 * of what a letter is: a statement made on a particular day, quoted back at you by a bank, a
 * landlord or the next employer. Re-rendering one from current data would silently produce a
 * different document under the same reference number after the next appraisal, which is how an
 * experience letter ends up contradicting the one already in somebody's file.
 *
 * So the caller freezes everything the letter asserts into `payload` at issue, and this turns that
 * payload into words. Change the wording here and old letters reprint with the new wording but the
 * *same facts* — which is the right trade: prose can be improved, assertions cannot be rewritten.
 */

export type LetterPayload = {
  employeeName: string;
  designation: string;
  department: string | null;
  employeeCode: string | null;
  companyName: string;
  companyAddress: string | null;
  /** Annual CTC in rupees, for the letters that state money. */
  annualCtc?: number | null;
  monthlyGross?: number | null;
  joinedOn?: string | null;
  probationMonths?: number | null;
  confirmedOn?: string | null;
  lastWorkingDay?: string | null;
  reportingTo?: string | null;
  workLocation?: string | null;
  /** Offer letters expire; an open-ended one is a liability. */
  offerValidUntil?: string | null;
  /** For a salary certificate: the month it speaks to. */
  forMonth?: number | null;
  forYear?: number | null;
  netPay?: number | null;
  signatoryName?: string | null;
  signatoryTitle?: string | null;

  /** Increment / promotion: what it was, what it becomes, from when. */
  previousCtc?: number | null;
  previousDesignation?: string | null;
  effectiveFrom?: string | null;
  /** Transfer. */
  previousLocation?: string | null;
  /** Probation extension. */
  extendedUntil?: string | null;
  /** Internship. */
  stipend?: number | null;
  internshipFrom?: string | null;
  internshipTo?: string | null;
  projectArea?: string | null;
  /** Resignation. */
  resignedOn?: string | null;
  noticePeriodDays?: number | null;
  /** Warning. */
  incidentDate?: string | null;
  incidentSummary?: string | null;
  /** Maternity. */
  leaveFrom?: string | null;
  leaveTo?: string | null;
  leaveWeeks?: number | null;
  /** Travel NOC. */
  travelCountry?: string | null;
  travelFrom?: string | null;
  travelTo?: string | null;
  /** Gratuity statement. */
  gratuityAmount?: number | null;
  serviceYears?: number | null;
  /** Contract. */
  contractMonths?: number | null;
};

export const letterTypeLabels: Record<LetterType, string> = {
  OFFER: "Offer letter",
  APPOINTMENT: "Appointment letter",
  INTERNSHIP: "Internship offer",
  CONTRACT_AGREEMENT: "Contract / consultancy agreement",
  CONFIRMATION: "Confirmation letter",
  PROBATION_EXTENSION: "Probation extension",
  INCREMENT: "Increment letter",
  PROMOTION: "Promotion letter",
  TRANSFER: "Transfer letter",
  WARNING: "Warning letter",
  APPRECIATION: "Appreciation letter",
  MATERNITY_LEAVE: "Maternity leave sanction",
  SALARY_CERTIFICATE: "Salary certificate",
  ADDRESS_PROOF: "Address proof letter",
  TRAVEL_NOC: "Travel / visa NOC",
  EMPLOYMENT_VERIFICATION: "Employment verification",
  RESIGNATION_ACCEPTANCE: "Resignation acceptance",
  TERMINATION: "Termination letter",
  NO_DUES: "No-dues certificate",
  RELIEVING: "Relieving letter",
  EXPERIENCE: "Experience letter",
  INTERNSHIP_COMPLETION: "Internship completion",
  GRATUITY_STATEMENT: "Gratuity statement",
};

/** Grouped for the picker, because twenty-three in one list is not a menu. */
export const letterGroups: { group: string; types: LetterType[] }[] = [
  { group: "Joining", types: ["OFFER", "APPOINTMENT", "INTERNSHIP", "CONTRACT_AGREEMENT"] },
  {
    group: "While employed",
    types: ["CONFIRMATION", "PROBATION_EXTENSION", "INCREMENT", "PROMOTION", "TRANSFER", "APPRECIATION", "WARNING", "MATERNITY_LEAVE"],
  },
  { group: "For a third party", types: ["SALARY_CERTIFICATE", "ADDRESS_PROOF", "TRAVEL_NOC", "EMPLOYMENT_VERIFICATION"] },
  {
    group: "Leaving",
    types: ["RESIGNATION_ACCEPTANCE", "TERMINATION", "NO_DUES", "RELIEVING", "EXPERIENCE", "INTERNSHIP_COMPLETION", "GRATUITY_STATEMENT"],
  },
];

/** The reference-number segment for each type, e.g. WRF/OFR/2026/014. */
const LETTER_CODE: Record<LetterType, string> = {
  OFFER: "OFR",
  APPOINTMENT: "APT",
  INTERNSHIP: "INT",
  CONTRACT_AGREEMENT: "CTR",
  CONFIRMATION: "CNF",
  PROBATION_EXTENSION: "PRB",
  INCREMENT: "INC",
  PROMOTION: "PRM",
  TRANSFER: "TRF",
  WARNING: "WRN",
  APPRECIATION: "APP",
  MATERNITY_LEAVE: "MAT",
  SALARY_CERTIFICATE: "SAL",
  ADDRESS_PROOF: "ADR",
  TRAVEL_NOC: "NOC",
  EMPLOYMENT_VERIFICATION: "VER",
  RESIGNATION_ACCEPTANCE: "RSG",
  TERMINATION: "TRM",
  NO_DUES: "NDC",
  RELIEVING: "REL",
  EXPERIENCE: "EXP",
  INTERNSHIP_COMPLETION: "ICC",
  GRATUITY_STATEMENT: "GRT",
};

export function letterNumberFor(type: LetterType, year: number, sequence: number, prefix = "WRF") {
  return `${prefix}/${LETTER_CODE[type]}/${year}/${String(sequence).padStart(3, "0")}`;
}

const rupees = (value: number | null | undefined) =>
  value == null ? "—" : `₹${Math.round(value).toLocaleString("en-IN")}`;

/**
 * "2 October 2026" — the day a `@db.Date` holds, so read in UTC. Spelled here rather than asked of
 * Intl, whose en-IN month words and commas vary between ICU versions, and a letter is a document.
 */
const longDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

export function subjectFor(type: LetterType, p: LetterPayload): string {
  switch (type) {
    case "OFFER":
      return `Offer of employment — ${p.designation}`;
    case "APPOINTMENT":
      return `Appointment as ${p.designation}`;
    case "CONFIRMATION":
      return "Confirmation of employment";
    case "EXPERIENCE":
      return "Experience certificate";
    case "RELIEVING":
      return "Relieving letter";
    case "SALARY_CERTIFICATE":
      return "Salary certificate";
    case "ADDRESS_PROOF":
      return "Confirmation of employment and address";
    case "INTERNSHIP":
      return `Internship — ${p.projectArea ?? p.designation}`;
    case "CONTRACT_AGREEMENT":
      return `Engagement as ${p.designation}`;
    case "PROBATION_EXTENSION":
      return "Extension of probation";
    case "INCREMENT":
      return `Revision of compensation — effective ${longDate(p.effectiveFrom)}`;
    case "PROMOTION":
      return `Promotion to ${p.designation}`;
    case "TRANSFER":
      return `Transfer to ${p.workLocation ?? "a new location"}`;
    case "WARNING":
      return "Written warning";
    case "APPRECIATION":
      return "Letter of appreciation";
    case "MATERNITY_LEAVE":
      return "Sanction of maternity leave";
    case "TRAVEL_NOC":
      return `No objection certificate — travel${p.travelCountry ? ` to ${p.travelCountry}` : ""}`;
    case "EMPLOYMENT_VERIFICATION":
      return "Employment verification";
    case "RESIGNATION_ACCEPTANCE":
      return "Acceptance of resignation";
    case "TERMINATION":
      return "Termination of employment";
    case "NO_DUES":
      return "No-dues certificate";
    case "INTERNSHIP_COMPLETION":
      return "Internship completion certificate";
    case "GRATUITY_STATEMENT":
      return "Statement of gratuity";
  }
}

/**
 * The body, as editable text.
 *
 * Returned as plain paragraphs rather than HTML so that whoever issues it can read the whole thing
 * in a textarea and change a sentence before it goes out — which people always want to do, and
 * which is impossible once the wording is buried in a template component.
 */
export function renderLetter(type: LetterType, p: LetterPayload): string {
  const name = p.employeeName;
  const company = p.companyName;
  const signoff = [
    "",
    "Yours sincerely,",
    "",
    "",
    p.signatoryName ?? "For " + company,
    p.signatoryTitle ?? "Authorised Signatory",
    company,
  ].join("\n");

  switch (type) {
    case "OFFER":
      return [
        `Dear ${name},`,
        "",
        `We are pleased to offer you the position of ${p.designation}${p.department ? ` in our ${p.department} team` : ""} at ${company}.`,
        "",
        `Your annual cost to company will be ${rupees(p.annualCtc)}, of which the monthly gross is ${rupees(p.monthlyGross)}. A detailed breakup of the components forms part of your appointment letter.`,
        "",
        p.joinedOn ? `Your expected date of joining is ${longDate(p.joinedOn)}.` : "Your date of joining will be confirmed separately.",
        p.workLocation ? `You will be based at our ${p.workLocation} office.` : "",
        p.reportingTo ? `You will report to ${p.reportingTo}.` : "",
        "",
        p.probationMonths
          ? `You will be on probation for the first ${p.probationMonths} months from your date of joining, during which either party may terminate this engagement with 15 days' written notice.`
          : "",
        "",
        p.offerValidUntil
          ? `This offer is open for your acceptance until ${longDate(p.offerValidUntil)}. Please sign and return a copy to confirm.`
          : "Please sign and return a copy of this letter to confirm your acceptance.",
        "",
        "This offer is subject to verification of the documents and previous employment details you have provided.",
        "",
        "We look forward to having you with us.",
        signoff,
      ]
        .filter((line) => line !== "")
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");

    case "APPOINTMENT":
      return [
        `Dear ${name},`,
        "",
        `Further to our offer, we are pleased to confirm your appointment as ${p.designation}${p.department ? `, ${p.department}` : ""} at ${company} with effect from ${longDate(p.joinedOn)}.`,
        "",
        `Your annual cost to company is ${rupees(p.annualCtc)}. Salary is paid monthly, subject to statutory deductions for provident fund, employees' state insurance and professional tax as applicable, and to tax deducted at source.`,
        "",
        p.workLocation ? `Your place of work is our ${p.workLocation} office. You may be required to work from, or travel to, other locations as the business requires.` : "",
        p.reportingTo ? `You will report to ${p.reportingTo}.` : "",
        "",
        p.probationMonths
          ? `You will be on probation for ${p.probationMonths} months, extendable at the company's discretion. Your appointment will be confirmed in writing on satisfactory completion.`
          : "",
        "",
        "Your employment is governed by the company's policies as amended from time to time, including those on leave, attendance, confidentiality and acceptable use of company systems.",
        "",
        "Either party may terminate this employment by giving one month's written notice, or salary in lieu of notice.",
        "",
        "Please sign and return the duplicate copy of this letter in token of your acceptance.",
        signoff,
      ]
        .filter((line) => line !== "")
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");

    case "CONFIRMATION":
      return [
        `Dear ${name},`,
        "",
        `We are pleased to inform you that, following satisfactory completion of your probation, your services as ${p.designation} at ${company} stand confirmed with effect from ${longDate(p.confirmedOn)}.`,
        "",
        "All other terms and conditions of your appointment remain unchanged.",
        "",
        "We thank you for your contribution and look forward to your continued association with us.",
        signoff,
      ].join("\n");

    case "EXPERIENCE":
      return [
        "TO WHOMSOEVER IT MAY CONCERN",
        "",
        `This is to certify that ${name}${p.employeeCode ? ` (Employee Code ${p.employeeCode})` : ""} was employed with ${company} from ${longDate(p.joinedOn)} to ${longDate(p.lastWorkingDay)}.`,
        "",
        `At the time of leaving, ${name} held the position of ${p.designation}${p.department ? ` in the ${p.department} department` : ""}.`,
        "",
        "We found them sincere and hardworking in the discharge of their duties, and we wish them well in their future endeavours.",
        "",
        "This certificate is issued on request.",
        signoff,
      ].join("\n");

    case "RELIEVING":
      return [
        `Dear ${name},`,
        "",
        `This is to confirm that you have been relieved from the services of ${company} at the close of business on ${longDate(p.lastWorkingDay)}, consequent to your resignation.`,
        "",
        `You joined us on ${longDate(p.joinedOn)} and your last held position was ${p.designation}.`,
        "",
        "We confirm that all company property in your possession has been returned and that your full and final settlement will be processed in accordance with company policy.",
        "",
        "We thank you for your services and wish you success in your future endeavours.",
        signoff,
      ].join("\n");

    case "SALARY_CERTIFICATE":
      return [
        "TO WHOMSOEVER IT MAY CONCERN",
        "",
        `This is to certify that ${name}${p.employeeCode ? ` (Employee Code ${p.employeeCode})` : ""} is employed with ${company} as ${p.designation}${p.joinedOn ? `, and has been with us since ${longDate(p.joinedOn)}` : ""}.`,
        "",
        p.forMonth && p.forYear
          ? `For the month of ${monthLabel(p.forMonth, p.forYear)}, the gross salary was ${rupees(p.monthlyGross)} and the net amount credited was ${rupees(p.netPay)}.`
          : `The current annual cost to company is ${rupees(p.annualCtc)}, with a monthly gross of ${rupees(p.monthlyGross)}.`,
        "",
        "This certificate is issued on request for the purpose of the employee's records and may not be used for any other purpose.",
        signoff,
      ].join("\n");

    case "ADDRESS_PROOF":
      return [
        "TO WHOMSOEVER IT MAY CONCERN",
        "",
        `This is to certify that ${name}${p.employeeCode ? ` (Employee Code ${p.employeeCode})` : ""} is employed with ${company} as ${p.designation}${p.joinedOn ? ` since ${longDate(p.joinedOn)}` : ""}.`,
        "",
        p.companyAddress
          ? `Our registered office is at ${p.companyAddress.replace(/\n/g, ", ")}.`
          : "",
        "",
        "This certificate is issued on request.",
        signoff,
      ]
        .filter((line) => line !== "")
        .join("\n");

    case "INTERNSHIP":
      return clean([
        `Dear ${name},`,
        "",
        `We are pleased to offer you an internship with ${company}${p.projectArea ? ` in ${p.projectArea}` : ""}${p.department ? `, ${p.department}` : ""}.`,
        "",
        `The internship runs from ${longDate(p.internshipFrom ?? p.joinedOn)} to ${longDate(p.internshipTo)}${p.stipend ? `, with a monthly stipend of ${rupees(p.stipend)}` : " and is unpaid"}.`,
        "",
        // Stated plainly, because an internship that reads like employment is how a stipend
        // becomes a salary claim and an intern becomes a workman under the Industrial Disputes Act.
        "This is a training engagement and does not constitute employment. It carries no entitlement to the leave, benefits or notice applicable to employees, and confers no claim to employment at the end of the term.",
        "",
        p.reportingTo ? `You will be guided by ${p.reportingTo}.` : "",
        "",
        "You are expected to observe the company's policies on confidentiality and acceptable use of its systems for the duration of the internship.",
        "",
        "Please sign and return a copy to confirm your acceptance.",
        signoff,
      ]);

    case "CONTRACT_AGREEMENT":
      return clean([
        `Dear ${name},`,
        "",
        `This letter records the terms on which ${company} engages you as ${p.designation}${p.department ? ` for the ${p.department} function` : ""}.`,
        "",
        `The engagement runs from ${longDate(p.joinedOn)}${p.contractMonths ? ` for ${p.contractMonths} months` : ""}, and may be renewed by written agreement.`,
        "",
        `Your professional fee is ${rupees(p.monthlyGross)} a month${p.annualCtc ? `, being ${rupees(p.annualCtc)} annually` : ""}, payable against invoice and subject to tax deducted at source as applicable.`,
        "",
        // The distinction that matters: a contractor who is treated as an employee acquires an
        // employee's rights regardless of what the paperwork calls them.
        "You are engaged as an independent contractor. This engagement does not create a relationship of employment, and you are not entitled to provident fund, gratuity, paid leave or other employee benefits. You are responsible for your own statutory registrations and tax filings.",
        "",
        "Either party may end this engagement with 30 days' written notice.",
        "",
        "Work product created in the course of this engagement, and any confidential information you receive, belong to the company.",
        "",
        "Please sign and return a copy in token of your acceptance.",
        signoff,
      ]);

    case "PROBATION_EXTENSION":
      return clean([
        `Dear ${name},`,
        "",
        `Your probation as ${p.designation} was due to conclude on ${longDate(p.confirmedOn)}. Having reviewed your performance, we have decided to extend it until ${longDate(p.extendedUntil)}.`,
        "",
        "This is to give you a further opportunity to meet the expectations of the role. Your manager will set out the specific areas to work on and will review progress with you before the revised date.",
        "",
        "All other terms of your appointment remain unchanged during the extended period.",
        signoff,
      ]);

    case "INCREMENT":
      return clean([
        `Dear ${name},`,
        "",
        `We are pleased to inform you that your compensation has been revised with effect from ${longDate(p.effectiveFrom)}.`,
        "",
        p.previousCtc
          ? `Your annual cost to company increases from ${rupees(p.previousCtc)} to ${rupees(p.annualCtc)}${p.previousCtc && p.annualCtc ? ` — an increase of ${rupees(p.annualCtc - p.previousCtc)}` : ""}.`
          : `Your annual cost to company is now ${rupees(p.annualCtc)}.`,
        "",
        `Your revised monthly gross is ${rupees(p.monthlyGross)}, subject to the usual statutory deductions.`,
        "",
        "This revision reflects your contribution over the past year. All other terms of your employment remain unchanged.",
        "",
        "We thank you for your efforts and look forward to your continued contribution.",
        signoff,
      ]);

    case "PROMOTION":
      return clean([
        `Dear ${name},`,
        "",
        `We are pleased to inform you that you have been promoted${p.previousDesignation ? ` from ${p.previousDesignation}` : ""} to ${p.designation}${p.department ? `, ${p.department}` : ""}, with effect from ${longDate(p.effectiveFrom)}.`,
        "",
        p.annualCtc ? `Your annual cost to company in the new role is ${rupees(p.annualCtc)}.` : "",
        p.reportingTo ? `You will report to ${p.reportingTo}.` : "",
        "",
        "This promotion recognises the responsibility you have taken on and the standard of your work. We are confident you will meet the expectations of the larger role.",
        "",
        "All other terms of your employment remain unchanged.",
        signoff,
      ]);

    case "TRANSFER":
      return clean([
        `Dear ${name},`,
        "",
        `You are hereby transferred${p.previousLocation ? ` from ${p.previousLocation}` : ""} to our ${p.workLocation} office with effect from ${longDate(p.effectiveFrom)}.`,
        "",
        p.reportingTo ? `At the new location you will report to ${p.reportingTo}.` : "",
        "",
        "Your designation, compensation and all other terms of employment remain unchanged. Please complete any handover at your current location before the effective date.",
        signoff,
      ]);

    case "WARNING":
      return clean([
        `Dear ${name},`,
        "",
        `This letter is a formal written warning regarding your conduct${p.incidentDate ? ` on ${longDate(p.incidentDate)}` : ""}.`,
        "",
        p.incidentSummary ?? "[Set out what happened, with dates, and what was expected instead.]",
        "",
        "This falls short of the standard expected of you and of the company's policies. You are advised to ensure there is no recurrence.",
        "",
        // The two sentences that make a warning legally useful rather than decorative.
        "Please treat this as a warning. A repetition may result in further disciplinary action, up to and including termination of your employment.",
        "",
        "You may respond in writing within seven days if you wish to place your explanation on record. A copy of this letter will be placed on your personnel file.",
        signoff,
      ]);

    case "APPRECIATION":
      return clean([
        `Dear ${name},`,
        "",
        `We would like to place on record our appreciation of your work as ${p.designation}${p.department ? ` in ${p.department}` : ""}.`,
        "",
        p.incidentSummary ?? "[Say specifically what they did and what difference it made.]",
        "",
        "Thank you for the effort and the standard you have set. A copy of this letter will be placed on your personnel file.",
        signoff,
      ]);

    case "MATERNITY_LEAVE":
      return clean([
        `Dear ${name},`,
        "",
        `Your application for maternity leave is sanctioned for ${p.leaveWeeks ?? 26} weeks, from ${longDate(p.leaveFrom)} to ${longDate(p.leaveTo)}.`,
        "",
        // Stated because it is the entitlement, not a concession the company is granting.
        "This leave is with full pay, in accordance with the Maternity Benefit Act, 1961. Your employment continues throughout, and your position and terms will be unchanged on your return.",
        "",
        "Please keep your manager informed of your expected date of return. If you need to extend the leave on medical grounds, write to us and we will deal with it under the Act.",
        "",
        "We wish you well.",
        signoff,
      ]);

    case "TRAVEL_NOC":
      return clean([
        "TO WHOMSOEVER IT MAY CONCERN",
        "",
        `This is to certify that ${name}${p.employeeCode ? ` (Employee Code ${p.employeeCode})` : ""} has been employed with ${company} as ${p.designation}${p.joinedOn ? ` since ${longDate(p.joinedOn)}` : ""}.`,
        "",
        `${name} has applied for leave from ${longDate(p.travelFrom)} to ${longDate(p.travelTo)}${p.travelCountry ? ` to travel to ${p.travelCountry}` : ""}, and the company has no objection to the same.`,
        "",
        // What a consulate is actually asking, and the only sentence in the letter it reads.
        "We confirm that their employment is continuing, that their leave has been sanctioned, and that they are expected to resume duties with us on return.",
        "",
        "This certificate is issued on request for visa purposes.",
        signoff,
      ]);

    case "EMPLOYMENT_VERIFICATION":
      return clean([
        "TO WHOMSOEVER IT MAY CONCERN",
        "",
        `With reference to your request for verification, we confirm the following in respect of ${name}${p.employeeCode ? ` (Employee Code ${p.employeeCode})` : ""}:`,
        "",
        `Period of employment: ${longDate(p.joinedOn)} to ${p.lastWorkingDay ? longDate(p.lastWorkingDay) : "date, and continuing"}`,
        `Designation held: ${p.designation}`,
        p.department ? `Department: ${p.department}` : "",
        "",
        // Deliberately withheld. Salary is not ours to disclose to a third party, and "we confirm
        // the dates and the title" is the whole of what a background check is entitled to.
        "We confirm the above from our records. We do not disclose compensation details or the circumstances of separation to third parties.",
        "",
        "This confirmation is issued on request and without any liability on the part of the company.",
        signoff,
      ]);

    case "RESIGNATION_ACCEPTANCE":
      return clean([
        `Dear ${name},`,
        "",
        `We acknowledge your resignation dated ${longDate(p.resignedOn)} from the position of ${p.designation}${p.department ? `, ${p.department}` : ""}, and confirm that it is accepted.`,
        "",
        `Your last working day with ${company} will be ${longDate(p.lastWorkingDay)}.`,
        "",
        p.noticePeriodDays
          ? `Please ensure the notice period of ${p.noticePeriodDays} days is served as per your terms of employment. Any shortfall will be recovered in your full and final settlement.`
          : "",
        "",
        "Please complete a handover of your responsibilities, return all company property, and obtain clearance from each department before your last working day. Your full and final settlement will be processed thereafter.",
        "",
        "We thank you for your contribution and wish you well.",
        signoff,
      ]);

    case "TERMINATION":
      return clean([
        `Dear ${name},`,
        "",
        `This letter is to inform you that your employment with ${company} as ${p.designation} stands terminated with effect from ${longDate(p.lastWorkingDay)}.`,
        "",
        p.incidentSummary ?? "[State the ground for termination and refer to any prior warnings or notices.]",
        "",
        "You are required to return all company property in your possession and complete the clearance formalities. Your dues, if any, will be settled in accordance with your terms of employment and applicable law.",
        "",
        "A copy of this letter is placed on your personnel file.",
        signoff,
      ]);

    case "NO_DUES":
      return clean([
        "TO WHOMSOEVER IT MAY CONCERN",
        "",
        `This is to certify that ${name}${p.employeeCode ? ` (Employee Code ${p.employeeCode})` : ""}, who was employed with ${company} as ${p.designation} until ${longDate(p.lastWorkingDay)}, has completed all clearance formalities.`,
        "",
        "All company property, including identity card, access devices, laptop and any other assets issued, has been returned. No amount is outstanding from them to the company, and no amount is outstanding from the company to them.",
        "",
        "This certificate is issued on completion of the full and final settlement.",
        signoff,
      ]);

    case "INTERNSHIP_COMPLETION":
      return clean([
        "TO WHOMSOEVER IT MAY CONCERN",
        "",
        `This is to certify that ${name} successfully completed an internship with ${company} from ${longDate(p.internshipFrom ?? p.joinedOn)} to ${longDate(p.internshipTo ?? p.lastWorkingDay)}.`,
        "",
        p.projectArea ? `During the internship they worked on ${p.projectArea}${p.department ? ` with our ${p.department} team` : ""}.` : "",
        "",
        "We found them sincere and willing to learn, and we wish them well in their studies and career.",
        "",
        "This certificate is issued on request.",
        signoff,
      ]);

    case "GRATUITY_STATEMENT":
      return clean([
        `Dear ${name},`,
        "",
        `This statement sets out the gratuity payable to you on your separation from ${company} on ${longDate(p.lastWorkingDay)}.`,
        "",
        `Date of joining: ${longDate(p.joinedOn)}`,
        `Completed years of service: ${p.serviceYears ?? "—"}`,
        `Last drawn basic wages: ${rupees(p.monthlyGross)}`,
        "",
        // The formula is written out because this is the figure people check, and a number with no
        // working behind it is a number they have to take on trust.
        `Gratuity payable: ${rupees(p.gratuityAmount)}`,
        "",
        "Calculated under the Payment of Gratuity Act, 1972 as fifteen days' wages for each completed year of service, on a twenty-six day month, subject to the statutory ceiling of ₹20,00,000.",
        "",
        "This amount forms part of your full and final settlement and is subject to tax as applicable.",
        signoff,
      ]);
  }
}

/** Drops the empty strings used as optional lines, then collapses the gaps they leave behind. */
function clean(lines: string[]): string {
  return lines
    .filter((line) => line !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Which letters make sense for somebody right now, and why not when they do not.
 *
 * A system that offers an experience letter for a current employee, or a confirmation for somebody
 * still on probation, is one that lets HR discover the mistake after it has been signed. The reason
 * is returned rather than the option simply vanishing, because "why is this greyed out" is the next
 * question and a silent absence does not answer it.
 */
export function availableLetters(state: {
  joinedOn: Date | string | null;
  confirmedOn: Date | string | null;
  exitedOn: Date | string | null;
  employmentType?: string | null;
  serviceYears?: number;
}): { type: LetterType; reason?: string }[] {
  const joined = !!state.joinedOn;
  const exited = !!state.exitedOn;
  const isIntern = state.employmentType === "INTERN";
  const isContractor = state.employmentType === "CONTRACT" || state.employmentType === "CONSULTANT";

  const notJoined = "No joining date on the record yet.";
  const onlyLeavers = "Only for somebody who has left — record their exit first.";

  return (Object.keys(letterTypeLabels) as LetterType[]).map((type) => {
    // Offers and internships are written before anybody has joined, so they are never gated on it.
    if (type === "OFFER") return { type };
    if (type === "INTERNSHIP") {
      return isIntern ? { type } : { type, reason: "Their employment type is not Intern." };
    }
    if (type === "CONTRACT_AGREEMENT") {
      return isContractor ? { type } : { type, reason: "Their employment type is not Contract or Consultant." };
    }

    if (!joined) return { type, reason: notJoined };

    if (type === "CONFIRMATION" && !state.confirmedOn) {
      return { type, reason: "Not confirmed yet — set a confirmation date on the record first." };
    }
    if (type === "PROBATION_EXTENSION" && state.confirmedOn) {
      return { type, reason: "Already confirmed, so there is no probation to extend." };
    }
    if (type === "INTERNSHIP_COMPLETION" && !isIntern) {
      return { type, reason: "Their employment type is not Intern." };
    }
    if ((type === "EXPERIENCE" || type === "RELIEVING" || type === "NO_DUES" || type === "INTERNSHIP_COMPLETION") && !exited) {
      return { type, reason: onlyLeavers };
    }
    if (type === "GRATUITY_STATEMENT") {
      if (!exited) return { type, reason: onlyLeavers };
      if ((state.serviceYears ?? 0) < 5) {
        return { type, reason: "Under five years of service — the Act does not make gratuity payable." };
      }
    }
    // Resignation acceptance and termination are the letters that *precede* the exit being
    // recorded, so they are deliberately available before it.
    return { type };
  });
}
