import { productPage } from "./_build";
import type { SeedPage } from "./types";

/**
 * The People column: HR, payroll, attendance, leave, recruitment, targets and incentives.
 * Checked against src/lib/modules.ts, src/lib/hr/**, src/actions/{hr,payroll,attendance,leave,
 * candidate,biometric,target,incentive,wins}.ts and their check scripts. What isn't there is said
 * plainly where a buyer would ask (income tax on salary, interview stages, shifts).
 */

const hr = productPage({
  slug: "product/hr",
  name: "HR",
  seo: {
    title: "HR software for employee records and joining",
    description: "HR software for Indian companies: employee records, joining and exit checklists, HR letters, documents, holidays and a self-service page for staff.",
    keywords: ["HR software", "employee management software", "HRMS for Indian companies"],
  },
  eyebrow: "People",
  h1: "HR software for every employee record, from joining to exit",
  lead: "Employee records, departments and reporting lines, joining and leaving checklists, numbered HR letters, the holiday calendar and a self-service page for each person, in the same workspace as payroll and attendance.",
  answer: {
    question: "What is HR software?",
    answer:
      "HR software is the system a company keeps its employee records in, with the work around them: joining, documents, letters, holidays and exits. In {siteName}, HR is the People module: employee management software that attendance, leave, payroll and hiring all read from.",
    more: [
      "As an HRMS for Indian companies, it gives each person one employee record: employment type, designation, joining and confirmation dates, notice period, bank details, PAN, UAN, PF and ESIC numbers. A person sees their own record, a manager sees the records of the people who report to them, and HR sees everyone. Staff can update their own personal details, but not their employment terms.",
    ],
  },
  features: {
    heading: "What the HR module keeps and does",
    intro: "The HR module keeps one record for each person and does the paperwork that follows them.",
    items: [
      { icon: "users", title: "Employee records", body: "Full-time, part-time, contract, intern and consultant records, with statutory numbers kept behind HR's permission. Only the last four digits of an Aadhaar number are stored." },
      { icon: "building", title: "Departments and reporting lines", body: "Every person has a manager. The reporting line decides who can see a record and who approves leave and attendance corrections." },
      { icon: "check", title: "Joining and leaving checklists", body: "Checklists read the records themselves, so a missing salary structure or work state shows up before payroll runs. Six joining tasks and six leaving tasks are raised on their dates." },
      { icon: "file-text", title: "Numbered HR letters", body: "Offer, appointment, confirmation, experience, relieving and salary certificates among 23 letter types. Each is numbered, frozen when issued and printable." },
      { icon: "scroll", title: "Personnel documents", body: "PDFs, Word files and images up to 4 MB on each person's file, each marked as visible to the employee or kept for HR." },
      { icon: "calendar", title: "Holidays and celebrations", body: "A holiday calendar with optional holidays, birthdays and work anniversaries worked out from the records, and announcements to everyone or one team." },
    ],
  },
  how: [
    {
      heading: "How a new joiner is set up",
      intro: "A candidate who accepts an offer becomes an employee in one step, and the record starts complete.",
      steps: [
        "HR converts the accepted candidate into an employee.",
        "{siteName} creates their sign-in and emails them a link to choose a password.",
        "The employee profile is filled from the details the candidate submitted, with a probation end date.",
        "Six joining tasks are raised, dated from the joining day, and the manager is told.",
        "From the first day, the person clocks in, applies for leave and reads their payslips on My HR.",
      ],
    },
    {
      heading: "What happens when someone leaves?",
      intro: "Recording an exit starts the leaving checklist. The person's sign-in is switched off by default, and their open work can be handed over.",
      body: ["Exit types cover resignation, termination, retirement, the end of a contract and absconding. Six leaving tasks are raised when the exit is recorded. A handover moves the person's accounts, leads, tickets and quotes to a colleague, and the full and final settlement is worked out in payroll."],
    },
  ],
  faq: [
    ["Can employees update their own records?", "They can update their personal details, such as address and emergency contact. Employment terms, such as designation and joining date, are changed by HR only."],
    ["Do you store full Aadhaar numbers?", "No. Only the last four digits of an Aadhaar number are kept on the employee record."],
    ["Can we import our existing employee list?", "Yes. Employees and candidates can be imported from a CSV file and exported the same way. Salary, bank and statutory numbers are left out of the file on purpose, and are entered in {siteName}."],
    ["Is there a mobile app?", "There is no separate app. {siteName} runs in the browser on a phone or a computer, and My HR works on a phone screen."],
  ],
  related: ["/product/payroll", "/product/attendance", "/product/leave", "/product/recruitment", "/solutions/hr-teams", "/product/security"],
  cta: { heading: "Keep every employee record in one place", body: "Set up a workspace, import your team from a spreadsheet and switch on the People module. Every workspace starts with a {trialDays}-day free trial." },
});

