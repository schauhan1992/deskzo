# Deskzo pricing for India at launch

The owner asked on 11 Oct 2026: *"research all competitor pricing and feasibility for pricing of our modules, features, USP — we will be selling in India to start with. Suggest and set the pricing; later we will change it from the console."*

This page covers:
- the recommendation and the reasoning behind it;
- the competitors' Indian prices it was set against (all read on 11 Oct 2026);
- what it costs us to sell;
- what is still open.

**Where the prices live:** the figures are in `src/lib/platform/price-book.ts`. `npm run platform:plans -- prices` shows what it would set; `-- --apply` sets it. After that, prices are changed in the console (Plans › a plan › Prices), as before.

## The recommendation

**Each product and Deskzo One is priced per person per month.**
- **Before 18% GST**, which Indian businesses claim back.
- **A year costs ten months**: two months free, about 17% off. Zoho Books, Zoho Inventory, Zoho Billing, myBillBook and Freshworks all give 17–20%.
- **No minimum** and **no free plan**. Every new workspace still gets its free trial (14 days, set in the console).

| Product | A month, per person | A year, per person (a month) | Set against (yearly-billed / monthly-billed, a user a month) |
|---|---|---|---|
| **Deskzo One** — every product | **₹1,499** | ₹14,990 (₹1,249) | Zoho One All-Employee ₹1,250 / ₹2,500 (every employee must be licensed); Flexible User ₹3,500 / ₹4,000 |
| Deskzo CRM | ₹799 | ₹7,990 (₹666) | Zoho CRM Standard ₹800 / ₹1,300; Freshsales Growth ₹749 / ₹899; TeleCRM ₹799 |
| Deskzo Books | ₹349 | ₹3,490 (₹291) | Zoho Books Standard ₹749 an organisation for 3 users (₹250 each), Professional ₹1,499 for 5; myBillBook ₹291–333 |
| Deskzo People | ₹99 | ₹990 (₹83) | greytHR Growth ₹85 an employee on a ₹4,495 base for 50; Zoho People ₹48–144 plus Zoho Payroll ₹40–80; Keka ₹90–150 |
| Deskzo Desk | ₹599 | ₹5,990 (₹499) | Zoho Desk Express ₹420 / ₹540, Standard ₹800 / ₹1,300; Freshdesk Growth ₹1,499 / ₹1,799 |
| Deskzo Inventory | ₹349 | ₹3,490 (₹291) | Zoho Inventory Standard ₹999 an organisation for 3 users (₹333 each) |
| Deskzo Subscriptions | ₹349 | ₹3,490 (₹291) | Zoho Billing Premium ₹2,999 for 10 users (₹300 each) — its ₹1,249 Standard has no recurring billing |
| Deskzo Projects | ₹299 | ₹2,990 (₹249) | Zoho Projects Premium ₹280 / ₹350 |
| Deskzo Campaigns | ₹499 | ₹4,990 (₹416) | Zoho Marketing Automation ₹855–2,880 for 1k–10k contacts; Zoho Campaigns ₹180–2,205 for 500–10k |
| Deskzo Analytics | ₹249 | ₹2,490 (₹208) | Zoho Analytics ₹960 an organisation for 2 users (₹480 each), extra users ₹200 |
| Deskzo Vault | ₹99 | ₹990 (₹83) | Zoho Vault Standard ₹54, Professional ₹248 (team sharing); Bitwarden Teams US$4 |
| Deskzo Cards | ₹99 | ₹990 (₹83) | Blinq Business, HiHello and Wave US$5 a person; Indian makers sell a card (₹999–1,699) and a profile at ₹199 a year |
| Deskzo Signatures | ₹59 | ₹590 (₹49) | Exclaimer US$0.90–1.75, CodeTwo US$1.22, Letsignit US$2 a person |

The add-ons are priced for the whole workspace, not per person:

| Add-on | A month | A year | Note |
|---|---|---|---|
| Revenue & Close (with Books; included in One) | ₹2,499 | ₹24,990 | Ind AS 115 revenue recognition and the month-end close. No Indian SMB tool sells this. |
| AI Copilot | ₹499 | ₹4,990 | A million tokens a month on the workspace's **own** AI key — the provider bills its use, not us. Competitors charge ₹1,495–2,399 a person for copilots (Microsoft, Freshworks) because they pay for the model. |
| More people | off sale | | Every product is already priced per person. |

