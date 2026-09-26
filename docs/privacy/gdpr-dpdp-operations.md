# Privacy operations — GDPR and the DPDP Act

> **Draft for review by counsel. Not legal advice.** How Wroffy meets its duties in practice, written against what the software does today. Deadlines quoted from the DPDP Rules should be checked against the Rules as finally in force before this is relied on.

## Who is who

| Data | Wroffy's role | The other party |
|---|---|---|
| What a customer records in its workspace | **Processor** (GDPR) / **Data Processor** (DPDP) — acts only on the customer's instructions | The customer is the Controller / Data Fiduciary |
| Signups, workspace owners' account and billing details, staff of Wroffy, visitors to the public site | **Controller** / **Data Fiduciary** | — |

Everything below marked *customer's workspace* is done by the customer with the software; Wroffy helps when asked (DPA §7).

## Requests from people about their data

| Request | Customer's workspace | Wroffy's own data (signups, billing) |
|---|---|---|
| Access / a copy | The customer finds and exports it: search, the record's pages, Settings → Data export | Staff export the account's control-plane records; reply within 30 days (GDPR) or the time the DPDP Rules set |
| Correction | Edited on the record | Corrected in the console |
| Erasure | Deleted on the record; a person's marketing consent withdrawn by unsubscribing, which always works | A closed workspace is erased after 90 days (§ Retention); a signup that never became a workspace is deleted on request |
| Withdraw consent to marketing | Every email carries one-click unsubscribe and a preference centre, open whatever the customer's plan | — |
| Grievance (DPDP) | The customer's own grievance officer | Wroffy's grievance officer: *name and contact to be published* — answers within the period the Rules set |

Keep a register of every request: who, what, received, answered, how.

## Retention

| What | Kept | Then |
|---|---|---|
| A workspace's data | While it has a workspace | On closing: a final backup, then its database deleted |
| A closed workspace's final backup and keys | 90 days | Keys wiped: every copy unreadable |
| Platform database backups | 30 days | Expire |
| Signups not completed | 24 hours for the code; the row until cleaned up | Delete unfinished signups older than 30 days (a job to add) |
| Platform audit log, billing events, invoices | As long as tax law requires (India: 8 years for accounts) | Then deleted |
| Application logs | 30 days | Rotated |

## Breaches

1. **Detect and contain** — runbook §5.9: hold the workspaces involved, preserve logs (each line names its workspace).
2. **Assess** within 24 hours: what data, whose, which workspaces, how likely harm is.
3. **Notify customers** whose workspaces are affected without undue delay and within **48 hours** (DPA §8) — they are the controllers and must notify their regulators and the people affected.
4. **Where Wroffy is the controller** (signup and billing data):
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

- Confirm the lawful basis for Wroffy's own processing there, and whether a local representative is required (GDPR art. 27 for the EU without an establishment).
- Check transfer rules, and whether the workspace must be hosted in that region (the control plane records a region for each workspace; hosting outside India is not built yet).
- Have the DPA reviewed for that law.
