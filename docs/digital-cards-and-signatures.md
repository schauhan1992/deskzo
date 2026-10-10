# Digital cards, event lead capture and email signatures — proposal

**Status:** owner's decisions taken 10 Oct 2026 (section 7). Phases 0 and 1 built 11 Oct 2026 — see section 8.
**Asked for:** a Blinq-style digital card that HR or an admin switches on per person; Blinq's event lead
capture; and team email signatures — a free public generator that leads to a paid module syncing
signatures into Microsoft 365, Google Workspace and Zoho Mail mailboxes. Both products are sold on their
own **and** included in One.
**Research:** replica/recon.md and replica/features.csv (Blinq, from ~75 public pages), and a second pass
over Exclaimer, CodeTwo, WiseStamp, Letsignit, NEWOLDSTAMP, HubSpot's generator and the three
providers' official docs. Sources are linked there.

**Clean room.** Blinq's terms forbid using its platform to build a competing product or for competitive
analysis. Everything here comes from public pages and describes what the product does; Deskzo's
screens, words and assets are its own. Nobody signs up to Blinq to study it.

---

## 1. The recommendation in one page

**Two products, one directory underneath.**

- **Deskzo Cards** — a digital business card for each person a company switches on, with the event lead
  capture that makes cards pay for themselves. The person you meet saves the card in one tap, with no
  app and nothing asked of them; if they choose to leave their details, they land as a lead.
- **Deskzo Signatures** — one signature design for the whole company, filled in from each person's
  record and pushed into their mailbox. A free generator on deskzo.com is the way in.

Both read the same thing: the people in the workspace, their title, work phone, photo and branch, and
the company's brand. That is why they belong in one workspace rather than as two apps — and why a
customer who buys only one of them still needs a small staff directory (section 2.3).

**Where Deskzo beats Blinq**, from what Blinq's users and its own docs say:
1. **The lead lands in your CRM, not in someone else's app.** Blinq syncs to Salesforce or HubSpot after
   the fact; in Deskzo the card *is* in the CRM. One less integration, no per-lead charge (Blinq charges
   $9.99 a lead).
2. **Saving a card never asks for anything.** Blinq's most common complaint is recipients thinking they
   must download the app or give their details to get the card.
3. **A leaver's contacts go to someone.** Blinq keeps them with the company but has no documented way to
   hand them to another rep. Deskzo already reassigns a leaver's accounts on exit.
4. **The card follows HR.** The day someone's exit is recorded, their card goes dark — no separate
   admin step, no SCIM to buy.
5. **Signatures and cards are one design.** The signature carries the card's link and QR, from the
   same template.

**What not to copy:** Blinq's app-to-app network, native widgets and watch apps (Deskzo is a web app),
paid contact enrichment from data brokers, Cvent badge scanning and an NFC hardware shop.

---

## 2. Products and plans

### 2.1 Packaging

| Product | Sold alone | In One | Billed per |
| --- | --- | --- | --- |
| Deskzo Cards (cards + event lead capture) | yes | yes | card switched on |
| Deskzo Signatures | yes | yes | mailbox with a signature |
| Free signature generator | public, no sign-up | — | — |

Both register in `src/lib/products.ts` like the other products — names, modules and where they are
sold, **never a price**.

**Prices are run from the platform console, not the code** (owner, 10 Oct 2026). This is how Deskzo
already works:
- Each product is a plan in the control plane (`Plan`, `PlanModule`), with its prices in `PlanPrice`,
  per gateway, currency and interval, per seat or flat.
- Console → Plans creates the plan and adds each price at Stripe or Razorpay first, then records it
  (`src/lib/billing/prices.ts`). A price is never edited; a new one replaces it on offer and the old
  one stays on the subscriptions already paying it.
- The website's pricing table (the CMS `pricing-table` block) reads the live offer for the visitor's
  country (`src/lib/platform/public-offer.ts`), so a price set in the console shows on the site at once.
- **Deskzo One** is a plan with "all modules", so Cards and Signatures are part of it the moment the
  modules exist — nothing to configure.

What the build adds: two product entries and their modules, two plans (`deskzo-cards`,
`deskzo-signatures`) created the way the others were, and a product page each on the site. The prices
below are only a starting suggestion for whoever enters them in the console.

### 2.2 Price — a suggestion, the owner decides