### Why these numbers

- **Deskzo One is the anchor**, the way Adobe uses Creative Cloud.
  - Paid yearly, it is Zoho One All-Employee's ₹1,250 a month, without Zoho's rule that every employee on the payroll must be licensed.
  - Paid monthly it is ₹1,499 against Zoho's ₹2,500.
  - It costs less than any three products together. CRM + Desk + Campaigns is ₹1,897, and all thirteen products come to ₹3,848 a person.
  - The product pages and pricing table already show One beside each product.
- **Single products sit at or under their Zoho or Freshworks equivalent.** At launch, a new name has to be the easy choice. Each also takes away one of the usual limits:
  - No invoice, order or contact cap. Zoho Books caps invoices, Zoho Inventory caps orders, and marketing tools charge by contact.
  - No 50-employee floor for HR. greytHR, Pocket HRMS, factoHR, HROne and Qandle all start at 50.
  - Payroll, attendance, hiring and visitors in one product. Indian HR tools usually hold back attendance and recruitment for higher tiers.
- **₹99 a person** for People, Vault and Cards, and **₹59** for Signatures, are the land products. They are cheap enough to try alone, and each leads to the rest.
- **Per person, not per organisation.**
  - Indian accounting and inventory tools mostly price per organisation with users included. CRM, helpdesk and project tools price per user. HR tools price per employee.
  - One unit across every product is easy to explain ("₹X a person a month") and is what billing already does.
  - For a 1–3 person business it lands at or below Zoho's per-organisation price.

## What it costs us to sell, and whether it holds up

- **Payment:** Razorpay takes about 2% plus GST on it, **≈2.36% of each charge** (cards, UPI, netbanking). International cards are about 3.5%. New merchants get 0% for 90 days or ₹5 lakh, whichever comes first.
- **GST** is collected and paid on, not kept.
  - Prices are listed before GST, and Razorpay plans are made at the price plus 18% (`src/lib/billing/platform-gst.ts`).
  - Our invoice records that 18% as the GST, **not** Razorpay's fee tax. Before this change, a ₹999 price would have been charged as ₹999 with GST inside it, leaving us about ₹847.
- **Running cost per person is small.** Each workspace is a database on our own server. A person adds rows, not machines. The AI copilot runs on the customer's own key. Mail goes through each workspace's own accounts or the platform's mail provider. At these prices, the ≈2.4% payment fee is the largest cost that grows with each person.
- **Yearly up front** brings in cash early; two months free is the usual incentive.
- **Example customers, per month before GST:**
  - A 5-person firm on Books pays ₹1,745 monthly, or ₹1,454 paid yearly. Zoho Books Professional for 5 users is ₹1,499 yearly.
  - A 100-employee company on People pays ₹9,900 monthly, or ₹8,250 yearly, with nothing upfront and no 50-employee minimum.
  - A 10-person sales team on One pays ₹14,990 monthly, or ₹12,492 yearly.

## Open questions for the owner

1. **Per-product licences.** A workspace's user limit is the people bought across all its plans. Users aren't tied to one product, so a workspace that buys People for 100 employees and CRM for 10 can let all 110 people use CRM.
   - This doesn't matter for a single-product workspace or for Deskzo One.
   - For mixed workspaces the fix is per-product licences: assign each person the products they use, like Zoho's per-app users, and have module access check it.
   - Recommended before selling product combinations widely.
2. **GST registration.** The 18% assumes the selling company is GST-registered and its invoices carry its GSTIN and the SAC (9983). Your CA should confirm the rate and the invoice format.
3. **A free plan.** Zoho Books is free under ₹25 lakh revenue, Zoho Payroll for up to 10 employees, and HubSpot and Zoho CRM for 2–3 users. Billing can't sell a ₹0 plan yet (Razorpay plans need an amount). The trial stands in for now.
4. **Razorpay test, then live.** Prices are made at Razorpay, so do it with **test keys** first and check one checkout end to end. Billing has only ever been tested against fake gateways (see the billing memory). When the live keys go in, run `-- prices --apply --remake` once, so every price is made again on the live account.
5. **Review after the first customers.** These are launch prices. Watch which products people buy first and where trials stall, then change prices in the console. A price changed there is replaced, never edited, so whoever already pays keeps their price.

