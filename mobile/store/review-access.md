# Google Play — App access (for the reviewers)

The app does nothing until it is signed in to a Deskzo account, so Play Console (App content › App access)
must say how a reviewer gets in. They sign in in the app with a demo account — through the phone's browser,
no computer needed.

## Before submitting — on the live platform

1. A demo workspace with sample customers, contacts and leads (the console's demo seed), e.g.
   `appreview.deskzo.com` — never a real customer's.
2. In it, a user for Google, e.g. `play-review@deskzo.com`, role Sales, with a strong password, no
   two-factor, and no IP rule or device approval that would stop them.
3. One of the sample contacts with a number the reviewer can call from, or be called by — note it below.
4. `DESKZO_APP_ANDROID_URL` (or `DESKZO_APP=on`) set on the server, so Settings › Deskzo app is there.

## Instructions to paste (App access → "All or some functionality is restricted")

> The app works with a company's Deskzo account. Use this demo account:
>
> 1. In the app, type the address *appreview.deskzo.com* and tap **Sign in**.
> 2. In the page that opens, sign in — email: *play-review@deskzo.com*, password: *(the password)* — and tap **Allow**.
> 3. On Calls, turn on call sync and allow the permissions.
> 4. Call, or be called from, the demo contact's number *(number)* — the caller's name shows while it rings, and "How did the call go?" appears after.

Keep the account and the sample data in place while the app is in review, and for later updates.