What the market charges (USD, per person per month):

| | Blinq Business | Exclaimer | CodeTwo | WiseStamp | Letsignit |
| --- | --- | --- | --- | --- | --- |
| Cards | $4.99 annual / $6.99 monthly, min 5 | — | — | — | — |
| Signatures | in the card price | $0.90–1.75, min 10 | $0.73–1.36, min 10 | $1 + $19–189 base | $2 |

Suggested starting prices, for India, to enter in Console → Plans:
- **Cards: ₹149 per card per month** billed yearly (about $1.80) — under half Blinq's price, no per-lead
  charge, minimum 3.
- **Signatures: ₹49 per mailbox per month** billed yearly (about $0.60) — under CodeTwo and Exclaimer.
- **Cards + Signatures together: ₹169.**
- In One: both, for every seat.

### 2.3 The directory a standalone buyer needs

Cards and signatures fill themselves from a person's record: name, title, work phone, email, photo,
branch address. Today those live partly in core (`User.name`, `User.phone`, the photo) and partly in
People (`EmployeeProfile.designation`). A customer who buys only Cards must not need People.

Proposal:
- Make the few **work-profile fields** — title, department, work phone, photo, branch — editable from
  Staff & roles without the HR module. People keeps everything else (salary, documents, leave).
- Add **"Fill from Microsoft 365 / Google Workspace / Zoho"**: read title, department, phones and photo
  from the directory the workspace already connects for sign-in, so a 200-person company doesn't type
  200 profiles. (Microsoft Graph `User.Read.All` and `ProfilePhoto.Read.All`; Google Admin SDK
  `admin.directory.user.readonly`; Zoho Directory `ZohoDirectory.Users.READ`.)

---

## 3. Deskzo Cards

### 3.1 Who gets a card

The owner's rule: HR or an admin decides.

- **New permissions**:
  - `cards.use` — "Have a digital card". Off by default for every role; switched on per role or per person.
  - `cards.manage` — "Manage digital cards": templates, issuing cards, switching them off, everyone's
    analytics. Default: Admin, HR, HR head, Management.
  - `cards.viewLeads` — see the leads every card collected, not just your own. Default: Management, Sales manager.
- **Issuing:** Staff & roles gets a "Digital card" column and a bulk action — issue cards to a
  department, a branch or a role in one go, from a chosen template.
- **Seats:** each issued card takes one Cards seat; switching a card off frees it.

### 3.2 Templates and locked fields

A template is the company's card design: logo, cover, colours, layout, which fields appear and in what
order, and the QR's logo.

- Each field is **shared** (one value for everyone — the company website, the head-office phone),
  **from the record** (title, work phone, email, photo — kept in step automatically), or
  **the person's own** (LinkedIn, a WhatsApp number).
- Each field can be **locked**, so a person can't change it, or left open.
- Changing a template shows **what changes and how many cards** before it saves, and optionally tells
  the cardholders.
- Several templates per company: one per brand, branch or department.

### 3.3 The card itself

- Photo, name, title, company, logo, cover, and contact fields (phones, emails, address, website,
  LinkedIn, WhatsApp, a calendar link) — several of each, labelled, in any order.
- **Privacy by default:** a personal phone or personal email never appears unless the person adds it
  themselves. `User.phone` already exists precisely so a work number goes on customer-facing paper.
- One card per person to start; a second (for example "Events") later.

### 3.4 Sharing

| Way | How |
| --- | --- |
| QR code | on a mobile-first "My card" page in Deskzo; add it to the home screen to open it in one tap |
| Link | `https://<workspace>.deskzo.com/c/<name>` — the same for life of the card |
| Email signature | the card's link and QR, from Deskzo Signatures |
| NFC | write the card's link to any NFC card, sticker or keyring — nothing to sell, no pairing app |
| Apple and Google Wallet | phase 2 — needs an Apple pass certificate and a Google Wallet issuer account |
| Virtual background | phase 2 — a background image with the QR, for video calls |

### 3.5 What the person you meet sees

A public page on the workspace's own address — no sign-in, no app:

1. The card, with **Save contact** first and biggest. It saves a vCard: one tap on iPhone, the usual
   download on Android.
2. Below it, optional: **"Share your details with <name>"** — name and an email or phone, plus up to
   five questions the company chose. Never required to save the card.