## Setting it on live

```bash
npm run platform:plans -- products
npm run platform:plans -- prices
npm run platform:plans -- prices --apply
```

1. Deploy, so both control migrations are applied (`20261028100000_signup_product`, `20261029100000_site_lead_product`).
2. Run `npm run platform:plans -- products`. It makes the Deskzo Cards and Deskzo Signatures plans if they're missing.
3. Enter Razorpay's **test** keys in the console under Settings › Billing.
4. Run `npm run platform:plans -- prices` and read the dry run.
5. Run `npm run platform:plans -- prices --apply`.
6. Check the pricing page and the Books page. Start a checkout from a test workspace.
7. Put in the live keys, then run `npm run platform:plans -- prices --apply --remake`.

## The research (read 11 Oct 2026)

INR, before 18% GST, a user (or employee) a month: yearly-billed / monthly-billed. "UNVERIFIED" means it came only from a third party.

**CRM.**
- Zoho CRM: Free (3 users); Standard ₹800 / 1,300; Professional ₹1,400 / 2,100; Enterprise ₹2,400 / 3,000; Ultimate ₹2,600 / 3,200.
- Bigin: Express ₹400 / 550; Premier ₹720 / 900.
- Freshsales: Growth ₹749 / 899; Pro ₹3,239 / 3,889; Enterprise ₹4,899 / 5,879. Freddy Copilot is ₹2,399 a user.
- HubSpot Starter: ₹585 / 835 on offer (list ₹1,670). Sales Hub Professional ₹7,497 plus ₹1.25 lakh onboarding.
- TeleCRM ₹799 (₹1,099 quarterly).
- Kylas: ₹12,999 a month flat for unlimited users.
- Bitrix24 (per organisation): ₹1,910 for 5 users, ₹4,790 for 50.
- Salesforce, Pipedrive and LeadSquared: USD only ($25–550, $14–69, $40–60).

**Helpdesk.**
- Zoho Desk: Express ₹420 / 540; Standard ₹800 / 1,300; Professional ₹1,400 / 2,100; Enterprise ₹2,400 / 3,200.
- Freshdesk: Growth ₹1,499 / 1,799; Pro ₹4,499 / 5,399; Enterprise ₹7,099 / 8,509.
- Zendesk: USD $19–115.

**Marketing.**
- Zoho Campaigns: ₹180 (500 contacts) to ₹2,205 (10k).
- Zoho Marketing Automation: ₹855 (1k) to ₹2,880 (10k).
- Mailchimp Essentials: ₹1,265.
- Brevo Starter: ₹563 / 625.
- HubSpot Marketing Professional: ₹66,697 a month.

**Accounting** (per organisation unless said).
- Zoho Books: Free (under ₹25 lakh revenue); Standard ₹749 / 899 (3 users); Professional ₹1,499 / 1,799 (5); Premium ₹2,999 / 3,599 (10); Elite ₹4,999; Ultimate ₹7,999. Extra users ₹150.
- TallyPrime: Silver ₹22,500 once plus ₹4,500 a year; Gold ₹67,500 plus ₹13,500. Rental ₹750 or ₹2,250 a month; cloud access ₹450–600 a user.
- Vyapar: ₹3,399–11,999 a year.
- BUSY: ₹5,000–50,000 a year.
- Marg: ₹5,550–26,000 once.
- myBillBook: ₹3,490–6,840 a year.
- Odoo: Standard ₹580–760 a user (UNVERIFIED).

**E-invoice / e-way APIs.** The government IRN is free. GSP APIs cost 18–50 paise a document, with yearly minimums (GSTZen).

**Inventory.**
- Zoho Inventory: Standard ₹999 / 1,199 (3 users, 500 orders); Premium ₹2,299; Plus ₹4,999; Enterprise ₹7,499. Extra users ₹399.

**Subscription billing.**
- Zoho Billing: Standard ₹1,249 / 1,499 (one-time billing only); Premium ₹2,999 / 3,499.
- Chargebee: USD, a share of what is billed.

