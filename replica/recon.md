# Recon map: Blinq (web, iOS, Android)

Scope: Blinq's digital business card for one person and for a company — the card, how it is shared,
what the recipient sees, the contacts and leads it collects, and the Business admin that issues and
controls everyone's cards. Email signatures are mapped separately, below.
For: two new Deskzo products, **Digital cards** and **Email signatures**, each sold standalone and
included in Deskzo One (owner, 10 Oct 2026). Proposal: docs/digital-cards-and-signatures.md.
Date: 2026-10-10

**Clean-room note.** Blinq's Terms of Service (03 Sep 2026) forbid using the platform to build a
competing product (10.1(a)), derivative works (8.3(d)) and competitive analysis (8.3(e)(3)); the website
terms forbid copying and scraping. This map was made from public pages only — no account, no app
binary, no network calls — and describes *what* the product does. Deskzo builds its own design, copy
and assets. Nobody on the team should sign up to Blinq to study it.

## Sources

About 75 public pages were read one at a time. The ones that carry the most:

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | help centre | https://support.blinq.me/en | 11 collections, ~136 articles — the fullest feature list |
| 2 | plans overview | https://support.blinq.me/en/articles/76752-blinq-plans-overview-free-premium-business-enterprise | the most reliable plan gating |
| 3 | pricing | https://blinq.me/pricing | prices; its comparison table repeats one column, unusable |
| 4 | admin onboarding | https://support.blinq.me/en/articles/73643-business-admin-onboarding-guide | the whole admin set-up |
| 5 | templates | https://docs.blinq.me/features/team-templates.md | shared vs individual fields, invite link |
| 6 | provisioning | https://docs.blinq.me/identity/how-provisioning-works.md | SCIM, locked and linked fields |
| 7 | contacts | https://docs.blinq.me/features/contacts.md | ownership, sources, leavers |
| 8 | Zapier field reference | https://docs.blinq.me/integrations/zapier/field-reference.md | the full contact payload — best data-model evidence |
| 9 | CRM connect | https://support.blinq.me/en/articles/68084-connecting-blinq-to-your-crm | CRMs, automatic vs manual, field mapper |
| 10 | lead form | https://support.blinq.me/en/articles/76391-build-a-custom-lead-form | form builder, lead-capture mode |
| 11 | recipient save | https://support.blinq.me/en/articles/68044-saving-a-blinq-card-to-your-mobile-contacts | vCard save flow |
| 12 | share-back | https://support.blinq.me/en/articles/76757-what-happens-when-someone-shares-their-card-back-to-you | temporary card for the recipient |
| 13 | claim a team card | https://support.blinq.me/en/articles/68065-claim-a-team-card-on-your-iphone | ~10 taps |
| 14 | remove a member | https://support.blinq.me/en/articles/68075-deleting-a-team-member | offboarding |
| 15 | NFC pairing | https://support.blinq.me/en/articles/68113-pairing-your-blinq-nfc-card | pair a tag to a card |
| 16 | campaign insights | https://support.blinq.me/en/articles/78112-campaign-insights | the only documented analytics screen |
| 17 | App Store | https://apps.apple.com/us/app/blinq-digital-business-card/id1324102258 | 4.9 from 132K ratings |
| 18 | Trustpilot | https://au.trustpilot.com/review/blinq.me | 4.8 from 1,050; complaints on the 1-star filter |
| 19 | terms | https://blinq.me/legal/terms-conditions | the non-compete clauses above |

## Core loop

An employee shares a company-branded card with one tap or scan; the person they meet saves it
without installing anything and shares their own details back, which lands as a lead the company
owns and follows up in its CRM.

## Screens

