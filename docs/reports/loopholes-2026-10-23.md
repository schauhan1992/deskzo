# Loophole review — 23 Oct 2026

How a signed-in user, a customer's admin, or an anonymous visitor could break Deskzo or get more than they should.
Two parts: the existing security suites run as they are, and a read-only review of what they don't cover — inside one
workspace, the public pages, injection and files, billing, and the phone app and API.

**✓** = confirmed by reading the code path end to end in this review. Unmarked = reported by the review with file and
line, not yet re-traced. Nothing here was tried against the live site.

## Fixed the same day

Every finding below is fixed in code except where this section says otherwise; each fix carries a "security review,
23 Oct 2026" comment where it was made. `npm run check:loopholes` covers the ones checkable without a server.

**Needs doing on the live server:** set `TRUST_PROXY_CLOUDFLARE=1` (finding 9; docs/deploy-coolify.md), then check that
Settings › Security's activity log shows visitors' own addresses.

**Changes people will notice:**
- Leads export now needs "Export CRM data", which no role holds by default — give it to the roles that export.
- Marking your own attendance directly needs `hr.manage`; everybody else asks for a correction.
- A second free trial for the same mailbox (case, "+tags" and Gmail's dots ignored) is refused unless an invitation is used.
- Helpdesk replies through Deskzo's own mail: at most 200 recipients a person and 1,000 a workspace a day.
- Two AI answers at once per person, eight per workspace, per server process; a turn the caller abandons is still charged.
- A workspace's SMTP server must be on a public address and a mail port (25, 465, 587, 2525).
- Phones are signed out with the person's other sessions (password reset, End session) and after 90 days unused.
- A refused clock-in says the distance rounded (100 m under a kilometre, whole kilometres beyond).
- Pairing links fill in the app's form instead of pairing at once; a QR scanned in the app still pairs at once.

**Left as they were, on purpose:**
- Attendance location and the phone/tablet kind are still what the app reports; only device attestation (Play Integrity
  / App Attest) would change that.
- Seats: the user import adds people one row at a time outside a transaction, so it keeps the quick check only; adding,
  switching back on and converting a candidate take the seat under a lock. A restore over the seats tells whoever
  manages billing — nobody is switched off automatically.
- A Razorpay cancel that leaves an add-on without its base isn't refused: the add-on simply brings nothing then.
- Design questions for the owner and Himanshu, not holes: the forecast's money for CALLING/PROFILE, and a permission
  for editing item prices and tax rates.
- check:tenancy still lists two older entries from other work (src/lib/ai/accounts.ts testRoute,
  src/lib/portability/importers/leads.ts shared).

## The suites, run as they are

| Suite | Result |
|---|---|
| `pentest` (cross-workspace) | 79 of 79 attacks blocked |
| check:security, tenancy-isolation, auth-tenancy, auth-host, rbac, permission-gates, module-guards, entitlements, access, public-api, forms, app-daily, app-chat, domains, domain-edge | all passed |
| check:portal | passed until "The roster", where the suite's own session stub misses a top-level import (the real `auth()` runs outside a request) — a test fault, not a hole; its last section didn't run |

## High

1. **✓ Unlimited password and authenticator-code guessing.** The 8-tries lockout is in `checkCredentials`
   (src/actions/auth.ts:53), which the sign-in page calls first; the real sign-in, `loginAction` → `authorize`
   (src/lib/auth.ts:54), has none. A script calling the sign-in action directly guesses without limit — passwords, then
   the 6-digit code — while its own failures through the page lock the real person out. *Fix:* enforce the account and
   caller lockout, TOTP failures included, inside `authorize`.
2. **✓ Phones stay signed in after a password reset.** `appRoute` (src/lib/app/handler.ts:139) checks only the phone's
   secret, its device status and the person's active/locked flags; a password reset or "End session" ends web sign-ins
   only. Someone who paired a "phone" with a stolen password (plain HTTP, no phone needed) keeps access, and
   `/api/app/web-session` mints fresh web sessions from it. *Fix:* revoke the person's app devices when sessions are
   ended (or tie each to its SignIn row and check `endedAt`); give phone tokens an idle/absolute lifetime.
3. **✓ Any signed-in person can rewrite or delete any company's addresses and GSTIN.** src/actions/company-location.ts
   add/update/set-primary/delete check only `requireUser()`. Tax invoices are built from these. *Fix:* require edit
   access on the company in all four; scope `locationsFor` (src/actions/it-asset.ts:550) too.
4. **✓ Any employee can mark their own attendance.** `canMarkFor` (src/actions/attendance.ts:38) returns true for
   oneself, so `markAttendance` turns an absent day PRESENT (no loss of pay) or ON_LEAVE (leave without a request or
   balance), past the geofence and regularisation approval. *Fix:* self-marking needs `hr.manage`; everyone else uses
   regularisation.
5. **✓ A calling list hands a rep every company with its contacts.** `startCallingActivity`
   (src/actions/calling-activity.ts:54) loads companies with the list's filters but without `companyScope`, and
   `myCallingQueue` then shows them with emails and phones — reseller customers included. *Fix:* AND the caller's
   `companyScope` into that query.
6. **✓ An add-on paid without its base product unlocks the base (Razorpay).** Each checkout line is its own Razorpay
   subscription (src/lib/billing/checkout.ts:163); paying only the add-on's page, or cancelling the base later
   (`cancelAtPeriodEnd`, :295), leaves the add-on live, and `entitlementsFrom` adds every live plan's `requires`
   (src/lib/platform/entitlements.ts:160) — Revenue & Close alone brings all of accounting. *Fix:* drop add-on modules
   no live edition supports; refuse a cancel that strands add-ons.
7. **✓ AI answers cut off by the client are never charged.** The copilot route passes `request.signal`
   (src/app/api/copilot/chat/route.ts:62); on abort `aiTurn` rethrows before `chargeTurn` (src/lib/ai/gateway.ts:103).
   A script reads the streamed answer and disconnects at the end: Deskzo pays the provider, the workspace pays nothing,
   and the daily cap never moves. *Fix:* don't tie the provider call to the client's signal; charge from the stream's
   usage on every ending.
8. **✓ Unlimited free trials** (once signup opens). `startSignup` (src/actions/platform/signup.ts:200) never asks whether
   the email, company, GSTIN or phone already had a trial; each gets 25 seats and 200 AI credits a month. *Fix:* refuse
   a second trial by normalised email / verified phone / GSTIN, or start repeats without AI credits; add a CAPTCHA.

## Medium

9. **The visitor's address behind Cloudflare is Cloudflare's.** With `TRUST_PROXY_HOPS=1` and Cloudflare → Traefik, the
   last X-Forwarded-For entry is a Cloudflare edge, so lockouts are shared by everyone behind that edge and IP rules see
   Cloudflare addresses (src/lib/client-ip.ts:24). *Check live:* the security activity log's sign-in addresses — 104.x /
   172.6x are Cloudflare's. *Fix:* HOPS=2 with Traefik trusting Cloudflare's ranges, or CF-Connecting-IP only from
   Cloudflare peers.
10. **✓ A workspace admin can probe the server's internal network.** The marketing SMTP provider connects to whatever
    host and port is typed (src/lib/marketing/providers/email.ts:159-199) and the error says whether it answered or
    refused — a port scan of the Docker network (the database included). *Fix:* refuse private/loopback addresses (as
    `safeFetch` does), allow only 25/465/587/2525, and stop echoing the server's replies.
11. **✓ The phone app's in-app browser trusts look-alike addresses and hands them GPS.** `url.startsWith(origin)`
    (mobile/src/app/web.tsx:92) accepts `https://acme.deskzo.com.evil.tld` and `https://acme.deskzo.com@evil.tld`
    (and `data:`), shown without an address bar, with `geolocationEnabled`. *Fix:* compare `new URL(url).origin`
    exactly; drop `data:`; location for the workspace only.
12. **✓ Seat limit can be overrun.** Count-then-insert with no lock (src/lib/seats.ts:23): parallel adds all pass, and
    restoring an older backup brings back switched-off people without a seat check. *Fix:* lock around check-and-insert;
    re-check after a restore or a seat reduction.
13. **"View as" gives an admin powers personally denied to them** (src/actions/impersonation.ts:33) — only the
    super-admin tier is compared. *Fix:* `mayPassOnSetupLink(actor, target)` when starting and resolving view-as.
14. **Planning a visit skips the account scope** (src/actions/visit.ts:178, :248; src/lib/calendar/records.ts:133) — walks
    company numbers to names, contacts, emails and phones.
15. **An employee with no HR record writes their own joining date and designation** (src/actions/hr.ts:240 — the upsert's
    `create` branch) — feeds leave accrual, gratuity and letters.
16. **IT assets' "own only" scope can be overridden** by a `custodianUserId` filter spread after it
    (src/actions/it-asset.ts:83-87).
17. **The lead CSV export skips `data.exportCrm`**, its row cap and the export log (src/actions/lead.ts:853).
18. **Order notices read and email any order's customer contacts** (src/actions/order-notice.ts:21-50).
19. **Public forms have no rate limit** (`submitForm`, src/actions/marketing-public.ts:370; `sourceHash` computed, never
    queried) — endless companies, contacts and leads, attachable to an existing customer by name.
20. **Helpdesk replies send unlimited mail through Deskzo's address** (src/actions/support-mail.ts:399 →
    `sendPlatformMail` type SUPPORT, no daily limit).