const payroll = productPage({
  slug: "product/payroll",
  name: "Payroll",
  seo: {
    title: "Payroll software with PF, ESI and PT",
    description: "Payroll software for Indian companies: salary structures, a monthly run with PF and ESI calculation, professional tax, loss of pay and payslips.",
    keywords: ["payroll software", "PF and ESI calculation", "printable payslips"],
  },
  eyebrow: "People",
  h1: "Payroll software with PF, ESI and professional tax worked out",
  lead: "Salary structures, a monthly payroll run that reads attendance and leave, PF, ESI and professional tax, printable payslips, and the salary journal posted to your books when the run is locked.",
  answer: {
    question: "What does payroll software do?",
    answer:
      "Payroll software is the system that works out what each person is paid each month and what is deducted from it. In {siteName}, payroll software reads the month's attendance and unpaid leave, applies each person's salary structure, and calculates PF, ESI and professional tax before the payslips are issued.",
    more: [
      "The run covers everyone active in the month, including anyone who left during it. It can be re-run as often as needed while it is a draft, so a late attendance correction is simply picked up. Locking the run freezes the figures and posts the salary journal to the ledger; marking it paid posts the bank payment. Employees see their payslips once the run is locked.",
    ],
  },
  features: {
    heading: "What the payroll module calculates",
    intro: "The payroll module calculates each payslip from the salary structure, the month's attendance and the statutory deductions.",
    items: [
      { icon: "layers", title: "Salary structures", body: "Basic, HRA, conveyance, medical, special and other allowances, dated so a raise starts in the right month. Annual CTC is worked out, and a helper fills a structure from a CTC figure." },
      { icon: "calendar", title: "Loss of pay from the records", body: "Days marked absent and unpaid leave become loss of pay, with half days counted as half. A day with nothing recorded is never docked." },
      { icon: "shield", title: "PF and ESI calculation", body: "PF on basic up to a wage cap, with the employer's share split between EPS and EPF. ESI while gross pay is within ₹21,000, with a warning above it." },
      { icon: "map-pin", title: "Professional tax by state", body: "Slabs for Maharashtra, Karnataka, West Bengal, Tamil Nadu, Telangana and Gujarat. The state comes from the branch's GST state, or the employee's." },
      { icon: "receipt", title: "Payslips and the register", body: "Printable payslips, and a register with each month's gross, deductions, net pay and employer cost, searchable by person and department." },
      { icon: "book", title: "Posted to the books", body: "Locking a run posts salaries by department, employer contributions and PF, ESI, PT and TDS payable to the ledger, when the Accounting module is on." },
      { icon: "rupee", title: "Incentives on the payslip", body: "Approved sales incentives are added to the next run's payslips and marked paid, with no second spreadsheet." },
      { icon: "file-text", title: "Full and final settlement", body: "Final salary, leave encashment, gratuity under the five-year rule and notice recovery, drafted, approved and paid." },
    ],
  },
  how: [
    {
      heading: "How a month's payroll runs",
      intro: "Payroll software should follow the month, not a spreadsheet. The run moves from draft to locked to paid, and each step says what it changes.",
      steps: [
        "HR and managers settle the month's attendance and leave.",
        "Run payroll: every active person with a salary structure gets a payslip, and anyone without one is listed as skipped.",
        "Check the register and the flagged payslips, correct attendance if needed, and run again.",
        "Lock the run: the figures are frozen, payslips are visible to staff, and the salary journal posts to the ledger.",
        "Mark it paid when the salaries have gone out: the bank payment posts against salary payable.",
      ],
    },
  ],
  faq: [
    ["Does it calculate income tax (TDS) on salary?", "Not yet. You enter each person's monthly TDS figure; {siteName} keeps it across re-runs, prints it on the payslip and posts it to TDS payable. There is no tax regime choice, investment declaration or Form 16 in the product."],
    ["Which states' professional tax is built in?", "Six states' slabs are built in: Maharashtra, Karnataka, West Bengal, Tamil Nadu, Telangana and Gujarat. For a state whose slabs aren't built in yet, nothing is deducted and the payslip is flagged, so it can't pass unnoticed."],
    ["Does it produce the PF ECR file or ESI challans?", "No. {siteName} calculates the contributions and posts them to the ledger as payables. Filing the ECR on the EPFO portal and paying ESI are done on the government portals."],
    ["Can we correct attendance after running payroll?", "Yes, until the run is locked. Correct the attendance, run payroll again, and the payslips are recalculated."],
  ],
  related: ["/product/attendance", "/product/leave", "/product/hr", "/product/accounting-gst", "/product/targets-incentives", "/solutions/hr-teams"],
  cta: { heading: "Run next month's payroll from the records", body: "Payroll is offered to companies in India. Set up a workspace and try it with your own structures during the {trialDays}-day free trial." },
});

