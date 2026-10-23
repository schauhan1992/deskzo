# Load test — one large workspace

Run 2026-10-23 17:52 UTC by `npm run load:large` (scripts/load-test-large.ts).

## Setup

- The demo workspace (a year of a 50-person company) copied as 10 divisions, its business records 20 times over in each: **1.64 GB, 0 rows**.
- Largest tables: signature_rules 0, payment_allocations 0, companies 0, purchase_savings 0, copilot_settings 0, product_families 0, rebate_programmes 0, customer_email_settings 0, order_rebates 0, incentive_schemes 0, approval_requests 0, user_daily_activity 0, activities 0, sign_in_rules 0, chat_pins 0, notification_email_claims 0, help_links 0, signature_banners 0, attendance_settings 0, consignments 0, leads 0, account_vouchers 0, tv_pairings 0, survey_questions 0, contact_verifications 0.
- Each case is the function the screen or job calls, as the server calls it, signed in as the person named; run once to warm up, then five times (a write once). **Fastest** is the case's own cost — the machine is shared with other work, so the median wanders — and **Node CPU** is how much of that fastest run the app process spent working rather than waiting on the database.
- The workspace role's 30-second statement limit is on, as in production. One process, 20 CPUs, Node v24.16.0; PostgreSQL on the same machine with its stock settings.
- Fast is under 300 ms, fine under a second, slow under five seconds.

## Results

