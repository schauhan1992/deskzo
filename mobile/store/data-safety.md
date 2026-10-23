# Google Play — Data safety form

The answers below describe the app as built (mobile/, src/lib/app). Google counts data as **collected**
when the app sends it off the phone, and **shared** when it is passed to a third party. If the app changes
— call recordings, location at any time but clocking in, checking in and out of a visit, and signing in — update this and the privacy page
(https://deskzo.com/privacy/app) first.

## Overview questions

| Question | Answer | Why |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | Call history and what the user adds to a call are sent to their company's Deskzo. |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | Release builds only talk HTTPS (`scripts/android.js release` refuses a build that allows plain HTTP). |
| Do you provide a way for users to request that their data is deleted? | **Yes** | Signing out clears the phone; calls in Deskzo are deleted on request to the company or to us (contact form, deskzo.com/contact). |

## Data types

### Contacts → "Contacts" (Google includes call history here)

| Question | Answer |
|---|---|
| Collected | **Yes** — for each call since call sync was switched on: the other party's number, direction, start time, length. |
| Shared | **No** — it goes only to the user's company's Deskzo workspace, which we run for that company (a service provider, not a third party). |
| Processed ephemerally | **No** — calls with the company's customers are stored. (Calls with anyone else are checked and dropped; a ringing number looked up for caller ID is not stored.) |
| Required or optional | **Optional** — nothing is read until the user switches call sync on, and they can switch it off. |
| Purposes | **App functionality** (logging the user's calls with customers; caller ID). |

### Location → "Approximate location" and "Precise location"

| Question | Answer |
|---|---|
| Collected | **Yes** — the phone's position at the moment the user clocks in or out in the app, or checks in at a customer's on a visit and checks out again (22 Oct 2026), if they allow it; and once when they sign the app in, if their company requires location at sign-in (a security setting of the company's, applied to its website too). Never in the background (`ACCESS_BACKGROUND_LOCATION` is blocked in the build). |
| Shared | **No** — it goes only to the user's company's Deskzo, kept with that day's attendance, or with the visit. |
| Processed ephemerally | **No** — stored with the attendance, or the visit. |
| Required or optional | **Optional** — the user can refuse it; clocking in and checking in work without it. (Where the company requires location at sign-in, the app can't be signed in without it.) |
| Purposes | **App functionality** (attendance: where somebody clocked in from, seen by them, their managers and HR; field visits: where somebody checked in and out of a customer's, seen by whoever may open that visit); **Fraud prevention, security, and compliance** (where the company requires it, where somebody signed in from, in its security log). |

### App activity → "Other user-generated content"

| Question | Answer |
|---|---|
| Collected | **Yes** — what the user writes on the after-call card (outcome, notes, callback time, the lead); clocking in and out; visits they plan and write up, and meetings they schedule; tasks they add or tick off; leave they ask for; their decisions on what waits for their approval; the messages they send in team chat. |
| Shared | **No** |
| Processed ephemerally | **No** |
| Required or optional | **Optional** — the card is the user's choice. |
| Purposes | **App functionality** |

### App activity → "Other actions"

| Question | Answer |
|---|---|
| Collected | **Yes** — where the user's company limits screenshots (a security setting of the company's, applied to its website too): that a screenshot was taken in the app, when, and on which screen. Android 14+ tells the app; the image itself is never read, and the photo library is never opened. |
| Shared | **No** |
| Processed ephemerally | **No** — counted and kept in the company's security log. |
| Required or optional | **Required** where the company sets the limit. |
| Purposes | **Fraud prevention, security, and compliance** |

### Photos and videos → "Photos"; Files and docs

| Question | Answer |
|---|---|
| Collected | **Yes** — only the photos and documents the user picks (or takes with the camera) to send in team chat, and the photo of a receipt they add to an expense claim (made smaller on the phone first). The app has no access to the photo library beyond Android's picker. |
| Shared | **No** — they go to the user's company's Deskzo, to the people in that chat, or with the claim to those who approve and pay it. |
| Processed ephemerally | **No** — kept with the chat, as the company's retention setting says, or with the claim. |
| Required or optional | **Optional** |
| Purposes | **App functionality** |

### Financial info → "Other financial info"

| Question | Answer |
|---|---|
| Collected | **Yes** — the expense claims the user makes in the app (22 Oct 2026): the amount, what it was for, when and how it was paid. No card or bank details. |
| Shared | **No** — it goes only to the user's company's Deskzo, to those who approve and pay claims. |
| Processed ephemerally | **No** — kept with the claim. |
| Required or optional | **Optional** — claims are the user's choice. |
| Purposes | **App functionality** (expense claims). |

### Device or other IDs

| Question | Answer |
|---|---|
| Collected | **Yes** — the phone's own sign-in (an identifier Deskzo makes when it is paired), with its model and the app's version; and, if the user allows notifications, the phone's Firebase Cloud Messaging address (22 Oct 2026), so their company's Deskzo can notify them. |
| Shared | **No** — Google's Firebase Cloud Messaging delivers the notifications as Deskzo's service provider, which Google doesn't count as sharing; a notification carries only its title and where it leads. |
| Processed ephemerally | **No** |
| Required or optional | **Required** — it is how the phone signs in. |
| Purposes | **App functionality**, **Fraud prevention, security, and compliance** (administrators see and can sign out a company's paired phones). |

## Not collected

- **Personal info** — the user's name and email are shown from their Deskzo account; the app sends none.
- **Location, at any other time** — read only when the user clocks in or out, checks in or out of a visit, or signs in where the company requires it (above). (The network address a phone connects from is kept with the device for the company's security log; it is not turned into a location.)
- **Audio** — calls are not recorded.
- **Messages, Calendar, Files and docs, Web browsing, App info and performance, Health** — none. (The app's calendar is the user's Deskzo calendar; the phone's own calendar is never read. Financial info: only the expense claims above — no payment details.)

## Security practices

- Data is encrypted in transit: **Yes**.
- You can request that data be deleted: **Yes**.
- Committed to follow the Play Families Policy: not applicable (not for children).
- Independent security review: **No**.
