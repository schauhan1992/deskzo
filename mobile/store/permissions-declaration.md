# Google Play — Permissions declaration (Call log)

Apps that read the call log must say why in Play Console (App content › Sensitive app permissions) and
show it in a short video. The app asks for `READ_CALL_LOG` — not `WRITE_CALL_LOG`, and nothing from the SMS
group.

## What the app asks for, and for what

| Permission | What for | Declaration |
|---|---|---|
| `READ_CALL_LOG` | Logging the user's calls with customers in their company's CRM; the ringing number for caller ID. | **Required** (below) |
| `READ_PHONE_STATE` | Knowing when a call rings and ends, to look up the caller and send the call afterwards. | None |
| `POST_NOTIFICATIONS` | Caller ID while a customer rings; "How did it go?" after a call. | None |
| `CAMERA` | Scanning the pairing code. | None |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | Where the user is when they clock in or out, or sign in where their company requires it — asked then, with the app open. | None — foreground only; `ACCESS_BACKGROUND_LOCATION` and `FOREGROUND_SERVICE_LOCATION` are blocked, so there is no background-location declaration |
| `DETECT_SCREEN_CAPTURE` | Told that a screenshot was taken in the app (Android 14+), for the user's company's screenshot allowance. Install-time; says only that one was taken. | None |
| `INTERNET`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE`, `VIBRATE` | Sending calls in the background (Android's WorkManager). | None |

`scripts/android.js release` stops a release that asks for anything not in this table.

## Call log declaration

**Core functionality:** Enterprise CRM — the app logs a salesperson's calls with their company's customers
into the company's CRM (Deskzo), and shows who a customer is while they ring.

**Permitted use (Play's list):** *Enterprise archive, CRM, and enterprise device management* — and *Caller
ID* for the ringing number.

**Description to paste (500 characters):**

> Deskzo is a business CRM. After the user turns on call sync, the app reads the call log entries made since then (number, direction, time, length) and sends them to the user's company's Deskzo, which logs the calls with the company's customers on their records and drops any other call without storing it. While a call rings, the number is looked up so the customer's name can be shown. The app never writes to the call log and does not record calls.

## The demo video (about 60 seconds, screen recording on a phone)

1. Open Deskzo, show the pairing code being scanned (or typed) and the app signing in.
2. Show the call sync screen — what is read, what is kept — and tap **Turn on call sync**; allow the call log
   and phone permissions.
3. Receive a call from a number that is a contact in Deskzo: the caller ID notification shows the name and
   company while it rings.
4. Hang up: "How did the call with … go?" appears; tap it, choose an outcome, add a note and a callback, save.
5. Show the call on the company's Deskzo in a browser (Calls), with the note.
6. Call a number that isn't in Deskzo: nothing appears in Deskzo.

Upload it unlisted (YouTube or Drive with link access) and paste the link in the declaration.