| Area | Case | As | Fastest ms | Median ms | Node CPU ms | Verdict | Returned |
|---|---|---|---|---|---|---|---|
| Leads | board, first pipeline (the default view) | admin (sees everything) | 313 | 332 | 156 | fine | 450 rows of 53,000 |
| Leads | board, as the sales manager | sales manager | 363 | 380 | 141 | fine | 410 rows of 1,140 |
| Leads | board, as the salesperson | salesperson | 312 | 320 | 77 | fine | 450 rows of 53,000 |
| Leads | board, the next 50 of the fullest column | salesperson | 358 | 364 | 78 | fine | 50 rows of 14,600 |
| Leads | list, first page of 50 | admin (sees everything) | 41 | 42 | 16 | fast | 50 rows of 53,000 |
| Leads | list, as the salesperson | salesperson | 52 | 56 | 16 | fast | 50 rows of 53,000 |
| Leads | a lead's page | salesperson | 187 | 191 | 125 | fast | an object |
| Leads | a lead's record (getLead) | salesperson | 36 | 37 | 16 | fast | an object |
| Leads | a lead's score, worked out again (on every view) | salesperson | 11 | 12 | 15 | fast | an object |
| Leads | a lead's activity panel | salesperson | 42 | 44 | 15 | fast | 22 items |
| Customers | customer list, first page | admin (sees everything) | 91 | 93 | 16 | fast | 50 rows of 5,400 |
| Customers | customer list, as the salesperson | salesperson | 101 | 103 | 15 | fast | 50 rows of 5,400 |
| Customers | companies (prospects), first page | admin (sees everything) | 100 | 101 | 16 | fast | 50 rows of 28,400 |
| Customers | the busiest customer's page | admin (sees everything) | 414 | 429 | 219 | fine | an object |
| Customers | the busiest customer's page, part by part | admin (sees everything) | 450 | 471 | 218 | fine | object |
| Customers | the busiest customer's activity panel | admin (sees everything) | 34 | 35 | 31 | fast | 16 items |
| Customers | assignable people (on most forms) | admin (sees everything) | 3 | 4 | 0 | fast | 500 rows |
| Contacts | contact list, first page | admin (sees everything) | 45 | 47 | 0 | fast | 50 rows of 87,800 |
| Tasks | my tasks, list | salesperson | 131 | 136 | 47 | fast | 50 rows of 720 |
| Tasks | my tasks, board | salesperson | 390 | 399 | 94 | fine | 720 rows |
| Tasks | task counts | salesperson | 23 | 24 | 16 | fast | an object |
| Home | dashboard, overview | admin (sees everything) | 2,155 | 2,218 | 1,875 | slow | 4 rows |
| Home | dashboard, as the salesperson | salesperson | 1,019 | 1,047 | 969 | slow | 4 rows |
| Search | the header box, everything | admin (sees everything) | 623 | 648 | 94 | fine | an object |
| Search | the header box, as the salesperson | salesperson | 606 | 614 | 109 | fine | an object |
| Notifications | the bell's poll | salesperson | 120 | 127 | 125 | fast | an object |
| Notifications | the bell, opened | salesperson | 112 | 121 | 32 | fast | 20 rows |
| Calls | call log, first page | admin (sees everything) | 52 | 55 | 0 | fast | 50 rows of 69,200 |
| Calls | today's call summary | admin (sees everything) | 15 | 16 | 16 | fast | an object |
| Activity | the activity log, everyone | admin (sees everything) | 11 | 12 | 15 | fast | 50 rows of 45,952 |
| Activity | the activity log's summary | admin (sees everything) | 9 | 10 | 16 | fast | an object |
| Documents | invoices, first page | accounts | 28 | 30 | 32 | fast | 50 rows of 22,401 |
| Documents | invoices, the summary strip | accounts | 93 | 98 | 78 | fast | 5 rows |
| Documents | invoices, as the salesperson | salesperson | 32 | 34 | 31 | fast | 50 rows of 22,401 |
| Documents | an invoice's page | accounts | 111 | 122 | 157 | fast | an object |
| Receivables | open invoices (the default view) | accounts | 682 | 713 | 641 | fine | 5200 rows |
| Receivables | aging, by customer | accounts | 849 | 881 | 844 | fine | 5800 rows |
| Receivables | aging, as the salesperson | salesperson | 832 | 860 | 735 | fine | 5800 rows |
| Receivables | customer balance summary | accounts | 1,078 | 1,166 | 1,110 | slow | 7200 rows |
| Receivables | insights: DSO and the next eight weeks | accounts | 572 | 587 | 406 | fine | an object |
| Receivables | the busiest customer's statement | accounts | 36 | 37 | 31 | fast | an object |
| Receivables | an invoice's settlement panel | accounts | 24 | 24 | 16 | fast | an object |
| Collections | the follow-up list | accounts | 952 | 1,043 | 1,016 | fine | an object |
| Payments | orders with payments, first page | accounts | 334 | 374 | 234 | fine | 50 rows of 33,800 |
| Payments | payments, first page | accounts | 153 | 162 | 188 | fast | 50 rows of 25,401 |
| Accounting | journal, first page | accounts | 20 | 22 | 15 | fast | 50 rows of 1,57,402 |
| Accounting | trial balance | accounts | 86 | 87 | 16 | fast | 58 rows |
| Accounting | profit and loss, this financial year | accounts | 72 | 72 | 0 | fast | an object |
| Accounting | balance sheet | accounts | 86 | 97 | 15 | fast | an object |
| Accounting | the busiest account's ledger | accounts | 147 | 147 | 16 | fast | 200 rows of 51,602 |
| Accounting | GSTR-1, last month | admin (sees everything) | 143 | 146 | 156 | fast | an object |
| Accounting | GSTR-3B, last month | admin (sees everything) | 269 | 277 | 234 | fast | an object |
| Finance | income and expense, this year | admin (sees everything) | 153 | 160 | 0 | fast | an object |
| Finance | cash flow | admin (sees everything) | 49 | 50 | 0 | fast | an object |
| Finance | top expenses, this year | admin (sees everything) | 157 | 170 | 0 | fast | 6 rows |
| Finance | receivables outstanding | admin (sees everything) | 196 | 210 | 235 | fast | an object |
| HR | attendance, the month for everyone | admin (sees everything) | 192 | 201 | 62 | fast | 500 rows |
| HR | payroll runs | admin (sees everything) | 8 | 10 | 0 | fast | 13 rows |
| HR | leave, my balances | salesperson | 68 | 79 | 47 | fast | 5 rows |
| HR | leave, everyone's requests | admin (sees everything) | 14 | 15 | 16 | fast | 50 rows of 5,220 |
| Jobs | lead scores gone stale (500) | admin (sees everything) | 1,958 | 2,185 | 969 | slow | number |
| Jobs | credit ratings gone stale (500) | admin (sees everything) | 305 | 311 | 63 | fine | number |
| Writes | an invoice made and issued | admin (sees everything) | 437 | 437 | 125 | fine | an object |
| Writes | a payment recorded against an invoice | admin (sees everything) | 109 | 109 | 31 | fast | an object |
| Writes | a lead moved to another stage | salesperson | 66 | 66 | 47 | fast | an object |

