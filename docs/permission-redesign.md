# Permissions redesign — design note

**Status:** proposal, 8 Oct 2026. Nothing here is built yet. Section 11 lists the decisions needed before anything is.

---

## 1. The recommendation in one page

Every major CRM separates three questions. Deskzo should too:

1. **What may you do to a kind of record?** View, create, edit, delete, assign, import, export.
2. **Which of those records?** None, your own, your team's, your branch's, or all.
3. **Which fields on them?** Only for a short list of sensitive fields: cost and margin, contact details, salary, bank details.

On top of those sits a fourth, smaller list:

4. **Named business actions** that aren't "edit a record":
   - issue an invoice, which posts to the ledger and files with the government;
   - approve an order, never your own;
   - override a credit limit;
   - cancel an e-invoice;
   - merge companies;
   - close the books.

   Each keeps its own permission and a plain description of what it does.

The role editor becomes:

- **a grid** for the ~14 record types, where each cell is a level (None / Own / Team / Branch / All) or a tick, and cells that don't apply aren't drawn;
- **a list of named actions** under it, grouped by module;
- **a short field list** for the sensitive fields.

The menu is worked out from the grid. A section shows when the role can view anything in it, so the 41 separate section switches mostly go away.

What I **don't** recommend:

- **A full module × verb checkbox matrix with an "ALL" column**, as in the previous CRM. Most of its cells mean nothing, and its custom columns (FV_ASSIGN, CHANGE_FIELD) exist because generic verbs couldn't express real actions.
- **Field-level security on every field.**
- **Managers inheriting capabilities from their reports' roles.** Deskzo does this today; see section 7.

The engine stays: one resolver, server-side enforcement, audit, presets, view-as and the "why" explanation. What changes is the model the resolver reads and the screen admins use. Every change ships with today's behaviour as the default, so nothing changes until an admin changes it.

---

## 2. Where we are today

### What exists

- **116 permissions and 41 section switches**, 157 in all. Earlier I said "about 200"; this is the real count, from `src/lib/permissions.ts`.
- **Roles:** seven built-in (Profile, Calling, Sales, Support, Management, Accounts, Purchase), Admin, custom roles, and 16 presets (`src/lib/authz/presets.ts`).
- **Per-person grants and denials,** with a reason and an expiry.
- **The resolver** (`src/lib/authz/resolve.ts`). The first rule that fires decides:
  1. unknown key → deny;
  2. super admin → allow;
  3. inactive → deny;
  4. per-person grant or deny;
  5. the role's explicit tick or untick;
  6. **inherited from a report's role** (delegable keys only);
  7. otherwise deny.

### Which records you see

- **One idea for anything on an account:** a record belongs to whoever manages the account (`Company.ownerUserId`). You see your accounts and your reports' accounts. `companies.viewAll` lifts that (`src/lib/authz/company-scope.ts`).
- **Separate switches elsewhere.** Twelve modules each have their own "see everyone's": companies, visits, expenses, activities (calls/notes/meetings), targets, HR, assets, vault, feedback, marketing, projects, and the security log. There's also `forms.manageAll` and `workspace.manageAny`.

### The gaps

| Gap | Example |
|---|---|
| **Edit follows view** | Anyone who can see a company, contact or lead can edit it. A manager who can see the team's accounts can edit them all. There's no "see all, edit own". |
| **Create and delete are mostly ungated** | Creating a company, task or visit needs no permission; creating a lead needs only "View leads". Deleting a contact needs only the ability to see it. |
| **Scope is inconsistent** | Twelve different "view all" switches. Some areas have none: tasks show everyone's, and the Sales Wins leaderboard shows everyone's bookings. |
| **No branch level** | People and finance records carry a branch, but no rule can say "my branch's". |
| **"Own" is narrow** | Only the account manager counts. The caller assigned to a company (`assignedToUserId`) doesn't, which is why Calling has "see all companies" by default. |
| **Import/export is per area, not per record** | `data.exportCrm` exports companies, contacts and leads together. |
| **Two screens for one question** | Section switches hide the menu; view permissions guard the data. An admin has to untick both. |