const attendance = productPage({
  slug: "product/attendance",
  name: "Attendance",
  seo: {
    title: "Attendance software with biometric devices",
    description: "Attendance software that takes punches from eSSL and ZKTeco biometric devices, web clock-in and corrections, and feeds loss of pay into payroll.",
    keywords: ["attendance software", "biometric attendance system", "attendance management"],
  },
  eyebrow: "People",
  h1: "Attendance software that reads your biometric devices",
  lead: "A record for each person for each day: present, from home, half day, on leave, absent, week off or holiday. Punches arrive from biometric terminals, people clock in from the web, and payroll reads the month.",
  answer: {
    question: "What is attendance software?",
    answer:
      "Attendance software is the record of who worked each day, and how that day counts for pay. In {siteName}, attendance software keeps one record per person per day, built from biometric punches, web clock-ins and approved leave, and payroll reads it for loss of pay.",
    more: [
      "A day with nothing recorded shows as not recorded, never as absent, so a missed punch doesn't quietly cut someone's pay. Approved leave writes itself into attendance, and a day corrected by hand is never overwritten by a later punch.",
    ],
  },
  features: {
    heading: "What attendance management covers",
    intro: "Attendance management covers every way a day's attendance is recorded, corrected and read.",
    items: [
      { icon: "fingerprint", title: "Biometric attendance system", body: "eSSL and ZKTeco terminals that push punches over the iclock (ADMS) protocol connect straight to your workspace. Devices are registered by serial number and can be switched off." },
      { icon: "history", title: "Every punch kept", body: "Raw punches are stored, including the method: fingerprint, card, face or password. Repeats the device sends again are ignored. The first and last punch of the day become check-in and check-out." },
      { icon: "gauge", title: "Web clock-in", body: "People without a terminal clock in and out from My HR, and worked minutes are counted. Clock-in is blocked on a day of approved leave." },
      { icon: "check", title: "Corrections with approval", body: "Staff ask for a past day to be corrected, and their manager or HR decides. Nobody approves their own. Every correction records who made it and when." },
      { icon: "calendar", title: "The month at a glance", body: "A grid with a row per person and counts of present, leave, absent and unrecorded days, filtered by department. Weekends and holidays are greyed out." },
      { icon: "file-text", title: "Imports from eTimeTrackLite", body: "A .dat or .txt export from eTimeTrackLite can be imported by hand, and punches from an unmapped enrolment number attach to the person once mapped." },
    ],
  },
  how: [
    {
      heading: "How a punch becomes a day of attendance",
      intro: "The terminal connects out to {siteName}; nothing has to be installed on your side.",
      body: [
        "Each punch arrives with the terminal's serial number and the person's enrolment number. {siteName} stores it, matches it to the person, and rolls the day's punches into one attendance record with check-in and check-out times. Days on approved leave and days corrected by hand are left as they are. Payroll then counts absent days and unpaid leave as loss of pay.",
      ],
      bullets: ["Present, work from home, half day, on leave, absent, week off and holiday", "The raw punch log for each person and day, for any dispute", "Unmapped punches kept until the enrolment number is mapped"],
      preview: "attendance",
      side: "left",
    },
  ],
  faq: [
    ["Which biometric devices work with it?", "eSSL and ZKTeco terminals that push punches over the iclock (ADMS) protocol. If a device can't push, export its log from eTimeTrackLite and import the file."],
    ["Will a missed punch mark someone absent?", "No. Punches never mark anyone absent, and a day with nothing recorded shows as not recorded. Only HR or a manager marks a day absent."],
    ["Does it handle shifts, late marks and overtime?", "Not yet. Attendance records the day's status and first and last punch. There are no shift rosters, grace periods, late marks or overtime calculations, and the week off is Saturday and Sunday."],
    ["Can staff mark attendance from their phones?", "They can clock in and out from My HR in a phone's browser. There is no GPS or geo-fencing on clock-in."],
  ],
  related: ["/product/leave", "/product/payroll", "/product/hr", "/product/crm", "/solutions/hr-teams"],
  cta: { heading: "Connect your terminals and see this month's attendance", body: "Register a device by its serial number and punches start arriving. Every workspace starts with a {trialDays}-day free trial." },
});