Blinq is a native app plus a web dashboard. Deskzo has no native app, so its equivalents are a
mobile-first page inside the workspace and the public card page (see the proposal).

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Onboarding wizard | first launch | name, work email/phone, company, logo (auto-found), photo, sign-in | step form, image picker | each step; logo found / not found |
| S02 | My cards | app home | swipe between cards, each with its QR; send; add | card carousel, QR | online QR, offline QR, card limit reached |
| S03 | Card editor | pencil on S02 | colour, images and layout, fields (add, drag, sub-fields), delete | field list, layout picker, colour picker | personal; team card with locked fields (pop-up on tap) |
| S04 | Send menu | send on S02 | text, email, Apple/Google Wallet, NameDrop | action sheet | — |
| S05 | Contacts | tab | everyone collected; filter own / teammates | list, filters, search | empty, filled, teammate label |
| S06 | Contact detail | S05 | notes, tags, save to phone, share with company, booking, CRM context | note list, tag chips, CRM card | enriched / not, synced / not |
| S07 | Scanner | tab | paper card, badge, QR, LinkedIn QR | camera, form picker | offline queue, enrichment failed → quick edit |
| S08 | Add contact | S05 + | manual entry | form | — |
| S09 | Settings | menu | account, pair NFC device | NFC pairing steps | tag found / not |
| S10 | Claim team card | invite email | sign in and take the card the company made | auth, "edit design / skip" | link expired (7 days) |
| S11 | Dashboard home | dash | four-step set-up checklist | checklist | steps done / not |
| S12 | Cards (admin) | dash | every team card; create, edit, share, copy, delete | table, card editor with padlocks, eye, optional toggle | Activated, Resend invite |
| S13 | Templates | dash | brand template: images, layout, colour, shared vs individual fields, QR logo, lead form, calendar link | editor + preview, tabs | change summary with cards affected |
| S14 | Team members | dash | add, invite, roles, bulk change, remove | table, bulk bar | invited, active, removed |
| S15 | Company contacts | dash | my / all company contacts; export; sync status per integration | table, bulk bar | per-integration sync status |
| S16 | Campaigns | dash | event: dates, goals, team, tag, lead form, badge scanning; insights | wizard, insights | before / live / after |
| S17 | Email signatures | dash | see the signatures section | — | — |
| S18 | Virtual backgrounds | dash | background with the card's QR, for video calls | image + text box editor | — |
| S19 | Workspace settings | dash | allowed domains, fonts, enrichment, directory, integrations, tags, SSO | forms | — |
| S20 | Public card page | link / QR / NFC | the card in a browser; save contact (.vcf); share back | card, Save Contact, lead form | card first; form first (lead-capture mode); after submit; deleted card |

## Flows

```
F01 Employee gets a company card and shares it in person
    invite email -> S10 claim -> S02 -> show QR (or pre-paired NFC tap)
    happy path: ~10 taps on iPhone to claim, 5 on desktop; then 0-1 to show the QR
    edge: invite link expired (7 days), card limit, offline (QR still works)

F02 Recipient saves the card and shares back, with no app
    scan / tap / link -> S20 -> Save Contact -> (share back: name + email or phone)
    happy path: 3 taps on iPhone to save, 5-6 on Android; +1 and typing to share back
    edge: lead-capture mode puts the form first; skip allowed only if the admin allows it;
          recipients complain they "must download the app" or give data to get the card

F03 Admin brands and onboards a team
    S13 template -> S14 add members (or CSV, invite link, SSO/SCIM) -> S12 create cards -> send
    happy path: ~10-15 clicks for a template; ~4-5 per person by hand
    edge: later template edit shows fields changed and cards affected before saving

F04 Employee leaves
    S14 "..." -> remove -> confirm  (3 clicks)
    their team cards and signatures go; captured contacts stay with the company;
    no documented way to hand their contacts to another rep

F05 A lead reaches the CRM
    S19 connect CRM once -> capture on a team card -> synced "within seconds",
    deduplicated by email, owner matched, tags and notes carried; one-way
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Card preview | phone frame, full page | layouts with 0-3 images | S02, S03, S12, S13, S20 |
| Field row | phone, email, url, social, address, accreditation | locked, linked to directory, optional, hidden | S03, S12, S13 |
| QR code | plain, with logo | online, offline | S02, S18, S20, wallet pass |
| Lock / eye / optional toggles | per field, per theme | on, off | S12, S13 |
| Lead form | default, custom (up to 5 fields), hidden fields | card first, form first, skippable | S20, S13, S16 |
| Bulk action bar | members, contacts | 2+ selected | S14, S15 |
| Change summary dialog | template edit | fields changed, cards affected, notify toggle | S13 |
| Sync status chip | per integration | synced, pending, failed, time | S15 |

## Inferred data model

```
Workspace   name, allowed_domains, fonts, enrichment_on, directory_on, seats, owner
            evidence: S19, help 77772, 76748   confidence: high
Membership  user, workspace, role (member | admin | owner), status (invited | active | deactivated)
            evidence: 68071, 77771   confidence: high