The enforcement is good and shouldn't be thrown away: every read and write is checked on the server, refusals look the same as "not found", and there are check suites. The problem is the **model**: admins can't see or express the rules they actually want.

---

## 3. How others do it, and what to take

| Product | What you can do | Which records | Fields | Take from it |
|---|---|---|---|---|
| **Dynamics 365** | Create, Read, Write, Delete, Assign, Share, Append, per table | **Every privilege has a level**: User, Business Unit, Parent/Child BU, Organisation | Field security profiles | The core idea. A level per action means "see all, edit own" is one row. |
| **Salesforce** | Read, Create, Edit, Delete, View All, Modify All, per object | Company-wide default, then role hierarchy, sharing rules and account teams | Read/edit per field | The hierarchy grants **visibility, not capability**. Additive permission sets instead of per-user exceptions. |
| **Zoho CRM** | View, Create, Edit, Delete per module; Import, Export, Mass update, Change owner as separate tools | Role hierarchy plus private/public defaults and sharing rules | Hidden / read-only / read-write | Bulk tools as separate permissions, because they bypass row-by-row review. |
| **Freshsales** | Same verbs per module | Each set to owned by them / territory / all | Per field | The simplest admin experience of the lot: a level dropdown per cell. |
| **LeadSquared** | Role plus permission templates | Owner, sales-group hierarchy, or conditions on lead fields | Per field | Conditions are powerful but hard to reason about. Not for now. |
| **SAP** | Create, change, display, delete codes on authorisation objects, plus organisational fields | Sales org, territory, plant | Very fine | A warning: maximum flexibility, and nobody can administer it without a specialist. |

---

## 4. The model

### 4.1 Record types, and what "own" means for each

"Own" must be defined per record, because "owner" means something different on each. "Team" means the same relation through anyone in your reporting line below you. "Branch" means through anyone in your branch, or the record's own branch where it has one.

| Record | Own means | Branch from | Notes |
|---|---|---|---|
| Companies (customers) | account manager **or assigned caller** (new) | the account manager's branch | the parent of most rows below |
| Vendors & distributors | account manager | the account manager's branch | a separate row so purchasing can see them all while sales doesn't |
| Contacts | follow the account | — | child record |
| Leads | lead owner, or follow the account | the owner's branch | |
| Orders & subscriptions | the person who added it, or follow the account | the account's branch | |
| Sales documents | salesperson, or follow the account | document branch | `TradeDocument.branchId` |
| Purchase documents | creator | document branch | |
| Payments | follow the account | payment branch | `Payment.branchId` |
| Tickets | assignee or creator, or follow the account | the assignee's branch | |
| Projects | manager or member | the manager's branch | |
| Visits | the person visiting | their branch | |
| Calls, notes & meetings | who logged it or organised it | their branch | today's `activities.viewAll` |
| Tasks | assignee or creator | the assignee's branch | **no scope at all today** |
| Expenses | the claimant | their branch | |

A **child record** (contacts, and by default leads, orders, documents, payments and tickets) can be set to **"Follow the account"**. You then see it exactly when you see its company. Salesforce calls this "controlled by parent". It's the default, because it's what Deskzo does today.

### 4.2 Columns, and which take a level

| Column | Kind | Notes |
|---|---|---|
| View | level | |
| Create | tick | Creating something you'd then own needs no level. |
| Edit | level | Can't be wider than View. |
| Delete | level | Can't be wider than Edit. Off by default for everyone but admins. Prefer archiving where the record has history. |
| Assign | level | Change owner, hand to someone else. "Own" means hand off your own; "Team" means reassign within the team. Replaces `leads.assign`, `accounts.reassign` and `accounts.handOffOwn`. |
| Import | tick | Bulk create and update. Separate from Create because nobody reviews it row by row. |
| Export | tick | The way data leaves the company. Always logged; ties into the Security module's watermarking and bulk-read limits. |

