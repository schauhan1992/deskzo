# Google Play — Data safety form

The answers below describe the app as built (mobile/, src/lib/app). Google counts data as **collected**
when the app sends it off the phone, and **shared** when it is passed to a third party. If the app changes
— push notifications through Firebase, call recordings — update this and the privacy page
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

### App activity → "Other user-generated content"

| Question | Answer |
|---|---|
| Collected | **Yes** — what the user writes on the after-call card: outcome, notes, callback time, the lead. |
| Shared | **No** |
| Processed ephemerally | **No** |
| Required or optional | **Optional** — the card is the user's choice. |
| Purposes | **App functionality** |

### Device or other IDs

| Question | Answer |
|---|---|
| Collected | **Yes** — the phone's own sign-in (an identifier Deskzo makes when it is paired), with its model and the app's version. |
| Shared | **No** |
| Processed ephemerally | **No** |
| Required or optional | **Required** — it is how the phone signs in. |
| Purposes | **App functionality**, **Fraud prevention, security, and compliance** (administrators see and can sign out a company's paired phones). |

## Not collected

- **Personal info** — the user's name and email are shown from their Deskzo account; the app sends none.
- **Location** — not read. (The network address a phone connects from is kept with the device for the company's security log; it is not turned into a location.)
- **Photos and videos** — the camera is used only to scan the pairing code; no image is taken or kept.
- **Audio** — calls are not recorded.
- **Messages, Calendar, Files and docs, Web browsing, App info and performance, Financial, Health** — none.

## Security practices

- Data is encrypted in transit: **Yes**.
- You can request that data be deleted: **Yes**.
- Committed to follow the Play Families Policy: not applicable (not for children).
- Independent security review: **No**.