**HR and payroll** (an employee).
- greytHR: Essential ₹2,495 for 50 plus ₹45; Growth ₹4,495 plus ₹85.
- Keka: ₹90–150 (from its page's hidden markup), with a ₹9,999-plus base (UNVERIFIED).
- Zoho People: ₹48–192 / ₹60–240, minimum 5.
- Zoho Payroll: free to 10; ₹1,000 for 25 plus ₹40, up to ₹4,000 plus ₹80.
- RazorpayX Payroll: ₹3,499 (up to 20) plus ₹150.
- HROne: ₹4,950 for 50 plus ₹99.
- sumHR: ₹49–119.
- factoHR: ₹4,999 for 50 plus ₹99.
- Pocket HRMS: ₹2,995 for 50 plus ₹60.
- Qandle: ₹2,450 plus ₹49.

  Statutory compliance (PF, ESI, PT, TDS) is in the base tier everywhere. Attendance and recruitment are what gets held back.

**Visitor management.** Vizitor: ₹1,600–3,200 a location a month.

**Projects.**
- Zoho Projects: Premium ₹280 / 350; Enterprise ₹630 / 700.
- Asana $10.99–24.99; monday $9–19; ClickUp $8–17; Jira about $7.50–15.40; Wrike $10–25.

**Suites.**
- Zoho One: All-Employee ₹1,250 / 2,500; Flexible ₹3,500 / 4,000.
- Odoo Custom: ₹1,080–1,350 (UNVERIFIED).
- Bitrix24: ₹1,910–19,190 an organisation.

**What Indian SMBs already pay for office software** (a user a month).
- Microsoft 365: Basic ₹170, Standard ₹860, Premium ₹1,830.
- Google Workspace: Starter about ₹270 (UNVERIFIED).

**BI.**
- Zoho Analytics: ₹960–15,850 an organisation (2–50 users).
- Power BI Pro: ₹1,165 a user.

**Password managers.**
- Zoho Vault: Standard ₹54 / 60; Professional ₹248 / 275; Enterprise ₹432.
- Bitwarden US$4–6; 1Password US$2.49–8.99; Keeper US$2–6.

**Digital cards.**
- Blinq US$4.99 / 6.99 (plus US$9.99 a captured lead); HiHello US$5 / 6; Mobilo US$4–5.
- In India: TapMo ₹999 once; Beeps ₹199 a year a profile.

**Email signatures.**
- Exclaimer US$0.90–1.75; CodeTwo US$0.73–1.22; Newoldstamp US$1.8; Letsignit US$2; WiseStamp US$19–189 a month plus US$1 an employee.

**AI add-ons.**
- Microsoft 365 Copilot Business ₹1,745 (₹1,496 on offer).
- Freshworks Freddy Copilot ₹2,399 a user.
- Salesforce Agentforce US$125.
- HubSpot and Zoho include AI and meter it in credits or tokens.

**Razorpay.** 2% plus GST (2.36%) domestic; up to 3% international. Subscriptions about 0.9% plus the platform fee.

### Sources (all read 11 Oct 2026)

- **Zoho:** zoho.com/in/books/pricing, /in/inventory/pricing, /in/billing/pricing, /in/payroll/pricing, /people, /crm, /desk, /projects, /campaigns, /marketingautomation, /analytics, /vault, /one. The INR figures come from each page's `zohowebstatic.com/sites/zweb/json/pricing/*-pricing-val.json`.
- **Freshworks:** freshworks.com/crm/pricing and /freshdesk/pricing (INR fields in each page).
- **CRM and sales:** hubspot.in/pricing/sales and /marketing; kylas.io/pricing; telecrm.in/pricing; bitrix24.in/prices.
- **Accounting:** tallysolutions.com/buy-tally, /renew-tss; vyaparapp.in/pricing; busy.in/pricing; margcompusoft.com/marg-price-list.html; mybillbook.in/pricing-plans; gstzen.in.
- **HR and payroll:** greythr.com/pricing; keka.com/pricing; razorpay.com/payroll/pricing; hrone.cloud/pricing; sumhr.com; factohr.com/plans; pockethrms.com/pricing; qandle.com/transparent-pricing.html.
- **Visitor management:** vizitorapp.com/pricing.
- **Microsoft:** microsoft.com/en-in (Microsoft 365, Copilot, Power BI).
- **Cards and signatures:** blinq.me/pricing; hihello.com/pricing; exclaimer.com/pricing; codetwo.com/email-signatures/pricing; letsignit.com/pricing.
- **Razorpay:** razorpay.com/pricing and /subscriptions.