3. Their details become a **lead** (source "Digital card") owned by the cardholder, with the card and
   the event it came from. In a workspace without the CRM, they go to a simple **Card contacts** list
   instead, which can be exported.

The page is the riskiest part and is built as one: fast, no tracking scripts, a honeypot and rate
limit on the form, nothing on it but what the card shows, `noindex`.

### 3.6 What the cardholder and their manager see

- **My card:** views, saves, link taps and leads, this week and all time.
- **My card contacts:** everyone who shared back, with notes and a follow-up — as leads, if the CRM is on.
- **Company view** (`cards.manage`): every card, its owner, views, saves and leads, a leaderboard.

### 3.7 When someone leaves

Recording their exit switches the card off on their last working day: the link shows "no longer with
<Company>" with the company's contact details; any NFC tag pointing at it does the same. The leads it
collected stay with the company and move to whoever takes over their accounts in the existing exit
hand-over.

---

## 4. Event lead capture (inside Cards)

Blinq sells this separately and charges per lead. In Deskzo it is part of Cards, and the leads land in
the CRM already.

- **An event**: name, dates, venue, the team working it, a tag and a goal (number of leads).
- **Booth mode:** the card page shows the form first, for a tablet or phone on the stand; or a
  team member scans the visitor's card.
- **Its own questions:** up to five (interested in, budget band, timeline…), and hidden fields
  (event code).
- **Every lead** is tagged with the event, owned by the person who met them, source "Event".
- **Results:** leads by person and by day, against the goal; cost per lead if the event's cost is entered.
- **Scanning:** another Deskzo card or any vCard QR (phase 1); **paper business cards by photo** needs
  OCR — the owner declined OCR for vendor PDFs in October, so this is a decision (section 7).

---

## 5. Deskzo Signatures

### 5.1 The free generator (deskzo.com)

- A public page on the platform site: fill in name, title, company, phone, logo, photo and social
  links, pick one of a handful of layouts, **copy** into Gmail, Outlook or Apple Mail. No sign-up.
- A small "Made with Deskzo" link at the bottom, removable on the paid plan — the way HubSpot and
  WiseStamp turn their generators into customers.
- One call to action: "Give your whole team this signature, kept in step — free for 14 days."
- It is the top of the funnel; keep it fast and indexable (the platform site's SEO settings).

### 5.2 The paid module

- **Templates** with placeholders from each person's record: name, title, department, phones,
  email, photo, branch address, and the card's link and QR.
- **Rules:** which template for which department, branch or role.
- **Brand lock:** people can't edit what the admin sets (Zoho enforces this natively; Gmail lets users
  edit an API-set signature, so the next sync puts it back).
- **Banners and campaigns:** a promotional banner for a date range, to some or all people, with clicks
  counted.
- **Disclaimers:** a legal line per company or branch.
- **Who:** `signatures.manage` — create, edit and sync. Default: Admin, Management.

### 5.3 Syncing into mailboxes — what each provider allows

This is the hard part, and the research settled it:

| Provider | How | What it needs | Notes |
| --- | --- | --- | --- |
| **Google Workspace** | Gmail API `users.settings.sendAs.update` for each person | the workspace's own service account with **domain-wide delegation**, authorised once by its Super Admin; scope `gmail.settings.basic` | Sets the default for new mail in Gmail on the web; users can still edit, so re-sync on a schedule. A restricted scope. Using the **company's own** Google project (Deskzo's existing "each workspace's own apps" rule) should keep it an internal app rather than a public one Google must assess — to be confirmed before phase 4. |
| **Zoho Mail** | the official admin Signature API for each user | the workspace's own Zoho client (already used for sign-in and mail), scope `ZohoMail.organization.accounts` | Users **cannot** edit an admin-set signature — the cleanest of the three. Multi-data-centre aware, as the existing Zoho client already is. |
| **Microsoft 365** | an **Outlook add-in** that inserts the signature when a message opens (`OnNewMessageCompose` + `setSignatureAsync`) | the company's admin deploys it once from the Microsoft 365 admin centre (Integrated apps) | Microsoft Graph **cannot** set Outlook signatures and Microsoft has no plans to add it. The add-in is Microsoft's recommended way and what Exclaimer, CodeTwo, WiseStamp and Letsignit all use; it shows the signature while composing, on the web, Windows, Mac, iOS and Android. |

Microsoft fallbacks, offered but not the default:
- **Mail-flow rule ("apply a disclaimer")**, as a ready-made script and guide the company's Exchange admin runs (Exchange has no web API for mail-flow rules): works on every device with no
  add-in, but the sender doesn't see it while writing, it sits below the quoted thread in replies, it isn't
  in Sent Items and it is limited to 5,000 characters.
- **Copy-paste instructions**, for a company that wants neither.
- Not used: PowerShell's `Set-MailboxMessageConfiguration` — it reaches only Outlook on the web and the new
  Outlook, and only with roaming signatures switched off.

Blinq itself has no Zoho support and only a per-user Outlook add-in — on Zoho and Microsoft, Deskzo
would be ahead of the product it started from.

### 5.4 Sync behaviour

- A sync runs when the template, the person's record or a rule changes, and nightly to undo edits.
- Each person shows **in step / waiting / failed (why)**, per mailbox.
- A leaver's signature isn't synced again; their mailbox is the IT team's to close.

---

## 6. Phases

| # | Phase | What | Size |
| --- | --- | --- | --- |
| 0 | Work profile | Title, department, work phone, photo, branch editable without People; "Fill from Microsoft 365 / Google / Zoho" | S |
| 1 | Cards | Permissions, templates and locks, issuing in bulk, the card, My card page with QR, public page with vCard and share-back, leads or card contacts, card off on exit, per-card numbers | M |
| 2 | Event lead capture | Events, booth mode, questions, tags, results, scanning another card's QR | S–M |
| 3 | Free generator | Public page on deskzo.com, layouts, copy, the "Made with Deskzo" link | S |
| 4 | Signatures — Google and Zoho | Templates, rules, brand lock, banners, disclaimers, sync for Gmail and Zoho Mail | M |
| 5 | Signatures — Microsoft 365 | The Outlook add-in (manifest, hosted script, admin deployment guide), the mail-flow-rule fallback | M |
| 6 | Extras | Apple and Google Wallet passes, virtual backgrounds, a second card per person, campaign click analytics | M |

Phases 1–3 can ship as **Deskzo Cards** and a public generator before any mailbox sync exists.

---

## 7. Decisions for the owner

**10 Oct 2026: "go with your suggestions"** — the card address is `<workspace>.deskzo.com/c/<name>`; title, department, work phone and photo become editable without People; free signatures carry a "Made with Deskzo" link, removable on paid; wallet passes are phase 6; nobody has a card until HR or an admin switches it on. The build starts with phase 0 and phase 1.

1. ~~Prices~~ — **decided 10 Oct 2026: set and changed from the platform console**, shown on the website
   from there; nothing priced in the code. The figures in 2.2 are a suggestion for whoever enters them.
2. **Card address:** `<workspace>.deskzo.com/c/<name>` (works today), or a short shared domain later
   (needs buying and routing)?
3. **Standalone directory:** make title, department, work phone and photo core fields, editable without
   People — yes?
4. ~~Paper-card scanning (OCR)~~ — **decided 10 Oct 2026: later.** Event lead capture ships with QR
   scanning only; photo scanning moves to phase 6 or after.
5. ~~Microsoft 365 route~~ — **decided 10 Oct 2026: explore the Outlook add-in.** Phase 5 starts with a
   short spike (a test tenant, event-based activation, `setSignatureAsync` on web, Windows, Mac and
   mobile, admin deployment from Integrated apps) before committing to it; the mail-flow rule stays the
   fallback.
6. **"Made with Deskzo" on free signatures:** yes, removable on paid?
7. **Wallet passes:** Apple needs a pass-type certificate on Deskzo's Apple developer account; Google
   needs a Wallet issuer account. Phase 6, or sooner?
8. **Who switches cards on by default:** nobody until HR or an admin does (suggested), or Sales by default?

---

## 8. What was built (11 Oct 2026)

**Phase 0 — work profile.** Staff & roles' edit dialog now edits a person's photo, job title (the HR
record's designation) and work phone, with `users.manage` (`updateWorkProfile` in src/actions/user.ts).
A workspace that bought Cards alone fills them in there. "Fill from Microsoft 365 / Google / Zoho" is not
built yet.

**Phase 1 — Deskzo Cards**, module `cards`, product `cards` (sold alone and in One; prices from the
console's Plans, as for every product).

- **A card is issued, not a permission.** Section 3.1 proposed `cards.use`. It was dropped: the super
  admin holds every permission and admins hold every key they aren't denied, so a permission can't mean
  "nobody has a card until somebody switches it on". A card is a `DigitalCard` row HR issues; the one
  permission is `cards.manage` (Management, HR, HR head by default). `cards.viewLeads` was dropped too:
  leads from a card are ordinary leads, seen by the CRM's own rules; card contacts are seen by their
  holder and by `cards.manage`.
- **My card** (/cards) shows in the menu only to somebody with a live card (`NavItem.onlyFor:
  "cardholder"`). The card, its QR (logo over the middle, downloadable as PNG), its link, the week's
  numbers, which record fields to leave off, own links and numbers, and the people who shared back.
- **Digital cards** (/cards/manage, `cards.manage`): everybody with their card's state and 30-day
  numbers; issue to the people ticked, a department, a branch, a role or everybody; switch off; move to a
  template; change a card's address. Templates: colour, layout, logo, record fields (shown / locked /
  order), shared fields, own fields allowed, share-back and up to five questions; the save button says
  how many cards it changes. Contacts: everybody's share-backs.
- **The public card** (/c/<name>, no sign-in): Save contact first (a vCard 3.0, photo included), the
  fields, and sharing back underneath. A card that isn't live — switched off, account off, or past its
  holder's last working day — shows the company's details. Views, saves, taps and share-backs are
  counted, nothing about who (30 a minute of each per card at most).
- **Share-back** is always kept as a `CardContact` in the holder's name; with the CRM in the plan it is
  also a lead (source **Digital card**) owned by the holder, through the website intake's rules. A
  hidden field and a 2-second minimum answer bots with thanks; 10 a card in 10 minutes and 30 a minute
  across the workspace.
- **Leavers:** the exit hand-over has a "Digital card contacts" area.
- **Checks:** `npm run check:cards` (field rules, vCard format, issuing, live/off/left, the public
  card, share-back and its lead, limits, own choices, templates, hand-over, the pages rendered).

Not built yet from phase 1's list: the Staff & roles "Digital card" column (issuing lives on Digital
cards instead), and telling cardholders when their template changes.

**Phase 2 — event lead capture (11 Oct 2026).** Called "Card events" in the app, so they aren't mistaken
for the events a company hosts in Forms & Events.

- **An event** (`CardCampaign`): name, venue, first and last day, goal (people to meet), cost, its team
  (`CardCampaignMember`) and up to five booth questions. Made and changed by `cards.manage`; an event
  anybody was met at can't be deleted.
- **Counted against it:** a share-back from a team member's card on the event's days (when they work
  exactly one event that day); the **booth form** — `/c/<name>?e=<code>`, the card with the form first,
  the event's questions, and "Next visitor" after each; and a **scan** by one of the team.
- **Scanning** (`/cards/events/<id>/capture`): the browser's own QR reader where it has one (Chrome and
  Edge, Android included; not Safari yet), or a pasted link or contact text. Reads vCard, MECARD, this
  workspace's cards from the database and another Deskzo workspace's card by asking its contact file —
  nothing off the platform's domain is fetched. Open while the event runs and for 7 days after; the
  same email or phone twice at one event is refused.
- **Leads** are source **Event**, titled "… — met at <event>", with the event in the source detail, owned
  by whoever met them. `CardContact.via` says how (share-back, booth, scan); a scan needs no card.
- **Results** (`/cards/events/<id>`): people met against the goal, leads made, by person and by day,
  cost per person, each card's booth link and QR, everybody met (the team sees only their own), CSV
  export for managers. My card lists the holder's events with their booth form and capture link.
- **Menu:** "Card events" shows to whoever manages cards and to anybody on the team of an event that
  ended less than a week ago (`NavItem.onlyFor: "eventTeam"`).
- **Limits:** a booth form takes 60 a card in 10 minutes (a queue at a stand is the point); 60 a
  minute across the workspace.

Still open from section 4: paper business cards by photo (OCR — the owner said later), and hidden
source fields beyond the event code. iPhone scanning would need a QR-reading library (a new
dependency, for the owner to approve); until then iPhone users scan with the camera and paste the link.