A cell that means nothing isn't drawn: no Import on calls, no Assign on expenses.

**There's no "Read" separate from "View", and no "Read-own" column.** Read-own is the "Own" level, and it applies to Edit, Delete and Assign as well.

### 4.3 Levels

`None` → `Own` → `Team` → `Branch` → `All`, and "Follow the account" for child records.

Two rules:
- A wider level includes the narrower ones.
- Edit ≤ View, Delete ≤ Edit, Assign ≤ Edit. The editor won't let you set Edit wider than View.

### 4.4 Named actions

These stay as they are, one permission each with its description, grouped by module under the grid:

- **Sales:** issue sales documents, email them, delete or cancel them, override credit, collections follow-up, merge companies, manage pipeline stages, manage forecast, manage wins, schedule meetings, broadcast notes.
- **Orders:** approve orders, process and fulfil, approve a loss-making order, rebates.
- **Finance:** post to the ledger, close the books, revenue recognition, reconcile vendors, approve and reimburse expenses.
- **People:** approve leave, run payroll, handover.
- **Marketing:** send, approve, manage.
- **Administration:** users, roles, security, backups, settings, custom fields, impersonation.

**Approvals are named actions, not a column.** Who *may* approve is a permission, and you can never approve your own. That's the existing `selfExcluded` rule, kept. *When* approval is needed (amount limits, discount limits) is workflow configuration and stays out of the permission model. Deskzo already works this way for documents (`approval-policy.ts`).

### 4.5 Field access

A curated list, never every field. Each is Hidden, Read or Edit per role:

- purchase price, margin and savings;
- contact phone and email (today `contacts.view` redaction and the reseller rule);
- restricted custom fields (today `fields.seeRestricted`);
- salary and payroll figures;
- bank details.

### 4.6 The menu

The menu shows a section when the role has View above None on any record in it, or holds any named action in it. The 41 section switches remain only for modules with no records (Help, Wins, Forecast and similar).

### 4.7 Roles, bundles and exceptions

- **A person has one role.** It sets the grid, the named actions and the fields.
- **Bundles are named, additive add-ons** that can be given to a person on top of their role, such as "Collections" or "Finance read-only". This is Salesforce's permission sets, and it replaces most per-person grants.
- **Per-person exceptions** stay for the rare case. A deny is shown with its reason and expiry, and the Staff screen lists every person who has an exception.
- **The new order of rules:**
  1. super admin;
  2. inactive;
  3. per-person exception;
  4. role + bundles, where the widest level wins;
  5. deny.

  **No inheritance of capabilities from reports.** The reporting line only decides what "Team" means.

### 4.8 What is not a permission

- Whether a module is in the plan (entitlements).
- Whether it's switched on for the company (Settings › Modules).
- Approval thresholds.
- Number series, branch defaults and other configuration.

These keep their own screens. A role screen that also tried to express them would become SAP.

---

## 5. Example: four roles filled in

`—` means the cell isn't drawn. `✓` means ticked; a blank tick column means not ticked.

**Sales executive**

| Record | View | Create | Edit | Delete | Assign | Import | Export |
|---|---|---|---|---|---|---|---|
| Companies | Own | ✓ | Own | None | Own | | |
| Contacts | Follow | ✓ | Follow | Own | — | | |
| Leads | Own | ✓ | Own | None | Own | | |
| Orders | Follow | ✓ | Own | None | — | | |
| Sales documents | Follow | ✓ | Own | — | — | | |
| Calls, notes & meetings | Own | ✓ | Own | Own | — | — | |
| Tasks | Own | ✓ | Own | Own | Own | — | |

**Sales manager:** as above, with View, Edit and Assign at **Team**, Export on leads, and the named action "approve a loss-making order".

**Calling agent**

