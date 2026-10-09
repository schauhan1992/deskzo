# Deskzo People as a standalone HRMS — roadmap

**Status:** proposal, 9 Oct 2026. Sections 2 and 3 describe the code as it is on `main` at 6f03059. Nothing in section 6 is built unless it says so. Competitor facts were read from the vendors' public pages on 9 Oct 2026 and link to their source; the links are listed in section 10. Anything not confirmed on the vendor's own page is marked *unconfirmed*. Section 9 lists the decisions needed.

---

## 1. Summary

Deskzo People is already a product, and the parts that exist are careful with money. Salary structures are dated, PF follows the ₹25,000 ceiling split by day, and ESI is decided on the wage rate. Payroll runs lock and post to the ledger, and the full and final settlement cannot pay a month twice. Leave accrues and carries forward by tenure, eSSL/ZKTeco terminals push punches with no connector PC, hiring runs through to joining, and 23 letter types are frozen at issue. Against greytHR, Keka and Zoho Payroll it is missing what an Indian buyer checks first. Income tax is typed in by hand, and there is no Form 130/138 (formerly Form 16/24Q), no PF ECR or ESI file, and no bank transfer file. There is no mobile app, no geo attendance and no shifts; the week-off is fixed to Saturday and Sunday. There are no loans, no reimbursements inside People and no performance reviews, and every employee must have an email login. The inventory also found professional-tax errors that would reach payslips today: Tamil Nadu's half-yearly table charged every month, Maharashtra's exemption for women, Karnataka's ₹300 February and Punjab's development tax. Two labour-code questions (gratuity for fixed-term staff, the 50% wage rule) need a CA before any outside company runs payroll on Deskzo. All three competitors put full statutory payroll in their entry plans at roughly ₹40–₹100 per employee per month, so Deskzo cannot charge more for payroll alone. The plan is to fix Phase 0 and build Phase 1, about 50–60 developer-weeks. Deskzo should then sell on what the others need an integration for: HR, CRM incentives and the books on one record.

---

## 2. What exists today

Deskzo People is already a product: `src/lib/products.ts` defines `people` as the modules `hr`, `payroll`, `visitors` and `engagement`, sold only in India. What follows is read from the code, not from the marketing copy.

### Employee records

- `EmployeeProfile` (prisma/schema.prisma) hangs off a `User`: code, designation, employment type, work location, notice period, joining, probation, confirmation and exit dates, personal and emergency details, PAN, the last four digits of Aadhaar only, UAN, PF and ESIC numbers, bank account.
- `EmploymentHistory` keeps previous employers with a background-verification stamp.
- Reporting lines are `User.managerId`, walked by `src/lib/org-chart.ts` for access scoping. There is no org chart screen.
- **Limit: every employee is a login.** `User.email` is required and unique, and every active user is a seat (`src/lib/seats.ts`). A factory or retail worker with no email address cannot be put on the payroll, and an employee who only needs payslips costs the same seat as a CRM user.
- **Limit: no custom fields.** `CustomFieldEntity` covers companies, vendors, contacts, leads, orders and items, not employees.

### Hiring and joining

- `Candidate` with six statuses (prospect, offered, accepted, declined, joined, withdrawn), a one-time intake link the candidate fills in themselves, documents, offer/internship/contract letters, and conversion into an employee (`src/actions/candidate.ts`, `/people/hiring`).
- Onboarding and offboarding checklists are computed from the real records, not ticked (`src/lib/hr/onboarding.ts`): no salary structure, no work state or no bank details is flagged as blocking.
- Conversion and exit raise dated tasks for HR, IT and the manager (`ONBOARDING_TASKS`, `OFFBOARDING_TASKS`).
- **Limits:** no job openings or requisitions, no careers page or job-board posting, no interview rounds or scorecards, no CV parsing. The task lists are hard-coded, so a customer cannot change them.

### Leave and holidays

- `LeaveType` (quota, annual or monthly accrual, carry-forward with a cap, paid/unpaid, encashable, proof after N days), `LeaveBalance` per person per year, `LeaveRequest` with half days, overlap and balance checks (`src/actions/leave.ts`, `src/lib/hr/leave-balance.ts`).
- Accrual follows joining and exit dates, and carry-forward is recomputed on every look (fixed in 2161b2f and 6f03059).
- `Holiday` with a restricted-holiday flag.
- **Limits:**
  - One set of leave types for the whole company. There are no policies per grade, location or employment type, and no probation rules.
  - The leave year is fixed to April–March.
  - There is no sandwich rule, no comp-off and no leave encashment outside full and final.
  - Holidays apply company-wide; there is no list per location.
  - There is no way to type in opening balances when a company moves to Deskzo, except the adjustment field.

### Attendance