const leave = productPage({
  slug: "product/leave",
  name: "Leave",
  seo: {
    title: "Leave management software with approvals",
    description: "Leave management software: leave types and balances by financial year, requests that skip weekends and holidays, approvals, and unpaid leave into payroll.",
    keywords: ["leave management software", "leave management system", "leave approval"],
  },
  eyebrow: "People",
  h1: "Leave management software that counts days correctly",
  lead: "Leave types with quotas and accrual, balances for each financial year, requests that leave out weekends and holidays, and approvals by the person's manager. Approved leave writes itself into attendance and payroll.",
  heroPreview: "attendance",
  answer: {
    question: "What is a leave management system?",
    answer:
      "Leave management software is the place where staff apply for time off, managers approve it, and balances are kept. {siteName}'s leave management system counts only working days, deducts the balance on approval, and marks the days as leave in attendance.",
    more: [
      "Balances run from April to March. Each leave type has an annual quota, credited once a year or a twelfth each month, and is paid or unpaid. The balance shows what was opened, credited and used, with pending requests shown apart, so nobody books the same days twice.",
    ],
  },
  features: {
    heading: "What the leave module does",
    intro: "The leave module does the counting, checking and recording that a leave register on paper leaves to people.",
    items: [
      { icon: "layers", title: "Your own leave types", body: "Casual, sick or earned leave, or whatever your policy calls them: each with a code, an annual quota, yearly or monthly accrual, paid or unpaid, and whether it can be encashed." },
      { icon: "calendar", title: "Weekends and holidays skipped", body: "A request's days leave out weekends and closed holidays, with half days at either end. The form shows the count and the days it skipped." },
      { icon: "check", title: "Checks before a request", body: "An overlap with another request is refused, and paid leave is refused when the balance, less pending requests, is too short. Unpaid leave is never blocked." },
      { icon: "users", title: "Approval by the manager", body: "The person's manager, or anyone with HR's leave permission, decides. Nobody approves their own request." },
      { icon: "gauge", title: "Who's away", body: "A company and team leave register with filters, an approvals queue, and everyone off in the next 30 days." },
      { icon: "rupee", title: "Unpaid leave into payroll", body: "Leave of an unpaid type becomes loss of pay in the month's payroll run, and encashable leave is paid out in the exit settlement." },
    ],
  },
  how: [
    {
      heading: "How a leave request is approved",
      intro: "Leave approval takes one decision, and the balance, attendance and payroll follow from it.",
      steps: [
        "The employee picks a leave type and dates on My HR, and sees the working days it will use.",
        "Their manager gets the request in the approvals queue.",
        "On approval, the balance is deducted and the days are marked on leave or half day in attendance.",
        "If the plan changes before the leave starts, the employee withdraws it and the balance comes back.",
      ],
    },
  ],
  faq: [
    ["Do weekends and holidays inside a request count?", "No. Weekends and holidays that close the office are left out of the count. Optional holidays don't close the office, so a request over one counts that day."],
    ["Is the balance deducted when someone applies?", "Only when the request is approved. Pending days are shown apart from the balance, and a paid request can't take the balance below what is already pending."],
    ["Does unused leave carry forward automatically?", "Not yet. The carry-forward limit is recorded on each leave type, but moving unused days into the next year's opening balance isn't automatic today."],
  ],
  related: ["/product/attendance", "/product/payroll", "/product/hr", "/solutions/hr-teams"],
  cta: { heading: "Set up your leave policy in minutes", body: "Add your leave types and quotas, and your team can apply the same day. Every workspace starts with a {trialDays}-day free trial." },
});

