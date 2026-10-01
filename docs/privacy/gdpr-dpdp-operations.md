# Privacy operations — GDPR and the DPDP Act

> **Draft for review by counsel. Not legal advice.** How Deskzo meets its duties in practice, written against what the software does today. Deadlines quoted from the DPDP Rules should be checked against the Rules as finally in force before this is relied on.

## Who is who

| Data | Deskzo's role | The other party |
|---|---|---|
| What a customer records in its workspace | **Processor** (GDPR) / **Data Processor** (DPDP) — acts only on the customer's instructions | The customer is the Controller / Data Fiduciary |
| Signups, workspace owners' account and billing details, staff of Deskzo, visitors to the public site | **Controller** / **Data Fiduciary** | — |
| The partner programme: partners' people and contacts, applicants to the programme, the prospects partners name in deal registrations, commission and statement records | **Controller** / **Data Fiduciary** | — (partners are not sub-processors: § The partner programme) |

Everything below marked *customer's workspace* is done by the customer with the software; Deskzo helps when asked (DPA §7).

## Requests from people about their data

| Request | Customer's workspace | Deskzo's own data (signups, billing) |
|---|---|---|
| Access / a copy | The customer finds and exports it: search, the record's pages, Settings → Data export | Staff export the account's control-plane records; reply within 30 days (GDPR) or the time the DPDP Rules set |
| Correction | Edited on the record | Corrected in the console |
| Erasure | Deleted on the record; a person's marketing consent withdrawn by unsubscribing, which always works | A closed workspace is erased after 90 days (§ Retention); a signup that never became a workspace is deleted on request |
| Withdraw consent to marketing | Every email carries one-click unsubscribe and a preference centre, open whatever the customer's plan | — |
| Grievance (DPDP) | The customer's own grievance officer | Deskzo's grievance officer: *name and contact to be published* — answers within the period the Rules set |

Keep a register of every request: who, what, received, answered, how.

## Support requests (Contact Support)

Anyone signed in to a workspace can send Deskzo a support request from inside it. Each request keeps what the person wrote (subject, details, how critical, an optional mobile number) and the files they attach; who sent it (name, email and role in the workspace) and from which workspace; their IP address; and — as the dialog tells them before they send — the page they were on and their browser, screen size, time zone and language. A **screen recording** is made only after the person ticks a consent box listing what it collects, and only with a recording are the browser's console errors and warnings during it (at most 200, each cut to 500 characters) and the page's load timings kept; the microphone is off unless they switch it on. Recording is not offered where the workspace's copy and print deterrents apply to the person. A recording shows whatever was on the screen they chose to share, which can include the workspace's records about other people: staff treat it with the same care as support access to the workspace, and counsel should check that DPA §3.2 covers it.

Requests are kept in the platform's control-plane database; their files and recordings on the platform's own servers (`SUPPORT_DIR`, never a public folder or a third-party store), opened only by Deskzo's support staff through the console, each opening recorded in the platform audit log. Mail about a request goes through the platform's mail provider (subprocessors.md). A request's files are deleted a set time after it is closed — 365 days unless changed in the console (30 to 3,650) — and uploads chosen but never sent after a day; the request itself, its timeline and the list of what was attached are kept as the support record. There is no delete button for a request yet: an erasure request is carried out by an operator in the control plane (deleting the request deletes its attachments' rows and its timeline; its folder in `SUPPORT_DIR`, `<workspace id>/<request id>`, is deleted by hand as well).

## The partner programme

> Draft for counsel, like the rest of this document.

Resellers and distributors sell the platform and are paid commission on what their customers pay (runbook §12). Everything the programme keeps is Deskzo's own data, as **controller** / **data fiduciary**, in the platform's control-plane database:

- **Partners' people**: name, work email, role, sign-in times, sessions (with the address and device they signed in from), whether they use an authenticator (its secret sealed), and their activity log in the portal.
- **Partners themselves**: legal and display name, country and territories, a contact's name, email and phone, address, tax ids, and payout (bank) details — sealed, shown to Deskzo's billing staff only when one of them reveals them, and each reveal recorded in both the platform's audit log and the partner's own.
- **Applicants**: what the public "Become a partner" form asks — company, website, country, a contact's name, work email and phone, and their message — and the address it was sent from. Each application is also mailed to Deskzo's sales address.
- **Prospects in deal registrations**: the company's name and email domain, its country and, optionally, a contact's name and work email, as the partner gives them. The contact is kept only for the registration; it is never exported, and never shown to another partner.
- **Commission and statement records**: per paid invoice, what was earned, clawed back, approved and paid, and each statement's snapshot of the partner's details.