- `AttendanceDay`, one row per person per day, from web clock-in/out (`src/actions/attendance.ts`), HR marking, leave, or biometric punches.
- `AttendanceRegularisation`: an employee asks, a manager or HR decides (`src/actions/regularisation.ts`).
- Biometric: eSSL/ZKTeco terminals push over the ADMS "iclock" protocol to `src/app/api/biometric/iclock`, with raw punches kept forever (`BiometricPunch`, `src/lib/hr/iclock.ts`, `src/lib/hr/punch-rollup.ts`). There is a `.dat` file import for offices running eTimeTrackLite with no route in.
- **Limits:**
  - **Week-offs are fixed to Saturday and Sunday** (`DEFAULT_WEEK_OFFS` in `src/lib/hr/calendar.ts`, never overridden). A six-day or alternate-Saturday company gets wrong leave counts and a wrong attendance grid.
  - No shifts, rosters, late marks, short-hours rules, overtime or comp-off. Overtime punch types are stored and ignored.
  - Clock-in is the web page only. It records no location, photo or IP. (The security module's sign-in location rules are a sign-in gate, not attendance.)
  - Nothing is ever marked absent automatically. Loss of pay counts only days somebody recorded as `ABSENT` or as unpaid leave (`src/lib/hr/loss-of-pay.ts`). This is deliberate and safe, but a customer with no HR person marking days pays everybody in full.

### Payroll

- Dated `SalaryStructure` with six fixed components (basic, HRA, conveyance, medical, special, other) and PF/ESI/PT switches.
- `PayrollRun` (draft → locked → paid) and `Payslip`, which stores every figure.
- The engine is `src/lib/hr/payroll.ts`. It covers:
  - PF with the ₹15,000/₹25,000 wage ceilings split by day, and the EPS/EPF split;
  - ESI with coverage decided on the wage rate;
  - PT for six states;
  - pro-rating for joiners, leavers and loss of pay;
  - CRM incentives paid through the payslip.
- A locked run posts to the ledger when Books is on (`postPayrollRunToLedger`).
- Payslips print from `/payslips/[id]/print`, and employees see their own under `/people/me`.
- Check suites: `check:payroll`, `check:pay-periods`, `check:settlement`.
- **Limits:**
  - **Income tax is typed in by hand.** No regimes, declarations, proofs, projection, Form 130 (old Form 16) or Form 138 (old 24Q). The file says so at the top.
  - **Statutory filings and payments:**
    - no PF ECR file;
    - no ESI contribution file;
    - no PT returns;
    - no Labour Welfare Fund;
    - no bank transfer file;
    - no register export.
  - **What the structure can hold:**
    - no custom pay components;
    - no one-time earnings or deductions apart from the incentive and one "other deduction";
    - no arrears, and a mid-month revision applies to the whole month;
    - no statutory bonus;
    - no loans or advances;
    - no reimbursements through payroll.
  - **How runs are organised:**
    - one run per month per workspace (`@@unique([month, year])`), so there are no off-cycle runs and no separate runs per legal entity or PF establishment;
    - employer cost leaves out EDLI and EPF admin charges.
  - Payslips are not emailed. HR notifications are in-app only (`EMAILED_NOTIFICATIONS` in `src/lib/email.ts` holds one type, and it is not an HR one).
  - The people importer refuses salary, bank and statutory numbers by design (`src/lib/portability/importers/people.ts`). Bringing in 200 employees means typing 200 salary structures.

### Full and final settlement

- `FinalSettlement` and `src/lib/hr/settlement.ts`:
  - final month's salary, paid once against the payroll (the five guards in `src/lib/hr/payroll-month.ts`);
  - leave encashment to the last working day;
  - gratuity under the Payment of Gratuity Act on 15/26 of basic;
  - notice-period recovery;
  - typed-in bonus, advance recovery, asset recovery and income tax.
- It can go negative when the employee owes money.
- Exit records reason and type and raises offboarding tasks. A CRM handover moves accounts, leads and tickets in one pass (`/people/[id]/handover`).
- **Limits:** advances and assets are typed in, because there is no loan or asset ledger in People. There is no resignation flow started by the employee, and no exit interview form beyond a note.

### Letters and documents

- 23 letter types, from offer to gratuity statement. Each is frozen at issue so it reprints the same facts, numbered and revocable (`EmployeeLetter`, `src/lib/hr/letters.ts`).
- Employee documents have a "visible to the employee" switch.
- **Limits:**
  - Letter wording lives in code. A customer can edit a letter before issue but cannot keep its own templates.
  - There is no e-sign.
  - Files are stored as base64 in the database, capped at 4 MB each (`src/lib/hr/document-upload.ts`). That is fine for a few hundred employees and is the first thing to move at scale.

### Engagement, celebrations, visitors

- Speak Up is an anonymous feedback channel. Forms and polls can be aimed at a person, department or everyone, with mandatory forms covering the screen (`src/actions/survey.ts`, module `engagement`).
- Birthdays and anniversaries are derived from the record, with one-click wishes (`src/lib/hr/celebrations.ts`, `wishes.ts`).
- Visitor management runs as a reception kiosk with host alerts and invites (`src/actions/visitor.ts`).
- **Limits:** there is no performance management. `src/actions/performance.ts` is CRM activity metrics, not appraisals. There are also no goals or OKRs, no review cycles, no timesheets and no HR helpdesk for employees (the `HelpDesk` model is for customers).

### Things People borrows from other products

- **Expense claims** (`Expense`, manager approval, reimbursement, ledger posting) are in the `expenses` module, which is sold in Deskzo Books, not People.
- **Equipment custody** ("What I'm holding") is in `it_assets`, sold in Deskzo Inventory.
- **Incentives** are in Deskzo CRM.

A People-only customer gets none of these three, although onboarding and the settlement refer to assets and advances.

### Approvals and access

- Single-level approval: leave and regularisation go to `User.managerId`, or to anyone with `hr.approveLeave` or `hr.manage`. Expenses snapshot the approver at submission.
- There are no multi-level chains, delegation or escalation.
- Permissions are `hr.manage`, `hr.viewAll`, `hr.approveLeave`, `hiring.manage`, `payroll.manage`, `engagement.*` and `visitors.*`.

### No mobile app, no HR reports

- There is no native app and no installable web app for employees. The only web-app manifest is the visitor kiosk's (`src/app/(public)/kiosk/[token]/manifest`).
- There is no HR reporting beyond the headcount figure on `/people` and the payroll register. The Analytics module has no HR sources.

---

## 3. Defects found while taking the inventory

**Items 1–4 fixed in code on 9 Oct 2026, awaiting the CA:** professional tax is now dated rules per state (src/lib/hr/professional-tax.ts). It also fixes a fifth error found while doing it: Maharashtra's ₹300 February was being charged on the ₹175 slab as ₹275. Every state is still marked `awaitingCa`, and the CA review in section 7 decides the figures. Items 5 and 6 are open.

These are in today's payroll and would reach a customer's payslips. They are separate from the gaps in section 6 because they are wrong rather than missing. Each needs a CA's confirmation before the fix. The sources are secondary (law-firm notes and payroll publishers), as marked.

1. **Tamil Nadu professional tax is charged as if it were monthly.**
   - `PT_SLABS.TAMIL_NADU` holds Tamil Nadu's *half-yearly* table: income bands of ₹21,000–₹75,000 a half-year and amounts of ₹135–₹1,250 a half-year. `computeProfessionalTax` applies it to a *monthly* gross, every month.
   - Somebody on ₹50,000 a month is charged ₹690 a month, which is ₹8,280 a year. Article 276 of the Constitution caps professional tax at ₹2,500 a year.
   - The amounts are also the older ones. Greater Chennai Corporation raised three bands to ₹180, ₹425 and ₹930 from the second half of 2024-25 ([AscentHR](https://ascent-hr.com/notification/professional-tax-slab-revision-chennai/), [greytHR notice](https://www.greythr.com/notifications/revised-profession-tax-slab-for-chennai-corporation/); the two disagree on the date).
   - Other Tamil Nadu local bodies set their own amounts.
2. **Maharashtra exempts women earning up to ₹25,000 a month from professional tax, from 1 April 2023.** The engine has no gender test, so it deducts ₹175–₹200 from them ([Khaitan & Co, Apr 2023](https://www.khaitanco.com/sites/default/files/2023-04/Ergo_18042023_0.pdf)). `EmployeeProfile.gender` exists, so the fix is small.
3. **Karnataka charges ₹300 in February from 1 April 2025**, so the year totals ₹2,500. The table has no February top-up for Karnataka ([AscentHR](https://ascent-hr.com/notification/increase-in-the-annual-pt-for-salaried-persons/)). The result is ₹100 under-deducted per employee per year, which is the employer's liability.
4. **Punjab is listed as a state with no professional tax.** It levies the Punjab State Development Tax, ₹200 a month, which the employer deducts from anyone whose income is taxable ([ClearTax](https://cleartax.in/s/professional-tax-punjab), *unconfirmed against the Act*).
5. **Gratuity uses five years for everybody.**
   - The four labour codes took effect on 21 Nov 2025 ([EY alert](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-in/alerts-hub/2025/11/new-labour-codes-implemented-across-the-country-effective-21-november-2025.pdf)). Under the Code on Social Security, fixed-term employees qualify after one year.
   - `GRATUITY_MIN_YEARS = 5` is applied to `CONTRACT` employees too.
6. **The wage definition in the codes is not modelled.**
   - Under the codes, exclusions (HRA, conveyance, special allowance and so on) above 50% of total pay are added back into "wages" for PF, gratuity and bonus.
   - `suggestStructure` proposes basic at 40% of CTC, and gratuity is computed on basic alone.
   - The commentators disagree on the detail ([Business Today on ICAI's reading](https://www.businesstoday.in/amp/personal-finance/news/story/what-the-new-labour-codes-mean-for-your-salary-gratuity-icai-breaks-it-down-508922-2025-12-31)), and draft central rules were only published on 30 Dec 2025. This is a CA question before it is a code change.

Smaller items, also for the CA:

- Employer cost leaves out EDLI (0.5%) and EPF admin charges (0.5%).
- ESI is decided month by month. The code flags, but does not apply, the rule that coverage runs to the end of the contribution period.
- The code still names Form 16. From tax year 2026-27, under the Income-tax Act, 2025:
  - salary TDS is section 392;
  - the certificate is Form 130;
  - the quarterly return is Form 138 ([Free Press Journal](https://www.freepressjournal.in/amp/business/form-16-to-turn-into-form-130-26as-to-become-168-from-april-1-2026-what-will-change-under-the-new-income-tax-act-2025), [legaldev.in](https://legaldev.in/blog/income-tax-rules-2026-form-138-140-tds); *secondary sources, confirm on incometax.gov.in*).

---

## 4. Against greytHR, Keka and Zoho People

How to read the columns:

- **Deskzo.** "Built" means a customer can use it today. "Partial" means some of it exists, or it exists in another Deskzo product. "Missing" means there is nothing.
- **Competitors.** Each cell says what the vendor's own page claims, with the plan where it matters; section 5 has the prices.
  - "Not found" means not found on the pages read. It does not mean the product lacks it.
  - "Search only" means the page appeared in search results but was not opened.
- **Zoho.** Zoho People has no Indian payroll of its own. It is sold alongside Zoho Payroll, and the column says which product each feature is in.

| Capability | Deskzo today | greytHR | Keka | Zoho People (+ Zoho Payroll) | Why it matters to an Indian SMB |
|---|---|---|---|---|---|
| Employee records and self-service | **Built.** `EmployeeProfile`, `/people/me` | Yes: payslips, declarations, leave, letters, helpdesk ([ESS][g-ess]) | Yes, Foundation ([pricing][k-price]) | Yes, all People plans; Payroll's portal from Free ([People][z-cmp], [Payroll][zp-price]) | Table stakes |
| Mobile app for employees | **Missing.** No app, no installable web app | Yes ([attendance][g-att]) | Yes, Foundation ([pricing][k-price]) | iOS and Android, all plans ([comparison][z-cmp]) | Most staff will only ever open HR on a phone |
| Employees without an email address | **Missing.** `User.email` required | Not found | Mobile-number OTP login, Strength ([pricing][k-price]) | Not found | Factories, shops and field teams |
| Geo-fenced or selfie attendance | **Missing.** Web clock-in records nothing | Selfie, GeoMark, geo-fencing (Growth); GPS tracking add-on ₹140/user ([attendance][g-att], [pricing][g-price]) | Selfie, geo-fencing, location punching, Strength ([pricing][k-price]) | Geo-restriction, GPS, face recognition, Professional ([comparison][z-cmp]) | Field sales and multi-site teams |
| Biometric terminals | **Built.** eSSL/ZKTeco push, `.dat` import (`src/lib/hr/iclock.ts`) | Third-party hardware, no brands named ([attendance][g-att]) | Device counts differ by page: 120+, 200+, 1000+ ([attendance][k-att], [SMB][k-smb]) | Biometric integrations, Professional ([comparison][z-cmp]) | Most Indian offices already have an eSSL box on the wall |
| Shifts, rosters, week-off patterns | **Missing.** Saturday and Sunday fixed (`src/lib/hr/calendar.ts`) | Shifts and rotation, Growth ([pricing][g-price], [attendance][g-att]) | Basic in Foundation; advanced is an add-on ([pricing][k-price]) | Basic shifts from Essential HR; rotation from Professional ([comparison][z-cmp]) | Six-day weeks and second-Saturday rules are common |
| Overtime and comp-off | **Missing** | Overtime, Growth ([pricing][g-price]); comp-off in help pages ([search only][g-compoff]) | Overtime, Foundation ([pricing][k-price]); comp-off in help pages ([search only][k-compoff]) | Overtime, Professional; comp-off, all plans ([comparison][z-cmp]) | Required for wage-earning staff |
| Holidays by location | **Missing.** One list (`Holiday`) | In help pages ([search only][g-hol]) | Holiday plans in help pages ([search only][k-hol]) | Holiday tracking; by location not confirmed ([comparison][z-cmp]) | State holidays differ |
| Leave with accrual, carry-forward, encashment | **Built** for one company-wide policy (`LeaveType`, `leave-balance.ts`) | Unlimited types, 50+ policy parameters, encashment ([leave][g-leave]) | Foundation ([pricing][k-price]) | Custom policies, all plans ([comparison][z-cmp]) | Table stakes; policies per group are expected |
| Attendance regularisation | **Built** (`AttendanceRegularisation`) | Yes ([attendance][g-att]) | Yes ([attendance][k-att]) | Professional ([comparison][z-cmp]) | Table stakes |
| Payroll run and payslips | **Built**, six fixed components (`src/lib/hr/payroll.ts`) | Essential, the entry plan ([pricing][g-price]) | Foundation, the entry plan ([pricing][k-price]) | Zoho Payroll, free up to 10 employees ([pricing][zp-price]) | The reason most buyers look |
| PF, ESI, PT computed | **Partial.** PF and ESI built; PT for six states with defects (section 3) | PF, ESI, PT for all states, LWF ([payroll][g-pay]) | PF, ESI, PT across states, LWF ([payroll][k-pay]) | EPF, ESI, PT by state, LWF, from Free ([pricing][zp-price]) | Errors here are the employer's liability |
| TDS computed from declarations, both regimes | **Missing.** Typed in by hand | TDS with declarations and proofs; both regimes ([payroll][g-pay], [POI][g-poi]) | Both regimes, declarations with proof checks ([features][k-payf]) | TDS worksheet, proofs, both regimes ([pricing][zp-price], [regime][zp-regime]) | The first question in a payroll demo |
| Form 130 / Form 138 (Form 16 / 24Q) | **Missing** | Form 24Q with FVU check; signed Form 16 ([payroll][g-pay]) | Form 130 (Form 16); quarterly TDS reports ([payroll][k-pay]) | Signed Form 130 and Form 138, Standard ([pricing][zp-price]) | Due every year and every quarter |
| PF ECR, ESI, PT challan files | **Missing** | ECR generation, ESI challans ([payroll][g-pay]) | ECR-ready reports, ESI ([payroll][k-pay]) | ECR and ESIC files; the employer files them ([compliance][zp-comp]) | Monthly filings |
| Bank transfer file | **Missing** | Formats for all major banks; PayNow direct debit ([payroll][g-pay]) | NEFT, RTGS and bank CSV files; no direct API, per its help centre ([help][k-bank]) | Direct payment through HSBC (Free) and ICICI (Standard) ([pricing][zp-price]) | Saves retyping net pay into the bank portal |
| Loans and salary advances | **Missing.** Typed into settlement only | Yes ([payroll][g-pay]) | Loans and advances, Foundation ([pricing][k-price]) | Standard ([pricing][zp-price]) | Common in SMBs, especially for wage earners |
| Expense reimbursement | **Partial.** In Deskzo Books, not People (`Expense`) | Add-on, ₹35/user ([pricing][g-price]) | Foundation ([pricing][k-price]) | Reimbursements in Payroll; claims in Zoho Expense ([pricing][zp-price]) | Expected inside HR in India |
| Full and final settlement | **Built.** Gratuity, encashment, notice recovery (`src/lib/hr/settlement.ts`) | Yes ([payroll][g-pay]) | Yes, with gratuity and encashment ([features][k-payf]) | Yes ([features][zp-feat]) | The most disputed calculation |
| Hiring | **Partial.** Candidates, intake link, offer letters, conversion; no job openings or interviews | Recruit add-on, ₹2,500/recruiter ([pricing][g-price]) | Separate Hiring product ([pricing][k-price]) | Zoho Recruit, a separate product ([pricing][z-price]) | Small companies hire in spreadsheets; a simple pipeline is enough |
| Onboarding and offboarding | **Built**, fixed task lists (`src/lib/hr/onboarding.ts`) | Self-onboarding and exit, Essential ([pricing][g-price]) | Basic in Foundation, advanced in Strength ([pricing][k-price]) | Essential HR ([pricing][z-price]) | |
| Letters and e-sign | **Partial.** 23 letter types, frozen at issue; no e-sign, no own templates | Letters and mail merge; e-sign not found ([HR][g-hr]) | Letters in Foundation; Keka Sign in Strength ([pricing][k-price]) | Mail merge and e-signature integration ([comparison][z-cmp]) | Offer and relieving letters go out every week |
| Performance reviews, goals | **Missing** | Add-on, ₹35–₹45/user: goals, reviews, 360 ([pricing][g-price], [PMS][g-pms]) | Growth: OKRs, reviews, calibration ([pricing][k-price]) | Premium: goals, OKR, 360, appraisal ([comparison][z-cmp]) | Asked for once a company passes about 50 people |
| Surveys and engagement | **Built.** Anonymous Speak Up, forms and polls | Surveys, eNPS, polls ([engagement][g-eng]) | Polls in Foundation; surveys in Strength ([pricing][k-price]) | eNPS and pulse, Premium ([comparison][z-cmp]) | Nice to have |
| HR helpdesk | **Missing** for employees | Yes, Essential ([pricing][g-price]) | Add-on ([pricing][k-price]) | Enterprise ([comparison][z-cmp]) | Nice to have |
| Timesheets | **Missing** | Add-on, ₹35/user ([pricing][g-price]) | Separate PSA product ([pricing][k-price]) | Professional ([pricing][z-price]) | Services firms |
| Org chart | **Partial.** Reporting lines exist; no chart | Not found | Org structure, Foundation ([pricing][k-price]) | Not found | |
| HR analytics | **Missing** beyond headcount and the payroll register | 100+ MIS reports ([HR][g-hr]) | Analytics in Strength; report builder in Growth ([pricing][k-price]) | HR reports; advanced analytics in Premium ([pricing][z-price]) | Owners want attrition and payroll cost |
| Approval workflows | **Partial.** One level, to the manager | Workflows with escalation ([leave][g-leave], [HR][g-hr]) | Workflow automation, Growth ([pricing][k-price]) | Multi-level approvals from Essential HR ([comparison][z-cmp]) | Larger SMBs want two levels |
| Asset custody | **Partial.** In Deskzo Inventory (`it_assets`) | Asset management ([HR][g-hr]) | Asset tracking, Strength ([pricing][k-price]) | Not found | Laptops and SIMs on exit |
| Visitor management | **Built** (`src/actions/visitor.ts`) | Not found | Not found | Not found (People Kiosk is for attendance) | Rarely bundled |
| Accounting link | **Built** with Deskzo Books (ledger posting) | Tally JV add-on ([search only][g-tally]) | Tally, Zoho Books, QuickBooks ([features][k-payf]) | Zoho Books; Tally not mentioned ([pricing][zp-price]) | Tally is what most SMBs use |
| Sales incentives on the payslip | **Built** with Deskzo CRM | Not found | Not found | Not found | Sales-led SMBs pay monthly incentives |

---

## 5. What the competitors charge

**How to read the table:**

- Prices are as published on 9 Oct 2026, in rupees per month, before GST. Zoho and RazorpayX say so; the others do not say.
- The 50- and 200-employee columns are this document's arithmetic, not the vendors' figures. They use annual billing where there is a choice, and the figure in brackets is per employee.

| Vendor and plan | Published price | 50 employees | 200 employees | Source |
|---|---|---|---|---|
| greytHR Essential: payroll, leave, self-service, helpdesk | ₹2,495 for 50, + ₹45 each above | ₹2,495 (₹50) | ₹9,245 (₹46) | [pricing][g-price] |
| greytHR Growth: adds shifts, overtime, geo-fencing | ₹4,495 for 50, + ₹85 each above | ₹4,495 (₹90) | ₹17,245 (₹86) | [pricing][g-price] |
| greytHR Premium | Quote | — | — | [pricing][g-price] |
| Keka Foundation, Strength, Growth | Not published; "a nominal setup fee applies" | — | — | [pricing][k-price] |
| Keka, its own SMB page | From ₹90 per employee, or from ₹6,999 a month; "no setup fees" | — | — | [SMB][k-smb] |
| Keka, third-party figures (*unconfirmed*) | ₹9,999 / ₹12,999 / ₹15,999 for 100, + ₹90 / ₹120 / ₹150 each above | Foundation ₹9,999 (₹200) | Foundation ₹18,999 (₹95) | [HROne blog][hrone-keka], [codingclave][codingclave] |
| Zoho Payroll Standard: TDS, Form 130/138, loans | ₹1,000 for 25, + ₹40 each above | ₹2,000 (₹40) | ₹8,000 (₹40) | [pricing][zp-price] |
| Zoho Payroll Premium: adds leave and attendance | ₹4,000 for 50, + ₹80 each above | ₹4,000 (₹80) | ₹16,000 (₹80) | [pricing][zp-price] |
| Zoho People Essential HR / Professional / Premium / Enterprise: HR only, no payroll | ₹48 / ₹96 / ₹144 / ₹192 per user, minimum 5 | Professional ₹4,800 (₹96) | Professional ₹19,200 (₹96) | [pricing][z-price], [price data][z-json] |
| sumHR Startup / Basic / Advanced | ₹49 / ₹69 / ₹119 per user; one-time setup fee | ₹2,450 / ₹3,450 / ₹5,950 | ₹9,800 / ₹13,800 / ₹23,800 | [pricing][s-price] |
| Darwinbox | Quote only, per employee per month | — | — | [quote][d-quote], [attendance][d-ta] |
| RazorpayX Payroll Elite | ₹6,499 for 50, + ₹150 each, up to 100 | ₹6,499 (₹130) | Not offered above 100 | [pricing][rzp] |
| HROne Basic | ₹4,950 for 50, + ₹99 each above | ₹4,950 (₹99) | ₹19,800 (₹99) | [pricing][hrone] |
| Pocket HRMS Standard | ₹2,995 for 50, + ₹60 each above | ₹2,995 (₹60) | ₹11,995 (₹60) | [pricing][pocket] |
| factoHR Core | ₹4,999 for 50, + ₹99 each above | ₹4,999 (₹100) | ₹19,849 (₹99) | [pricing][facto] |

What the table says:

- **Statutory payroll is in the entry plan everywhere:** greytHR Essential, Keka Foundation, and Zoho Payroll from its free plan. The vendors charge more for:
  - geo and selfie attendance;
  - shifts;
  - performance;
  - helpdesk;
  - more than one legal entity.
- **The going rate** for payroll, leave and attendance at 200 employees is about ₹40–₹100 per employee per month. With performance and analytics it rises to about ₹120–₹190.
- **Most vendors sell a block of 50 employees as the floor,** at ₹2,000–₹6,500 a month.
- **"Filing" usually means producing the file.**
  - Zoho says it generates the ECR and ESIC files, and the employer files them on the portals ([compliance][zp-comp]).
  - Keka's help centre says it produces bank files and does not pay salaries itself ([help][k-bank]). Its features page claims direct bank-portal integration ([features][k-payf]).
  - greytHR's homepage claims direct government-portal filing ([home][g-home]).
- **The vendors already use the Income-tax Act, 2025 names,** Form 130 and Form 138 (Zoho, Keka).
- **Darwinbox** sells by quote to companies of 1,000 and more ([home][d-home]); it is not Deskzo's competitor for SMBs.
- **sumHR** is the cheapest per head, and marks several features "coming soon" ([pricing][s-price]).

---

## 6. The roadmap

Sizes are for one developer and include the check suites. **S** means up to a week, **M** two to four weeks, and **L** more than a month. They are rough, and every item that touches money needs a CA's answer before it starts, not after.

### Phase 0 — fix what is wrong before another company's payroll runs on it

| # | Item | Size | Depends on | Compliance risk |
|---|---|---|---|---|
| 0.1 | Professional tax table rebuilt as dated rules per state, like `PF_WAGE_CEILINGS`: half-yearly states (Tamil Nadu, Kerala), gender exemptions (Maharashtra), February top-ups (Maharashtra, Karnataka), Punjab's development tax, the ₹2,500 annual cap as a hard stop | M | CA confirms each state's table | Over-deduction is the employee's money; under-deduction is the employer's liability. **CA review.** |
| 0.2 | Gratuity for fixed-term employees after one year, pro rata, under the Code on Social Security | S | CA | Gratuity paid late or short carries interest. **CA review.** |
| 0.3 | Labour-code wage test on every salary structure: show when exclusions pass 50%, change `suggestStructure` from 40% basic | S | CA decides whether PF and gratuity move to the code's wage base | Wrong PF base is an EPFO assessment. **CA review.** |
| 0.4 | EDLI and EPF admin charges in employer cost | S | — | Low; it is a cost figure, not a deduction |
| 0.5 | Work week per workspace: Sunday only, Saturday and Sunday, second and fourth Saturdays | S–M | — | Leave counted on a working Saturday is leave wrongly refused or wrongly granted |

### Phase 1 — what must exist before People is sold on its own

These are the questions an Indian buyer asks in the first demo. A payroll product that cannot answer "does it do TDS and the ECR" is not shortlisted.

| # | Item | Size | Depends on | Compliance risk |
|---|---|---|---|---|
| 1.1 | **TDS on salary:** old and new regime (new is the default), slabs per tax year, standard deduction, rebate and marginal relief, surcharge and cess, a projection across the year that trues up by March, previous-employer income for mid-year joiners | L | 1.3, 1.13 | The employer is liable for tax it under-deducts, with interest. **CA review before release and after every Budget.** |
| 1.2 | **Investment declarations and proofs** in self-service: declare in April, submit proofs by a cut-off, HR verifies, TDS recomputes. HRA exemption needs landlord PAN above the threshold | M | 1.1, documents | As 1.1. The declaration form's new number under the 2025 rules is *unconfirmed*; check before building |
| 1.3 | **Pay components:** custom earnings and deductions, each flagged for taxability and for PF, ESI and PT; one-time earnings and deductions per run; arrears for back-dated revisions; a mid-month revision split by days. `Payslip` moves from fixed columns to lines | L | — | Each component's treatment for PF and ESI wages is a legal question. **CA review of the defaults.** |
| 1.4 | **Statutory files:** PF ECR file, ESI monthly contribution file, PT summaries per state, Labour Welfare Fund for the states that levy it | M | 0.1, 1.3 | Formats change without notice; the first months of each file should be checked by the customer's consultant |
| 1.5 | **Year-end and quarterly tax outputs:** Form 130 Part B (Part A comes from TRACES) and the data for the Form 138 return, in a layout Protean's return utility accepts | M | 1.1 | A wrong return draws notices for every employee on it. **CA review.** |
| 1.6 | **Paying people:** bank transfer files for the main banks plus a generic NEFT layout, payroll register to Excel, payslip PDF emailed on lock | M | platform mail (exists) | Low |
| 1.7 | **Loans and salary advances:** a ledger per employee, instalments deducted in the run, the balance carried into full and final, replacing the typed `advanceRecovery` | M | 1.3 | Interest-free and cheap loans above a small-loan threshold are a taxable perquisite. **CA review.** |
| 1.8 | **Reimbursements:** either put the `expenses` module in People, or add a claims flow paid through payroll with taxable and non-taxable heads | M | decision 5 | Low, provided taxable claims go through TDS |
| 1.9 | **Attendance rules:** shifts with grace periods, week-off patterns per shift or branch, late marks and half-days, overtime with approval, comp-off, and an opt-in "absent when nothing is recorded" after a cut-off | L | 0.5 | Overtime at twice the ordinary rate under the codes. **Labour consultant review.** |
| 1.10 | **Leave policies:** by employment type, branch or grade; probation rules; leave year April–March or January–December; optional sandwich rule; opening balances on migration | M | — | Low |
| 1.11 | **Holidays per branch** | S | `Branch` (exists) | — |
| 1.12 | **Employees without email:** sign in by mobile number and one-time code, or employee records that never sign in. This touches auth, seats and sign-in rules | L | decision 3 | Low |
| 1.13 | **Migration import:** salary structures, bank details, statutory numbers, opening leave, and year-to-date salary and TDS. It needs its own importer behind `payroll.manage`, logged, because the people importer refuses these fields on purpose | M | 1.3 | Year-to-date figures feed TDS, so a bad import is a tax error |
| 1.14 | **Mobile:** an installable web app first, with clock-in, location against a geo-fence per branch, optional selfie, leave, payslips, approvals. Native apps later | L | 1.9 | Location and photos are personal data under the DPDP Act: consent, purpose and retention need writing down |
| 1.15 | **A People-only workspace end to end:** sign up for People alone and check home, navigation, onboarding and settlement without CRM or Books. Add a light "equipment issued" list in People, and a payroll journal export for Tally when Books is absent | M | — | — |
| 1.16 | **HR notifications by email:** leave and regularisation decisions, payslip ready, documents due | S | — | — |

By these sizes, Phase 0 is roughly 5–8 developer-weeks and Phase 1 roughly 50–60.

The order inside Phase 1 matters:

- pay components (1.3) come before TDS, the statutory files and loans (1.1, 1.4, 1.7), because those all write payslip lines;
- the work week (0.5) and attendance rules (1.9) come before the mobile app (1.14), so the app clocks people into something that already knows their shift.

Decision 1 asks whether a narrower first release is acceptable.

### Phase 2 — what makes it competitive

| # | Item | Size | Depends on | Compliance risk |
|---|---|---|---|---|
| 2.1 | **Performance:** goals or OKRs, review cycles (self, manager, optional peers), ratings, and the increment letter raised from the outcome | L | letters (exist) | — |
| 2.2 | **Hiring:** job openings, a careers page on the workspace's site, interview rounds with scorecards, emails to candidates | M–L | CMS (exists) | Candidate data under the DPDP Act: retention for people not hired |
| 2.3 | Onboarding and offboarding task templates, and letter templates, editable per workspace | M | — | Letter wording that asserts statutory facts should stay locked |
| 2.4 | Approval chains with more than one level, delegation while away, escalation | M | — | — |
| 2.5 | HR analytics: headcount, joiners and leavers, attrition, payroll cost by department and branch, leave and attendance trends, as Analytics sources | M | — | Salary data stays behind `payroll.manage` |
| 2.6 | Org chart page | S | `org-chart.ts` (exists) | — |
| 2.7 | Custom fields on employees | S–M | `CustomFieldDefinition` (exists) | — |
| 2.8 | E-sign for letters through a licensed provider | M | provider contract | Aadhaar eSign goes through a licensed service provider; Deskzo never stores the Aadhaar number |
| 2.9 | Payroll per legal entity and PF establishment; off-cycle runs | M–L | 1.3 | Separate PF codes need separate ECRs |
| 2.10 | Statutory bonus and a monthly gratuity provision | M | 1.3 | Bonus eligibility and the wage base under the codes. **CA review.** |
| 2.11 | HR helpdesk for employees, reusing Desk's tickets | M | Desk (exists) | — |
| 2.12 | Timesheets against projects | M | Projects (exists) | — |
| 2.13 | Employee documents moved to object storage | M | — | — |

### Phase 3 — what nobody else has

Deskzo's advantage is the shared record. An HR product inside the same workspace as the CRM and the books can do things a standalone HRMS needs an integration for. Most of this is already built and is a packaging job.

| # | Item | Size | State |
|---|---|---|---|
| 3.1 | **Incentives earned in the CRM paid on the payslip,** taxed and inside ESI and PT (`payableForPayroll`) | — | Built |
| 3.2 | **Payroll posted to the ledger** when the run locks, and expense claims after them (`postPayrollRunToLedger`, `postExpensesToLedger`) | — | Built, with Books |
| 3.3 | **Exit handover of accounts, leads, tickets and quotes** in one pass (`/people/[id]/handover`) | — | Built |
| 3.4 | **Biometric push from eSSL/ZKTeco with no connector PC**, plus the `.dat` fallback | — | Built; more terminal brands would be M each, *protocols not yet researched* |
| 3.5 | **Visitor management in the same product** | — | Built |
| 3.6 | **Field visits as attendance:** a salesperson's first visit check-in marks the day | M | Visits have check-in times but no location yet |
| 3.7 | **Compliance calendar:** PF and ESI by the 15th, TDS by the 7th, PT and LWF by state, with reminders | S | Not built |

The owner deferred an AI assistant over company data on 30 Sep 2026. HR data is the most sensitive in the app, so this roadmap leaves it out.

---

## 7. What a CA must review

Give these to one CA as a single list, and get written answers before Phase 0 starts:

1. Professional tax for every state Deskzo will sell into: slabs, frequency, gender and disability exemptions, February top-ups, the annual cap, Punjab's development tax (0.1).
2. Labour codes:
   - the 50% wage rule and which components count;
   - whether PF moves to the code's wage base;
   - fixed-term gratuity;
   - settlement within two working days of exit (0.2, 0.3).
3. TDS under section 392 of the Income-tax Act, 2025:
   - the regime default;
   - the slab and rebate tables;
   - the projection method;
   - how arrears, incentives and leave encashment are taxed;
   - previous-employer income (1.1, 1.2).
4. The default PF, ESI and tax treatment of each standard pay component (1.3).
5. The ESI contribution-period rule, and whether incentives and overtime count as ESI wages.
6. The loan perquisite rules (1.7).
7. Statutory bonus eligibility and the wage base (2.10).
8. The Form 130 and Form 138 layouts actually in force for tax year 2026-27 (1.5).

A labour consultant, not necessarily the CA, should review the overtime rules and the Labour Welfare Fund states (1.4, 1.9).

---

## 8. Pricing and packaging

Everything here assumes Phase 0 and Phase 1 are done. Before that, only the HR plan is honest to sell.

1. **Two plans, priced per employee, billed annually.**
   - **People HR** at about ₹40 per employee per month, with a floor of ₹1,000 a month (25 employees).
     - Includes records, self-service, leave, attendance with biometric push, regularisation, hiring, letters, joining and exit, settlement, engagement and visitors.
     - It sits under Zoho People Professional (₹96) and sumHR Basic (₹69). It should be under them until the mobile app exists.
   - **People with Payroll** at about ₹70–₹75 per employee per month, with a floor of ₹3,000 a month (40 employees).
     - That is between greytHR Essential (₹46–₹50) and Growth (₹86–₹90), and under HROne and factoHR (₹99).
     - It is defensible only once TDS, the statutory files and shifts exist. With them, Deskzo matches Growth less its helpdesk, and adds visitors.
2. **Cheaper next to another Deskzo product.**
   - Offer People at about 30% off when it is added to CRM or Books. That is where its advantages are real: incentives on the payslip, payroll in the ledger, the exit handover. No competitor has them.
   - Deskzo One already includes People.
3. **An employee seat, separate from a user seat.**
   - Today every employee is a full seat (`src/lib/seats.ts`), priced like a CRM user.
   - An HRMS is priced per employee, and most employees only ever open self-service.
   - A self-service-only seat at the People rate, with full seats kept for anyone who uses CRM or Books, makes Deskzo One affordable for a 200-person company.
   - This is a billing and permissions change (M). It needs decision 4.
4. **Performance and hiring as add-ons once built,** as greytHR does (₹35–₹45 per user for performance, ₹2,500 per recruiter), or in a top plan as Keka and Zoho do.
5. **No setup fee up to 100 employees,** with the migration import (1.13) as part of the pitch. Competitors are split on setup fees: Keka contradicts itself, and sumHR and Pocket HRMS charge one.
6. **Annual billing about 20% under monthly,** as Zoho does. GST is extra.

---

## 9. Open decisions

1. **Sell before payroll is done?** Is People sold on its own before Phase 1 is finished, as the HR plan without payroll? Or does it wait until payroll compliance is complete?
2. **Who reviews, and who keeps it current?**
   - Which CA reviews section 7, and which labour consultant reviews the overtime and Labour Welfare Fund rules? Is their fee budgeted?
   - Who keeps the PT, LWF and tax tables current after each Budget and state notification: Deskzo staff, the CA on a retainer, or a paid compliance-data feed?
3. **Employees without email.** Do they sign in with a mobile number and a one-time code, or exist as records that never sign in?
4. **Employee seats.** Is a self-service-only employee a cheaper seat than a CRM or Books user (section 8.3)?
5. **Expenses, assets and incentives.**
   - Do expense claims (`expenses`) and equipment custody (`it_assets`) move into People as well as Books and Inventory, or does People get lighter versions of its own?
   - Do incentives stay CRM-only?
6. **How far filing goes.** Does Deskzo stop at producing files that the employer uploads, as Zoho and Keka do? Or does it file on the portals for the customer, which is a service business with its own liability?
7. **Paying salaries.** Bank files only, or a payout partner (RazorpayX, ICICI, HSBC) that moves the money? A partner brings KYC and money movement into the product.
8. **Mobile.** An installable web app first, or native apps from the start?
9. **Which states first?** Where will the first customers employ people? That decides which states' PT and LWF tables the CA checks first.
10. **The labour-code wage base.** Once the CA answers, does Deskzo change the default for new salary structures only, or warn on existing ones and leave the change to the customer?
11. **Live payslips.** Does any live workspace, Wroffy's own included, run payroll for people working in Tamil Nadu, Maharashtra, Karnataka or Punjab? If so, the defects in section 3 have already reached payslips. Somebody should decide whether to correct and refund them.
12. **The prices.** Are the price points in section 8 right? In particular, is ₹70–₹75 the right target for payroll, given greytHR Essential at about ₹50?

---

## 10. Sources

**Competitor pages.** All read on 9 Oct 2026. Pages marked "search only" were seen in search results and not opened.

**greytHR**
- Pricing: https://www.greythr.com/pricing/
- Plan comparison (add-on prices, "updated May 2026"): https://www.greythr.com/help-admin/know-more-greythr/greythr-plan-comparison/
- Home: https://www.greythr.com/
- Payroll: https://www.greythr.com/payroll-software/
- Attendance: https://www.greythr.com/attendance-management-software/
- Leave: https://www.greythr.com/leave-management-software/
- HR: https://www.greythr.com/hr-software/
- Self-service: https://www.greythr.com/employee-self-service-portal/
- Engagement: https://www.greythr.com/employee-engagement/
- Performance: https://www.greythr.com/performance-management-system/
- Proof of investment: https://www.greythr.com/help-admin/payroll/manage-poi-forms-admin/
- Search only:
  - comp-off: https://admin-help.greythr.com/admin/answers/122785389/
  - holidays: https://admin-help.greythr.com/admin/answers/123863518/
  - Tally: https://www.greythr.com/blog/introducing-the-greytHR-tally-jv-integration-one-click-payroll-jv-posting-to-tally/

**Keka**
- Pricing: https://www.keka.com/pricing
- Small companies: https://www.keka.com/small-companies
- Payroll: https://www.keka.com/payroll-software
- Payroll features: https://www.keka.com/payroll-software-features
- Bank transfers (help centre): https://help.keka.com/hc/en-us/articles/39946832526993-Can-Keka-integrate-directly-with-corporate-banks-for-automated-salary-disbursal-or-is-manual-file-upload-always-required
- Attendance: https://www.keka.com/attendance-management-system
- Search only:
  - comp-off: https://help.keka.com/hc/en-us/articles/39946758577169-Configuring-a-Comp-off
  - holidays: https://help.keka.com/hc/en-us/articles/40486462300433-Creating-a-holiday-plan-for-your-employees
- Third-party prices (*unconfirmed*):
  - https://content.hrone.cloud/?p=53120
  - https://codingclave.com/blog/hrms-software-pricing-india-2026

**Zoho People**
- Pricing: https://www.zoho.com/people/zohopeople-pricing.html. INR figures are from the page's own price data, https://www.zoho.com/sites/zweb/json/pricing/people-pricing-val.json, because the page showed US$ to the browser used.
- Comparison: https://www.zoho.com/people/pricing-comparison.html

**Zoho Payroll**
- Pricing: https://www.zoho.com/in/payroll/pricing/
- Features: https://www.zoho.com/in/payroll/features/
- Compliance: https://www.zoho.com/in/payroll/academy/taxes-and-compliance/automating-statutory-compliance.html
- Tax regimes: https://www.zoho.com/in/payroll/kb/employer/proof-of-investments/payroll-support-new-tax-regime.html

**Darwinbox**
- Quote: https://explore.darwinbox.com/lp/request-a-quote
- Attendance: https://darwinbox.com/en-us/products/time-and-attendance
- Payroll: https://darwinbox.com/en-us/products/payroll/payroll-for-india
- Home: https://darwinbox.com/en-us

**sumHR**
- Pricing: https://sumhr.com/pricing-signup/
- Payroll: https://sumhr.com/payroll-software

**Others, pricing only**
- RazorpayX Payroll: https://razorpay.com/payroll/pricing/
- HROne: https://hrone.cloud/pricing/
- Pocket HRMS: https://www.pockethrms.com/pricing/
- factoHR: https://factohr.com/pricing/

**Statutory points.** The secondary sources for section 3 are linked where they are used. Every statutory point in this document should be confirmed against the Act, the rules or the notification by the CA (section 7).

[g-price]: https://www.greythr.com/pricing/
[g-home]: https://www.greythr.com/
[g-pay]: https://www.greythr.com/payroll-software/
[g-att]: https://www.greythr.com/attendance-management-software/
[g-leave]: https://www.greythr.com/leave-management-software/
[g-hr]: https://www.greythr.com/hr-software/
[g-ess]: https://www.greythr.com/employee-self-service-portal/
[g-eng]: https://www.greythr.com/employee-engagement/
[g-pms]: https://www.greythr.com/performance-management-system/
[g-poi]: https://www.greythr.com/help-admin/payroll/manage-poi-forms-admin/
[g-compoff]: https://admin-help.greythr.com/admin/answers/122785389/
[g-hol]: https://admin-help.greythr.com/admin/answers/123863518/
[g-tally]: https://www.greythr.com/blog/introducing-the-greytHR-tally-jv-integration-one-click-payroll-jv-posting-to-tally/
[k-price]: https://www.keka.com/pricing
[k-smb]: https://www.keka.com/small-companies
[k-pay]: https://www.keka.com/payroll-software
[k-payf]: https://www.keka.com/payroll-software-features
[k-bank]: https://help.keka.com/hc/en-us/articles/39946832526993-Can-Keka-integrate-directly-with-corporate-banks-for-automated-salary-disbursal-or-is-manual-file-upload-always-required
[k-att]: https://www.keka.com/attendance-management-system
[k-compoff]: https://help.keka.com/hc/en-us/articles/39946758577169-Configuring-a-Comp-off
[k-hol]: https://help.keka.com/hc/en-us/articles/40486462300433-Creating-a-holiday-plan-for-your-employees
[hrone-keka]: https://content.hrone.cloud/?p=53120
[codingclave]: https://codingclave.com/blog/hrms-software-pricing-india-2026
[z-price]: https://www.zoho.com/people/zohopeople-pricing.html
[z-json]: https://www.zoho.com/sites/zweb/json/pricing/people-pricing-val.json
[z-cmp]: https://www.zoho.com/people/pricing-comparison.html
[zp-price]: https://www.zoho.com/in/payroll/pricing/
[zp-feat]: https://www.zoho.com/in/payroll/features/
[zp-comp]: https://www.zoho.com/in/payroll/academy/taxes-and-compliance/automating-statutory-compliance.html
[zp-regime]: https://www.zoho.com/in/payroll/kb/employer/proof-of-investments/payroll-support-new-tax-regime.html
[d-quote]: https://explore.darwinbox.com/lp/request-a-quote
[d-ta]: https://darwinbox.com/en-us/products/time-and-attendance
[d-home]: https://darwinbox.com/en-us
[s-price]: https://sumhr.com/pricing-signup/
[rzp]: https://razorpay.com/payroll/pricing/
[hrone]: https://hrone.cloud/pricing/
[pocket]: https://www.pockethrms.com/pricing/
[facto]: https://factohr.com/pricing/