const recruitment = productPage({
  slug: "product/recruitment",
  name: "Recruitment",
  seo: {
    title: "Recruitment software from offer to day one",
    description: "Recruitment software for a hiring team: candidate records and statuses, offer letters, a details form candidates fill in, and a one-step move to employee.",
    keywords: ["recruitment software", "offer letter software", "candidate tracking"],
  },
  eyebrow: "People",
  h1: "Recruitment software from the first conversation to the first day",
  lead: "A record for each candidate, their status from prospect to joined, numbered offer letters, a secure form for their joining details, and conversion into an employee with their sign-in, profile and joining tasks.",
  answer: {
    question: "What does recruitment software do in {siteName}?",
    answer:
      "Recruitment software is the record of candidates until they join. In {siteName}, each candidate has a record with their role, source, offered CTC and expected joining date, and a status that moves from prospect to offered, accepted and joined.",
    more: [
      "Candidates don't get a sign-in while they are candidates. They get a one-time link to a details form, valid for 14 days, and what they submit waits for HR to review. On conversion, their details, documents and CV move to the employee file, and their account is created with a link to choose a password.",
    ],
  },
  features: {
    heading: "What candidate tracking covers",
    intro: "Candidate tracking covers each person from the first conversation to their first day.",
    items: [
      { icon: "users", title: "Candidate records", body: "Name, contact details, designation, department, manager, source, offered CTC and expected joining, with notes." },
      { icon: "check", title: "Statuses that mean something", body: "Prospect, offered, accepted, declined with a reason, joined or withdrawn. Offer and acceptance dates are stamped as they happen." },
      { icon: "file-text", title: "Offer letter software", body: "Offer, internship and contract letters, priced from the offered CTC, numbered and printable. HR sends them." },
      { icon: "lock", title: "A details form for the candidate", body: "A one-time link, which can be revoked, where the candidate fills in their joining details. Nothing reaches the employee record until HR converts them." },
      { icon: "scroll", title: "Documents that follow them", body: "The CV and other documents stay on the candidate and move to the employee file on joining." },
      { icon: "door", title: "One step to employee", body: "An accepted candidate becomes an employee with a sign-in, a profile, a probation end date and six joining tasks, and their manager is told." },
    ],
  },
  how: [
    {
      heading: "How a hire moves from offer to day one",
      intro: "Each step is one action on the candidate's record.",
      steps: [
        "Add the candidate with their role, source and expected joining date.",
        "Issue the offer letter and mark them offered.",
        "Send them the details form link, and mark them accepted when they say yes.",
        "Review what they submitted, then convert them to an employee.",
      ],
    },
  ],
  faq: [
    ["Does it manage interview rounds and job postings?", "No. {siteName} tracks candidates from the conversation to the offer and joining. Interview scheduling, scorecards, job postings and a careers page aren't part of it."],
    ["Can we send offer letters from it?", "Yes. Offer letters are drafted from the offered CTC, numbered and printed. HR sends the letter and the details form link to the candidate."],
    ["Do candidates get an account before they join?", "No. They fill in a form through a one-time link. Their sign-in is created when HR converts them to an employee."],
  ],
  related: ["/product/hr", "/product/payroll", "/product/attendance", "/solutions/hr-teams"],
  cta: { heading: "Make your next hire's first day ready", body: "Set up a workspace and track your open candidates in the People module. Every workspace starts with a {trialDays}-day free trial." },
});

