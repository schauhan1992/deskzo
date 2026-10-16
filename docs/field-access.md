# Field access, unmasking and the unmasking log

What a person sees of a lead's sensitive fields, how they unmask one, how many they may unmask a day, and the log a super admin reads. The policy rules are in `src/lib/authz/field-policy.ts`; how they're applied to leads is in `src/lib/leads/masking.ts`.

## The fields

| Field | Key | Masks it offers | Example |
|---|---|---|---|
| Lead name | `title` | first letter, stars | `A********` |
| Company name | `companyName` | first letter, stars | `A********` |
| Contact name | `contactName` | first letter, stars | `R********` |
| Email | `email` | email, first letter, stars | `s*****@g***.com` |
| Phone | `phone` | country code and last four, country code only, stars | `+91 ******4321` |
| Address | `address` | stars, city only, first letter | `********, Pune` |
| Lead source | `source` (and its particulars) | stars, first letter | `********` |
| Enquiry details | `description` | first letter, stars | `W********` |
| Each custom field on leads | `custom:<key>` | as its type: an email, phone or text field's masks | `********` |

Every mask is a fixed eight stars, so a mask never gives away how long the value is.

## A policy

Each field has five settings, for a role (`role_field_policies`) or for one person (`user_field_policies`, with a reason and an optional end date):

- **View field.** Off means *restricted*: the value is never sent. The word "Restricted" goes in its place, and the field can't be searched, filtered or edited.
- **Mask in list.** Applies to lists, boards, pickers, search results, dashboards, reports, exports and previews in other modules.
- **Mask in detail.** Applies to the lead's own page.
- **Allow unmask.** Whether opening the lead shows it in the clear for the rest of the business day.
- **Mask format.** One of the masks in the table above.

Masking never grants reading: a field can't be masked or unmasked if it can't be viewed. With nothing set, a field is visible and unmasked, exactly as it was before field access existed.

**Precedence** (`resolveFieldPolicies`):

1. The super admin sees everything.
2. A deactivated account sees nothing.
3. A person's own unexpired policy applies.
4. Otherwise their role's.
5. Otherwise the field is open.

**Who may change it.** The same rule as permissions: nobody gives anyone more than they see themselves (`withinPolicy`). A daily limit can't be raised above the giver's own (`limitWithin`). Nobody changes their own. Only the super admin changes the super admin's. Every change is written to the permission history as `field:leads:<field>` or `unmask:dailyLimit`.

## Where it's applied

Everything runs on the server before a value is put in a response. Nothing is masked in the browser.

- **Leads:** the list, the board and the split view (`listLeads`, `listLeadsPaged`); the header search (`search.ts`); and the CSV export.
- **The lead's own page** (`getLead`): its contact, email, phone, address, source, description and custom fields. A field that is masked or restricted there can't be edited until it's unmasked: the title, description, contact and custom fields are all locked.
- **Lead previews elsewhere:** tasks, visits (and the visit form's lead picker), calls, notes, expenses, forms, documents, proposals, the order punch, chat record cards, the calendar's labels, the dashboard, the forecast, a company's Leads tab, the workspace export and analytics.
- **Free text that quotes a lead's fields** (`leadRedactor`), for example a meeting called "Kinetic Logistics — AutoCAD renewal" or a description "Redwood Infra: intranet build". Each concealed value is replaced wherever it appears:
  - in the lead's own description, source details, lost reason and assignment note, wherever the lead is read;
  - on the lead's page, in its activity notes, tasks, visits, documents and meetings;
  - in won-deal celebrations (the splash, the greeting strip and the wins wall).
- **Search and filters** match only what the person sees in the clear in a list. Matching a masked value would reveal what it holds.

## Unmasking, and the daily limit

Opening a lead's page is the request to see it: `LeadUnmask` asks `unmaskLead` once per visit. The request is made when the page is mounted, not when it renders, so a link prefetching the page spends nothing.

- **Repeat visits are free.** A lead unmasked once is clear for that person for the rest of the business day, and unmasking its email, phone and company together counts once.
- **The business day is the workspace's.** It runs from midnight to midnight in the workspace's time zone (`workspaceClock().dateKey()`), not the server's or the browser's.
- **The limit counts different leads per person per day.**
  - **Where it's set:** on the role, or as the person's own limit, which can remove their role's limit.
  - **Range:** blank means no limit; the highest is 10,000.
  - **Where it's stored:** `unmask_usage`, unique per person, day and lead.
- **Two tabs can't both take the last unit.** `attemptUnmask` takes a transaction-scoped advisory lock on (person, day), counts, then inserts. The log row is written in the same transaction.
- **Possible results:**
  - `ALLOWED`: one unit used;
  - `REPEAT`: already unmasked today, nothing used;
  - `QUOTA_EXHAUSTED`: the limit is reached and the fields stay masked;
  - `DENIED`: the person may not unmask, can't open the lead, or is being viewed as by an admin. Under view-as, the admin's request is refused and logged with who was really at the keyboard.

## The unmasking log

**Settings › Staff & security › Unmasking logs.** Every attempt is listed, with filters for when, who, lead and result. It is paged and can be exported to CSV.

- **Who can read it:** the workspace's super admin, acting as themselves (`actingAsSuperAdmin`). Nobody else can, not even another admin, and not even the super admin while viewing as somebody.
  - **Every action checks this again:** `mayReadUnmaskLog` runs on each call.
  - **The menu entry is hidden from everybody else.**
  - **A refused export is itself logged.**
- **It holds no values.** A row records:
  - the person and who was viewing as them;
  - the lead's id and number, and the names of the fields concerned;
  - the result, whether a unit was used, the count, and the limit at the time;
  - the request id, the IP address and the browser.
- **Nobody can change or remove a row.** A trigger refuses `UPDATE` and `DELETE` on `unmask_events`. The workspace data reset empties the table with `TRUNCATE`, as it does every other table.

## What it doesn't cover

These are known, deliberate boundaries:

- **Accounts, contacts, calls and visits are records of their own.**
  - A lead's company is a company and its email and phone are its contact's. A role that can still open companies or contacts, or see calls and field visits, sees them there in the clear.
  - The role's Field permissions tab warns which of these the role still reaches. For a role that should only work masked leads, set those record levels to None.
- **Text written about a lead somewhere else, and shown there**, is stored as it was written and isn't masked:
  - notifications;
  - the activity log's record labels;
  - meeting titles in the calendar itself;
  - email subjects in the mail log.
- **The domain panel** on a lead's page shows the company's website. Websites aren't one of the sensitive fields.
- **A referral's particulars** ("Referred by X at Y") name the referrer's company. They're shown unless Lead source is masked.

## Migrations

All are additive.

- `20261110100000_field_access_unmask`: the policy, limit, usage and log tables, the `roles.active` column, and the append-only trigger.
- `20261110110000_role_activation_history`: the role switched off/on history kinds.
- `20261110120000_retire_report_inheritance`: makes inherited permissions explicit. See `docs/permission-redesign.md`, phase 5.

**Switching masking off** for a role means clearing its policies, on screen or by deleting its `role_field_policies` rows. Nothing else depends on them.
