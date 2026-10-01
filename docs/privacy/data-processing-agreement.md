# Data Processing Agreement — draft

> **Draft for review by counsel. Not legal advice.** Written from how the platform actually handles data (so the technical promises below are ones it keeps today); the legal wording, governing law and liability terms need a lawyer's review for India (DPDP Act 2023 and its Rules), the EU/UK (GDPR, UK GDPR) and any other market sold into.

This agreement forms part of the Terms of Service between **Deskzo** ("Processor", the provider of the Deskzo One platform) and the **Customer** who holds a workspace on it ("Controller" under the GDPR; "Data Fiduciary" under the DPDP Act).

## 1. Subject matter, duration, nature and purpose

- **Subject matter:** personal data the Customer puts into its workspace, or collects through it (its forms, its customer portal, its visitor tablet), while using the service.
- **Duration:** for as long as the Customer has a workspace, and for the retention period after it is closed (§9).
- **Nature:** hosting, storing, backing up, and processing as the Customer's use of the software directs — nothing else.
- **Purpose:** to provide the service the Customer subscribed to.

## 2. Personal data and data subjects

The Customer decides what it records. Typically:

| Data subjects | Personal data |
|---|---|
| The Customer's staff (its users) | Name, work email and phone, role, department, sign-in records and devices, attendance and leave, HR and payroll records where those modules are used |
| The Customer's customers and prospects | Contact names, work email and phone, company, communications, orders, invoices, tickets, feedback |
| The Customer's vendors, resellers, visitors, candidates | Contact details and what the Customer records about them |
| Recipients of the Customer's marketing | Email address, consent and its evidence, opens and clicks, unsubscribes |

The service is not directed at children, and the Customer agrees not to record children's personal data through it without the verifiable parental consent the law requires.

## 3. The Processor's obligations

The Processor:

1. processes personal data only on the Customer's documented instructions — the use of the software, and this agreement — unless the law requires otherwise, in which case it tells the Customer first where the law allows;
2. ensures everyone with access to it is bound to confidentiality — staff reach a workspace's data only when its owner grants support access, for a time the owner chooses, and every such access is recorded in the workspace's own activity log;
3. implements the security measures in §5;
4. uses sub-processors only as in §6;
5. helps the Customer answer data subjects' requests (§7) and meet its own obligations on security, breach notification and impact assessments, as far as the nature of processing allows;
6. deletes or returns personal data at the end of the service (§9);
7. makes available the information needed to show compliance with this agreement, and allows for audits (§10).

## 4. The Customer's obligations

The Customer is responsible for having a lawful basis (or, under the DPDP Act, consent or a legitimate use) for what it records, for its notices to data subjects, for the accuracy of what it records, and for the access it gives its own users.

## 5. Security measures

What the platform does today:

- **Isolation:** each workspace has its own database, with its own database role; no other workspace's role can connect to it. Every request is served as exactly one workspace, decided by the address it arrives on; a cross-workspace penetration test runs with every release (docs/reports/pentest.md).
- **Encryption:** stored secrets (passwords for mail, API keys, credentials in the vault) are encrypted with keys unique to the workspace; those keys are sealed under a platform key held outside the database. Traffic is encrypted in transit (TLS).
- **Access:** workspace sign-in with optional enforced two-factor and Microsoft single sign-on; roles and permissions the Customer sets; per-person device and network rules; account lockouts after repeated failures. Platform staff sign in to a separate console with two-factor authentication, and cannot enter a workspace without its owner's grant.
- **Records:** an activity log of sign-ins, exports and changes in each workspace; a platform audit log of every staff action.
- **Resilience:** point-in-time recovery of the database cluster, and scheduled, sealed backups of each workspace kept apart from every other's.
- **Limits:** each workspace's database activity is bounded (time and connections), so one workspace's load cannot deny service to another.

## 6. Sub-processors

The Customer authorises the sub-processors listed in docs/privacy/subprocessors.md. The Processor gives the Customer at least 30 days' notice of any new sub-processor, during which the Customer may object; if the objection cannot be resolved, the Customer may end the service for the affected part and receive a pro-rata refund. Each sub-processor is bound to data protection obligations no less protective than these.

Services the **Customer** connects to its own workspace with its own credentials — its mail provider, its AI provider for the copilot, the government e-invoice and e-way bill portals, Microsoft for single sign-on — act for the Customer, not as the Processor's sub-processors.

**Partners** — the resellers and distributors who sell or support the service under Deskzo's partner programme — are not sub-processors: they never access the Customer's workspace or the personal data in it, and receive none of it from the Processor. What a partner is shown about a Customer it sold to is limited to the Customer's account with Deskzo (its plan, status, what it pays and its renewal date), which Deskzo holds as controller, not under this agreement.

## 7. Data subjects' rights

The software lets the Customer answer requests itself: find everything held about a person, export it (Settings → Data export), correct it, and delete it. Marketing recipients can always see and change what they receive, and unsubscribe, whatever the Customer's plan. Where the Customer cannot answer a request with the software, the Processor helps within 10 working days of being asked.

## 8. Personal data breaches

The Processor notifies the Customer **without undue delay, and in any case within 48 hours**, of becoming aware of a breach affecting the Customer's personal data — so the Customer can notify its supervisory authority within 72 hours under the GDPR, and the Data Protection Board of India and affected Data Principals as the DPDP Rules require. The notice describes what happened, the data and people affected (as far as known), likely consequences, and what has been and will be done; further details follow as they are established.

## 9. Return and deletion at the end of the service

- Before closing, the Customer can export its data (Settings → Data export, and Settings → Backups for a full archive).
- When a workspace is closed, a final backup is taken and its database is deleted. The backup and the keys to read it are kept for **90 days** — in case the Customer returns or asks for its data — and then irreversibly destroyed: the keys are wiped, which makes every remaining copy, including off-site backups, unreadable.
- Database-level backups of the whole platform expire on their own schedule (30 days); a closed workspace's data in them becomes unreadable once its keys are destroyed.

## 10. Audits

The Processor makes available on request its current security documentation, penetration test and load test reports, and answers reasonable security questionnaires. On-site audits, at the Customer's cost, with 30 days' notice, no more than once a year unless a breach or a regulator requires it.

## 11. International transfers

Personal data is hosted in the region stated for the workspace (India, unless agreed otherwise). Where data is transferred out of the EU/UK, the Standard Contractual Clauses (and the UK Addendum) apply; transfers from India follow any restrictions the Central Government notifies under section 16 of the DPDP Act.

## 12. Order of precedence

If this agreement and the Terms of Service conflict on the protection of personal data, this agreement prevails.
