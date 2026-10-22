# App Store listing — Deskzo

Everything here is what the iPhone app does today (the day's work, team chat, calling as iOS allows it, and all of
Deskzo's pages). It differs from Google Play's (`listing.md`) where the iPhone does: calls are logged from a word after
the call, not read from the call log. Change it with the app.

| Field | Value |
|---|---|
| Name (30) | Deskzo |
| Subtitle (30) | Calls, tasks and approvals |
| Bundle ID | `com.deskzo.app` |
| SKU | `deskzo-ios` |
| Primary category | Business |
| Secondary category | Productivity |
| Price | Free — no in-app purchases |
| Age rating | 4+ (the questionnaire: none of the content it asks about) |
| Copyright | © 2026 Deskzo |
| Support URL | https://deskzo.com/contact |
| Marketing URL | https://deskzo.com |
| Privacy policy URL | https://deskzo.com/privacy/app |
| App Privacy | `ios-privacy.md` |
| Devices | iPhone and iPad |

## Promotional text (170 characters — can be changed without a new version)

> Your working day in Deskzo, on your iPhone: clock in, today's tasks, approvals, leave and team chat — and a word
> after each call with a customer, logged for you.

## Description (4,000 characters)

> The Deskzo app is for people whose company runs on Deskzo. Sign in once, and your working day is in your pocket: clock in, tick off today's tasks, decide what waits for you, ask for leave, and chat with your team.
>
> **Your day at a glance**
> Clock in and out with a tap — where you were is saved with your attendance, if you allow it. See the tasks due today and tick them off. Approve or reject leave, expense claims, attendance corrections and other requests waiting for you. Check your leave balance, and ask for leave on a calendar — Deskzo works out the days, weekends and holidays left out.
>
> **Team chat**
> Chat with your colleagues one to one or in groups: replies, reactions, photos and files, read ticks, "typing…", who's online. It stays inside your company's Deskzo, under your company's rules.
>
> **All of Deskzo**
> Everything else in your company's Deskzo opens in the app, already signed in.
>
> **Calls with customers, logged**
> Call a customer from the app — a callback you owe, a number on a Deskzo page — and when you come back, the app asks how it went: connected, callback requested, not interested; a note, a callback time and the deal it was about. One tap, and it's on the customer's history, on the lead and in your team's calling report. A call you made from the Phone app can be logged with Log a call.
>
> **Know who's calling**
> Turn on Deskzo's caller ID in Settings, and when a customer rings, their name and company show — for the customers you can see in Deskzo.
>
> **Ring my phone**
> Working in Deskzo on a computer? Press "Ring my phone" on any contact, and your iPhone offers to call them.
>
> **In your company's control**
> You sign in on your company's own Deskzo page — with its password, two-factor or single sign-on — or with a code from Settings on a computer. No new password. Your company's sign-in rules apply, and your administrators see the app in Security › Devices, can require their approval and can sign it out at any time.
>
> **What it doesn't do**
> It doesn't record calls, read your messages, your contacts or your call history, or show ads. It reads your location only when you clock in or out, if you allow it (or sign in, if your company asks for that) — never in the background.
>
> You need a Deskzo account from your company to use the app. Learn more at deskzo.com.

## Keywords (100 characters, commas, no spaces after them)

> crm,sales,calls,caller id,attendance,leave,approvals,tasks,team chat,field sales,india,business

(95 characters.)

## What's New (first release)

> The first Deskzo app for iPhone: your day in Deskzo — clock in, tasks, approvals, leave and team chat — calls with customers logged from a word after the call, caller ID for your customers, and "Ring my phone".

## App Review Information

Contact: *(the name, phone and email of whoever answers App Review — not the demo account)*.

Sign-in required: **Yes** — the demo account below.

### Before submitting — on the live platform

As for Google (`review-access.md`), and the same workspace can serve both:

1. A demo workspace with sample customers, contacts and leads (the console's demo seed), e.g. `appreview.deskzo.com`
   — never a real customer's.
2. In it, a user for Apple, e.g. `app-review@deskzo.com`, role Sales, with a strong password, no two-factor, and no IP
   rule or device approval that would stop them.
3. One of the sample contacts with a phone number the reviewer can call — note it below.
4. `DESKZO_APP=on` (or the store addresses) set on the server, so Settings › Deskzo app is there, and
   `DESKZO_APP_APNS_KEY` set, so "Ring my phone" reaches the iPhone.

### Notes to paste (App Review › Notes)

> Deskzo is a business app: it works only with an account from the user's company, so it opens on a sign-in screen.
> Please use this demo account:
>
> 1. Type the address **appreview.deskzo.com** and tap **Sign in**.
> 2. On the page that opens, sign in — email **app-review@deskzo.com**, password *(the password)* — and tap **Allow**.
>    (Pairing with a QR code is the other way in: it is for signing in from a computer, and needs a second device.)
> 3. Today shows clocking in (it asks for location while in use — you can refuse it), tasks, approvals and leave.
> 4. Calls: tap **Set up calls on this iPhone** and turn them on — the app then asks to send notifications, for "Ring my
>    phone" and the reminder after a call. Then call the demo contact *(number)* from Callbacks; when you return to the
>    app it asks how the call went and logs it.
> 5. Caller ID is optional: in Settings › Phone › Call Blocking & Identification, turn on Deskzo; a call from the demo
>    contact then shows their name.
>
> The app reads no call history (iOS doesn't allow it): a call is logged only when the user says how it went. Location
> is read only when clocking in or out, never in the background. The camera scans a pairing code and takes photos for
> chat; the microphone is never used.

Keep the account and the sample data in place while the app is in review, and for later updates.

## Screenshots

Taken on the iOS Simulator with the demo workspace (`ios-release-checklist.md` has the sizes): Today, Calls with the
after-call sheet, a chat conversation, Approvals, the Deskzo tab, and Settings › Calls on this iPhone — light and dark.