| Record | View | Create | Edit | Delete | Assign | Import | Export |
|---|---|---|---|---|---|---|---|
| Companies | All | ✓ | Own *(as caller)* | None | None | | |
| Contacts | Follow | ✓ | Follow | None | — | | |
| Leads | Own | ✓ | Own | None | Own *(hand to a salesperson)* | | |
| Orders, documents, payments | None | | None | None | — | | |
| Calls, notes & meetings | Own | ✓ | Own | None | — | — | |

Named action "schedule meetings" is off. This is the role you configured by hand today; under this model it reads as one screen.

**Accounts executive:** Companies All, documents and payments View/Edit All, the named actions "issue" and "post to ledger", and Export on finance records.

---

## 6. Today's permissions mapped onto the model

| Today | Becomes |
|---|---|
| `companies.viewAll` | Companies › View = All (otherwise Team, as today) |
| `contacts.view`, `leads.view`, `orders.view`, `payments.view`, `documents.view`, `projects.view`, `calls.view`, `visits.view`, `tickets.view`, `emails.view` | View on that row = Follow the account (or None if unticked) |
| `visits.viewAll`, `expenses.viewAll`, `activities.viewAll`, `targets.viewAll`, `hr.viewAll`, `assets.viewAll`, `vault.viewAll`, `feedback.viewAll`, `marketing.viewAll`, `projects.viewAll`, `forms.manageAll`, `workspace.manageAny` | View = All on that row (otherwise Team or Own, as today) |
| `products.edit`, `products.delete`, `tasks.delete`, `tickets.delete`, `payments.delete` | Edit / Delete on that row |
| `tickets.create`, `forms.create` | Create on that row |
| `leads.assign`, `accounts.reassign`, `accounts.handOffOwn` | Assign on companies and leads (handOffOwn = Own, reassign = Team or All) |
| `data.import*` / `data.export*` (5 areas each) | Import / Export on each row in that area |
| `contacts.viewRestricted`, `fields.seeRestricted` | Field access |
| `activity.viewAll`, `activity.export` (the security log) | Administration named actions (not activity on records) |
| Everything else (~60) | Named actions, unchanged keys |
| 41 `section.*` switches | Worked out from the grid; kept only for modules without records |

The backfill sets every role to exactly what it can do today, including the gaps. For example, edit stays as wide as view until an admin narrows it. The migration report lists every gap the new defaults would close, so turning one off is a choice, not a surprise.

---

## 7. Where I'd change behaviour, and why

1. **Stop managers inheriting capabilities from their reports' roles** (rule 6 of today's resolver).
   - Today a sales manager whose report is in Accounts quietly gains that report's delegable actions. That's a privilege nobody granted, and it doesn't show on the manager's role.
   - None of Salesforce, Dynamics or Zoho does this. Their hierarchies give **visibility** only.
   - The reporting line should mean "Team" and nothing more.
   - The migration report will list who'd lose what, so anything genuinely needed becomes a bundle.
2. **Separate Edit from View.** "See the whole team's accounts, edit only mine" is the most common rule in sales, and Deskzo can't express it today.
3. **Gate Create and Delete.** Creating a company is open to everybody today, and a lead to anyone who can see leads. Deleting should be rare and mostly limited to admins.
4. **Scope tasks** like everything else. Today everyone sees every task.
5. **Count the assigned caller as "own"** on a company. It's what lets Calling stop needing "see all companies".
6. **No "ALL" column**, and no role ships with everything ticked except Admin.

---

## 8. How it's enforced in code

- **One function per question.**
  - `access(user, record, action)` returns a Prisma `where` fragment for lists (or `{}` for All).
  - `mayAct(user, record, action, row)` answers for one row on detail pages and actions.
  - Both read one table: role × record × action → level, plus bundles and exceptions.
  - These replace `companyScope`, `viaCompanyScope`, `scopeWhere`, the twelve `*.viewAll` checks and most `canSeeCompany` calls.