21. **Parallel AI requests overdraw credits without bound** (src/lib/ai/gateway.ts:38 checks, reserves nothing).
22. **Attendance location and phone/tablet kind are whatever the app says**, and a refused clock-in returns the exact
    distance (src/lib/app/daily.ts:76), which pins the office point. Known in the code; device attestation is the real
    fix — at least return "outside" without a distance.

## Low

- **✓ Open redirect at `/access?next=/%5Cevil.com`** — `safeNext` (src/app/(auth)/access/page.tsx:26) misses `/\`; use
  `safeAppPath`.
- A revoked phone can be approved again, and its old secret works (src/actions/access-control.ts:531).
- The live chat stream keeps a revoked phone's messages coming for up to 20 minutes (src/app/api/app/chat/stream/route.ts:46).
- Eight junk requests from one office network lock every phone behind it out of the app (src/lib/app/handler.ts:117).
- API keys keep working after their owner loses `api.manage`; `security.manage` alone can't list or revoke them.
- The ALERT network rule isn't honoured for the app or the API.
- A `deskzo://pair?host=…` link pairs the app to any server without asking.
- Marketing template zip: sizes from the zip's own headers, so a zip bomb inflates in full (src/lib/marketing/template-upload.ts:82).
- Chat, task and HR-document downloads fail with a 500 on non-Latin file names; HR documents lack `nosniff`/sandbox headers.
- CSV formula guard misses a leading tab/CR (src/lib/csv.ts:5); custom-field header cells unescaped in two exports.
- Anyone with `feedback.request` can withdraw any feedback request, including one about themselves.
- Document approval: an approver can approve a document they wrote if a colleague submits it.
- Document-mail daily allowance can be raced; a partner can refer their own business.
- Design questions rather than holes: the forecast shows money to CALLING/PROFILE presets; nothing guards editing item
  prices and tax rates.

## Not covered this time

The public-pages review stopped before reporting on signup and the platform site's forms, booking pages, inbound
helpdesk email and the biometric `/iclock` endpoint. Those want their own pass.