const targets = productPage({
  slug: "product/targets-incentives",
  name: "Targets & incentives",
  seo: {
    title: "Sales incentive software with targets",
    description: "Sales incentive software that measures targets from invoices, collections, calls and visits, pays incentive schemes through payroll, and celebrates wins.",
    keywords: ["sales incentive software", "sales target tracking", "sales leaderboard"],
  },
  eyebrow: "People",
  h1: "Sales incentive software with targets measured from the records",
  lead: "Targets for people, teams and the company, measured against the invoices, collections, calls and visits themselves. Incentive schemes with thresholds, bands and caps, paid through payroll. A wins wall and a sales leaderboard for the floor.",
  answer: {
    question: "How does sales target tracking work here?",
    answer:
      "Sales target tracking in {siteName} stores only the target. Achievement is worked out from the records each time it is read, so a cancelled invoice lowers it the moment it is cancelled. Nobody types in their own numbers.",
    more: [
      "Sales incentive software is what turns achievement into pay. A scheme pays a share of achievement or of target, a flat amount, a rate per unit, or by bands, with a minimum threshold and a cap on each payout. Every earning keeps its workings in words, and it is frozen when it is calculated, so editing a scheme next quarter can't change what was paid last quarter.",
    ],
  },
  features: {
    heading: "What targets and incentives measure",
    intro: "Targets and incentives measure people against the records they create, and pay them for it.",
    items: [
      { icon: "gauge", title: "Fifteen measures", body: "Invoiced value less credit notes, collections, order value and margin, leads created and won, calls connected, call minutes, visits, new companies and contacts, tickets resolved, new customers and add-on value." },
      { icon: "calendar", title: "Any period, any scope", body: "A month, a quarter, a year or your own dates, for a person, a department or the whole company. The page shows pace against the time left." },
      { icon: "rupee", title: "Incentive schemes", body: "Five ways to pay, thresholds and caps, and a check that flags gaps or overlaps between bands before a scheme goes live." },
      { icon: "check", title: "Approval, then payroll", body: "Earnings are due, approved, held, cancelled or paid, and nobody decides their own. Approved earnings join the next payroll run's payslips." },
      { icon: "receipt", title: "Pay on collection", body: "An incentive can wait until the invoice behind it is fully collected." },
      { icon: "sparkles", title: "A wins wall and leaderboard", body: "A big deal, a target reached or a new customer's first order is celebrated once, on a wins wall with the month's sales leaderboard and a TV screen." },
    ],
  },
  how: [
    {
      heading: "How an incentive is earned and paid",
      intro: "The same records that measure the target pay the incentive.",
      steps: [
        "Set the month's targets for the team in one go.",
        "Invoices, collections, calls and visits count towards them as they happen.",
        "At the period's end, earnings are calculated with their workings, and frozen.",
        "A manager approves them, or holds them with a reason.",
        "Approved earnings are added to the next payroll run and marked paid.",
      ],
    },
  ],
  faq: [
    ["What happens to an incentive if the invoice is cancelled?", "Achievement is recalculated from the records, so a cancelled invoice lowers it at once. Earnings already calculated are frozen with their workings; a manager can hold or cancel one with a reason."],
    ["Do team and company targets pay incentives?", "They are measured and shown with their pace, but incentive earnings are worked out for people's own targets, not for department or company targets."],
    ["Is the TV leaderboard public?", "No. The TV screen is signed in like any other page, and settings can hide rupee amounts on the wins wall."],
  ],
  related: ["/product/crm", "/product/payroll", "/product/reports", "/solutions/sales-teams", "/solutions/founders"],
  cta: { heading: "Pay incentives from the numbers, not a spreadsheet", body: "Set a target, choose a scheme and let the records do the counting. Every workspace starts with a {trialDays}-day free trial." },
});

export const PEOPLE_PAGES: SeedPage[] = [hr, payroll, attendance, leave, recruitment, targets];