- **Every relation written once.** The "own" relations from 4.1 live in one registry, with the path to the owner for each record. That's today's `SCOPE_ANCHORS`, grown up. Section 2 says why this matters: a filter that is too wide is never reported by anybody.
- **Refusals stay the same.** A list leaves rows out; a detail page answers 404; an action returns "doesn't exist" for records out of scope.
- **Named actions keep `can(user, key)`** exactly as today.
- **Tests:**
  - One suite per record type, generated from the registry: for each level, a probe user sees and edits exactly the right rows.
  - The effective-access snapshot from phase 0 runs before and after every phase.

---

## 9. Migration, in phases

Each phase ships on its own, and none changes what anyone can do unless an admin changes it.

| Phase | What | Size |
|---|---|---|
| **0. Snapshot** | A script that writes every user's effective access (keys, and record counts per type) to a file. Run before and after each phase; the diff must be empty unless intended. | S |
| **1. Levels underneath** | The level table, `access()` / `mayAct()`, the relation registry, and a backfill that reproduces today exactly. Companies, leads, contacts, orders, documents and payments move onto it; the old `*.viewAll` keys become read-through aliases. | L |
| **2. The role editor** | The grid, the named-action list and field access on Staff & roles. "Compare roles", and "why can X do Y" using the resolver's existing explanation. | M |
| **3. The rest of the records** | Tickets, projects, visits, calls/notes/meetings, tasks and expenses. Tasks get a scope for the first time. | M |
| **4. Close the gaps** | Edit separated from View, Create and Delete gated, assigned caller as "own", Branch level. Each one arrives as an admin choice, with the migration report showing who it affects. | M |
| **5. Retire the old** | Downline capability inheritance (after the report), section switches for modules with records, and the `*.viewAll` aliases. | S |

---

## 10. Risks

- **A filter that is too wide is silent.** Mitigated by the single registry, the generated per-record suites and the snapshot diff.
- **Admins over-granting through a friendlier screen.**
  - Mitigated by Delete off by default, no ALL column, exceptions listed in one place, and sensitive named actions marked.
  - `tier: "sensitive"` already exists and can carry over.
- **Performance.** A level lookup per request is one cached read. "Team" and "Branch" become `IN (...)` lists over people, which is what `companyScope` does today.
- **Two models during migration.** The old keys keep working as aliases until phase 5, so nothing has to switch over in one go.

---

## 11. Decisions needed from you

1. **Should the assigned caller count as "own" on a company?** I recommend yes.
2. **Branch level.** Does "my branch" for customers mean the account manager's branch? I recommend yes. The alternative is giving companies their own branch field.
3. **Retire capability inheritance from reports** (section 7.1)? I recommend yes, after the report.
4. **Delete.** Admins only by default, with soft delete (archive) where a record has history? I recommend yes.
5. **Vendors as their own row,** separate from customers? I recommend yes.
6. **Per-person exceptions.** Keep them, but steer people to bundles? I recommend yes.
7. **Order of phases.** Start with phase 0 and 1 on companies and leads, where most of today's questions come from?

**Decided 8 Oct 2026: yes to all seven.** Phases 0 and 1 were started the same day.

---

## 12. Status: phases 0 and 1

### Phase 0: the snapshot (done)

`npm run access:snapshot` records, for every person in the workspace:
- every permission they hold;
- for customers, vendors, contacts, leads, orders, documents and payments, the rows their list shows, as a count and a fingerprint of the ids;
- which account managers' customers, and separately vendors, they can open one at a time;
- whose records each "see everyone's" permission reaches.

It also records what every role grants on its own, so a role nobody holds is still covered.

`npm run access:snapshot -- --compare` compares the latest two snapshots and names exactly who gained or lost what. A baseline was taken before any engine code, and a second snapshot straight after it was identical.

The first version of `scripts/access-snapshot.ts`, which printed permissions to the screen for diffing by hand, was replaced. `scripts/visibility-snapshot.ts` (counts only) still exists, but its coverage is a subset of this one's.

### Phase 1: levels underneath (built)