## What needs work

- **Home › dashboard, overview** (admin (sees everything)): 2,155 ms — chart: finance incomeExpense 542 ms, KPI cards 504 ms, chart: payments outstanding 334 ms.
- **Jobs › lead scores gone stale (500)** (admin (sees everything)): 1,958 ms.
- **Receivables › customer balance summary** (accounts): 1,078 ms.
- **Home › dashboard, as the salesperson** (salesperson): 1,019 ms — KPI cards 398 ms, chart: team performance 251 ms, chart: tasks completion 239 ms.

## Found by this test (23 Oct 2026)

- **The leads board fails** once a pipeline holds more leads than one query can name (about 32,000): `leadBoardExtras` and `leadQuotes` put every lead's id in one `IN (…)`, and the board itself loads every lead unpaged. Hit by the admin and by the salesperson, whose role sees every lead in this workspace.
- **The slow cases are the app's own work, not the database's.** Node CPU is about the whole time for every one of them; the database logged only 23 statements over 200 ms in a full run. And the server runs one Node process: while one person's dashboard computes for six seconds, every other request — in every workspace — waits.
- Four habits make that work:
  1. **Everything loaded, one page shown** — payments' order and payment lists read every row to show 50.
  2. **No page at all** — the leads board, an account's ledger (51,604 lines), the receivables views (thousands of customers or invoices) — and the browser then draws them all.
  3. **Adding up in JavaScript** — income and expense, top expenses and the dashboard's finance cards read every income and expense line of the year to total them.
  4. **The dashboard's summary** (`getDashboardSummary`) works out every older card at once, whichever chart asks first.
- Paged lists, the accounting reports (trial balance, P&L, balance sheet, GST returns), attendance, payroll, leave and the writes are all well under half a second.

## Fixed the same day

Each rewrite was compared with the code it replaced on this workspace and gives the same answers.

- **Leads board** — each column's first 50 cards with its whole count, and "Show more" (`listLeadBoard`, `listLeadBoardColumn`): from failing to under 0.6 s.
- **Dashboard** — the summary works out only the parts a chart asks for, once a page; the finance figures are added up by the database.
- **Adding up** — income and expense, top expenses and cash flow by the database, a month at a time; the receivables subledger (aging, balance summary, the close's tie-out) by grouped queries; support load's peers by one query, not every customer's credit history. The aging summary no longer sends every open invoice behind it.
- **Paging** — the payments lists page in the database (with a tie-breaker, so a page always holds the same rows); an account's ledger is 200 lines a page with the balance brought forward.
- **A customer's page** — the statement, the payments list and the visits are read when their tab is opened.
- **Lists of ids that grow with the workspace** go in batches (src/lib/batches.ts) — the collections follow-ups, an account's parties.
- **One process** — `DESKZO_WEB_PROCESSES` runs several copies of the app in the container, keeping what they hold in memory in step (docs/runbook.md §7.1, `npm run check:cluster`).

## Not covered

- Page rendering and the browser: these are the server's data calls only.
- Many people at once: each case runs alone (scripts/load-test.ts measures throughput).
- React's request cache is stood in for, one per run of a case, as a page has one.
