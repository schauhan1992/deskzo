# Google Play — App access (for the reviewers)

The app does nothing until a phone is paired with a Deskzo account, so Play Console (App content › App
access) must say how a reviewer gets in. Pairing codes last ten minutes and work once, so the reviewer makes
their own from a demo account.

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
> 1. On a computer, open https://appreview.deskzo.com and sign in — email: *play-review@deskzo.com*, password: *(the password)*.
> 2. Go to Settings › Deskzo app and choose **Show a pairing code**.
> 3. In the app, choose **Scan the code** (or type the address appreview.deskzo.com and the ten-character code).
> 4. Turn on call sync and allow the permissions.
> 5. Call, or be called from, the demo contact's number *(number)* — the caller's name shows while it rings, and "How did the call go?" appears after.

Keep the account and the sample data in place while the app is in review, and for later updates.