Card        owner, workspace (null = personal), template, label, slug/url, theme, font, layout,
            images (profile 1:1, logo 16:9, cover 16:9), status (unclaimed | active | deleted),
            invite_expires_at, theme_locked
            evidence: 68008, 68009, 68061, 68064   confidence: high
CardField   card, type (phone, email, url, social..., accreditation, name parts), label, value,
            position, locked, linked_to_directory, optional, hidden, filled_by (admin | owner)
            evidence: 68019, 68061, provisioning doc   confidence: high
Template    label, images, layout, theme, qr_logo, fields (shared value | individual placeholder),
            lead_form, calendar_link, invite_link, directory filter
            evidence: 68057, templates doc   confidence: high
Contact     owner, scope (personal | workspace), source (exchange | share-back | scan | manual |
            linkedin | notetaker), name parts, title, department, company, photo, emails, phones,
            addresses, ~25 social urls, tags, campaigns, notes, custom answers, where_met,
            enrichment status, per-integration sync status
            evidence: Zapier field reference   confidence: high
LeadForm    heading, button, lead_capture_mode, skippable, fields (text | dropdown | checkbox),
            hidden fields; belongs to a template or a campaign
            evidence: 76391   confidence: high
Campaign    name, dates + time zone, location, goals, team, tag, lead form, badge source
            evidence: campaigns doc, 78112   confidence: high
CardEvent   card, kind (view | save | field_click | share_back), source, at
            evidence: campaign insights only   confidence: guess
NfcDevice   tag id, card (re-pairable, several per card)
            evidence: 68113, 71524   confidence: medium
```

Relationships: Workspace 1-n Membership, Workspace 1-n Template, Template 1-n Card, User 1-n Card,
Card 1-n CardField, Card 1-n Contact (collected), Card 1-n CardEvent, Card 1-n NfcDevice,
Campaign 1-1 LeadForm, Campaign 1-n Contact.

## Feature matrix

See `features.csv`. Must: 25, should: 15, could: 9, skip: 8.

## Out of scope (cannot or should not be cloned)

- **Blinq's network**: Blinq-to-Blinq exchange and cards that update in the other person's app.
  Deskzo's equivalent is a card link that is always current.
- **Native apps**: App Clip, home-screen widgets, Apple Watch / Wear OS, NameDrop. Deskzo is a web app;
  a mobile web page added to the home screen covers most of it.
- **Contact enrichment from 25+ data providers** and the per-lead credits that pay for it.
- **Cvent badge scanning and event-badge printing** for organisers — partner deals.
- **Hardware manufacturing**. Deskzo can support any writable NFC tag (it only stores the card's
  link) without selling cards.
- **AI notetaker** (record meetings in person) — a separate product; not part of a card.
- **Blinq's copy, layouts, illustrations and brand**.

## Email signatures (Blinq and the team-signature tools)

Mapped from Blinq's signature pages (https://blinq.me/solutions/email-signature,
https://support.blinq.me/en/articles/76202-creating-a-team-email-signature) and its competitors' public
docs and pricing: Exclaimer, CodeTwo, WiseStamp, Letsignit, NEWOLDSTAMP, HubSpot's free generator.
The full comparison, and how each mailbox provider allows signatures to be set, is section 5 of
docs/digital-cards-and-signatures.md.

- **Blinq (S17):** tabs Details, Images, Links, Design, Banners, Settings; "Prevent editing";
  Bulk Create; Sync to Google. Image signatures by default (HTML on request); plain text on mobile; no
  Zoho; on Microsoft 365 an add-in each user must sign into — "not a silent push".
- **The market:** Exclaimer $0.90–1.75, CodeTwo $0.73–1.36, Letsignit $2, WiseStamp $1 + base, per
  user per month. All of them use an Outlook add-in for Microsoft 365, most add server-side routing.
- **Microsoft Graph cannot set a signature**, and Microsoft has no plans to add it; Gmail can
  (sendAs.update, domain-wide delegation); Zoho Mail has an admin signature API users cannot override.



Screens 20 (Deskzo needs about 9 of its own), flows 5, entities 10. Hard parts: Apple and Google
Wallet passes (signing certificates, issuer accounts), the public card page as a fast, private,
no-login page with a lead form that can't be abused, and keeping cards in step with the directory
and with leavers. Size: M for cards on their own (a few weeks).