**What a partner sees of its customers.** A customer (a workspace) attributed to a partner has its **plan, status, what it pays and its renewal date visible to that partner** — with its name and address, country, billing standing, and how it came to be attributed — for as long as it is attributed to that partner. The partner never sees anything inside the workspace (no workspace database is opened for it, and it has no support access), nor the customer's contact addresses, tax id or invoices. In turn, the customer sees its partner's name on its Billing page. Counsel should check that the customer terms say this, since the customer's account facts reach a third party (owner question).

**Partners are not sub-processors.** They never access a workspace or the personal data a customer keeps in it, so they are not in subprocessors.md (DPA §6).

**Cookies.** The referral cookie (`deskzo_ref`, set when someone arrives on the public site through a partner's `?ref=` link) is **off** by default and stays off until the site has a consent mechanism; referral links still work from the address itself.

**Requests from people.** A partner's people correct their own name in the portal, and a partner's admins manage their people; staff export or correct a partner's, an applicant's or a prospect's records in the console. There is no delete button yet: an erasure is carried out by an operator in the control plane, keeping what the retention rules below require (commission and statement records are billing records).

## Retention

| What | Kept | Then |
|---|---|---|
| A workspace's data | While it has a workspace | On closing: a final backup, then its database deleted |
| A closed workspace's final backup and keys | 90 days | Keys wiped: every copy unreadable |
| Platform database backups | 30 days | Expire |
| Signups not completed | 24 hours for the code; the row until cleaned up | Delete unfinished signups older than 30 days (a job to add) |
| Platform audit log, billing events, invoices | As long as tax law requires (India: 8 years for accounts) | Then deleted |
| Application logs | 30 days | Rotated |
| Support requests' files and recordings | Until 365 days (the console's setting) after the request is closed; unsent uploads a day | Deleted by the hourly platform tick; the request and its timeline are kept |
| Partner applications | 24 months from being sent | Deleted (a cleanup job to add) |
| Deal registrations, their prospect contacts included | 12 months after the registration closes (won, declined, expired or withdrawn) | Deleted (a cleanup job to add) |
| Commission entries and partner statements | As billing records: as long as tax law requires (India: 8 years) | Then deleted |

## Breaches

1. **Detect and contain** — runbook §5.9: hold the workspaces involved, preserve logs (each line names its workspace).
2. **Assess** within 24 hours: what data, whose, which workspaces, how likely harm is.
3. **Notify customers** whose workspaces are affected without undue delay and within **48 hours** (DPA §8) — they are the controllers and must notify their regulators and the people affected.
4. **Where Deskzo is the controller** (signup and billing data):
   - GDPR: the supervisory authority within **72 hours** of becoming aware, unless the breach is unlikely to result in a risk; the people affected without undue delay if the risk is high.
   - DPDP: the **Data Protection Board of India** and **each affected Data Principal**, without delay; the Rules then ask for a detailed report (at the time of writing, within 72 hours) — check the Rules in force.
5. **Record** every breach, notified or not: facts, effects, remedy.

## Security of processing

As in DPA §5, and verified by:

- `npm run pentest` — the cross-workspace penetration test (docs/reports/pentest.md), before any release touching sign-in, tenancy or billing;
- the check suites, on every change;
- `npm run load:test` — that one workspace cannot starve others (docs/reports/load-test.md).

## Records of processing (GDPR art. 30)

Keep, and update when anything changes:

- categories of data and data subjects (DPA §2);
- purposes (DPA §1);
- sub-processors and transfers (subprocessors.md, DPA §11);
- retention (above);
- security measures (DPA §5).

## Before selling into a new market

- Confirm the lawful basis for Deskzo's own processing there, and whether a local representative is required (GDPR art. 27 for the EU without an establishment).
- Check transfer rules, and whether the workspace must be hosted in that region (the control plane records a region for each workspace; hosting outside India is not built yet).
- Have the DPA reviewed for that law.