| Piece | Where |
|---|---|
| The two tables and the `AccessLevel` enum | `prisma/migrations/20261030100000_access_levels` — expand-only, nothing existing changes |
| The engine: record types, what "own" means for each, resolution, fragments, single-record checks | `src/lib/authz/access.ts` |
| The old account helpers answered by the engine, same names and shapes | `src/lib/authz/company-scope.ts` |
| Single-company checks take the company (owner **and** type), so customers and vendors can differ | `canSeeCompany(userId, account)` — 61 call sites |
| Record-level reads | lead, order/renewal, document and payment lists; their detail reads and pages; the company page's tabs; contact scope |
| Record-level writes | leads and contacts only (see below) |
| Proof | `npm run check:access-levels` (every level, every record, list = one-by-one); snapshots identical before and after |

**Where a level comes from:**
1. Super admin → All.
2. Inactive or the Automation account → None.
3. The person's own level.
4. The role's level.
5. **Derived from today's permissions.**

Rule 5 is why nothing changed for anybody. "See all companies" derives All, and a view permission derives "follow the account". A workspace whose database hasn't got the tables yet counts as having none stored.

**Deliberately not in phase 1:**
- **Order, document and payment writes keep today's checks.** Some of them ask only about the account; others ask nothing at all beyond the permission (listed below). Tightening them narrows what someone can do, so it's an owner decision, not part of "nothing changes".
- **Screens that cut across modules stay on the account rule until phase 3:** dashboard, analytics, forecast, exports, receivables, payables, statements, collections, revenue, rebates, e-way bills, tax reports, and payments shown against orders.
- **No screen or action sets a level yet.** That is phase 2, the editor. Until then only the check suite stores levels, under a probe role of its own.

**Intended differences** (every other answer was proved unchanged by the snapshots):
- **A deactivated person and the Automation account now reach nothing.** The old account helper never asked whether someone was active, so a deactivated person still technically reached their old team's accounts. No signed-in request can come from them.
- **Platform support on a read-only grant can no longer change leads or contacts.** Those writes asked only "can you see it", so a read-only grant could edit them, which was a bug. Adding a contact now asks what editing one does.
- **Two refusals that no screen offered:**
  - Scheduling a meeting from a contact now needs "View contacts".
  - An order's page answers 404 straight away without "View orders". Before, it rendered the notice later and, for a non-canonical address, redirected to the order number first.
- **Company lists now combine the account rule with their own search and category filters inside an AND.** Today's results are identical. This stops one overwriting the other once customers and vendors have different levels.

### Found along the way

**Personal grants from the demo seed override role settings.** `prisma/demo/people.ts` gives every demo person their job's preset as personal grants (`UserPermission`, no reason) rather than role settings. A personal grant beats the role, so unticking something on a role has no effect on seeded people.

For example, the Calling role has orders, documents and payments unticked, yet all six active callers still hold them.

**Removed on 8 Oct 2026 at the owner's request:** all 1,120 such grants (backed up under `access-snapshots/`).
- The seed's 9 grants that carry a reason were kept. They are its deliberate examples of individual exceptions.
- Reseeding would bring the 1,120 back.
- Sales executives and sales managers share one role, so the managers' extra abilities need a role of their own.

**Writes that check a permission but not the account (bugs, not choices):**
- `setVendorStatus` checks nothing beyond sign-in.
- `addCompanyProduct` checks no account.
- `updateCompanyProduct` and `removeCompanyProduct` check a permission only.
- `approveOrder` and `fulfillOrder` check a permission only.
- Every trade-document write checks a permission only: create, update, delete, issue, IRN, convert, status.
- `recordPayment`, `allocatePayment`, `deletePayment` and `clearCheque` check a permission only.
- `payablesAging`, `listOpenBills`, `vendorStatement` and `getBillSettlement` check only that the module is on.
- `unclearedCheques` checks only that accounting is on.

Each is reachable by a direct action call with an id from another account. Closing them is the next recommended change. Purchase bills need care: their vendor parties are often unowned, and unowned companies are hidden from anyone who doesn't reach every account.
