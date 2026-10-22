# Deskzo app

The Deskzo app for phones, Android first (owner, 18 Oct 2026). Calling comes first: the phone is paired
with a person's Deskzo, its calls with customers log themselves on the Calls module, a customer's name shows
while they ring, and "Ring my phone" in Deskzo's call dialog makes this phone offer to dial. Then the day's
work: Today (clocking in, with where the phone is if the person allows it; tasks due; what waits for a
decision; leave), Tasks, Approvals and Leave.

Since 22 Oct 2026 the app is native, module by module, sales first: the **Sales** tab (leads, companies and
contacts — search, a lead's stage moved and a call or note logged, a customer's people rung, WhatsApped or
emailed, a new lead, company or contact) and a search over all three. **More** lists everything else the person
may open, as the web's menu does: what has a screen here opens natively, the rest as its web page, signed in
as the phone — until it has a screen of its own. Online only: nothing is kept on the phone.

Field work next (22 Oct 2026): **visits** — today's on the Today screen, checked in at the customer's door and
written up on leaving, each with where the phone was if it says (kept with the visit for whoever may open it);
planned from a company or a lead — **expense claims** with a photo of the receipt, made small enough on the
phone (`src/lib/receipt.ts`) and sent as a form; a receipt is needed over the amount an administrator sets in
Settings › Expense approvals — and the person's **calendar**, with meetings scheduled from a lead, company or
visit.

It talks only to Deskzo's `/api/app/*` (`src/lib/app` and `src/app/api/app` in the main project); the
server's suites `npm run check:phone-app` (pairing, calling, the pages), `npm run check:app-daily` (the
everyday screens) `npm run check:app-sales` (the sales screens, and notifications pushed to the phone) and
`npm run check:app-field` (visits, claims and meetings) cover everything the app relies on.

## How it is put together

- **Expo SDK 58**, React Native, Expo Router. Screens are in `src/app`, shared code in `src/lib`.
- **`modules/deskzo-calls`** is the native part (Kotlin): reading the call log, the phone-state receiver
  (works with the app closed), call sync in the background (WorkManager), caller ID and after-call
  notifications. Its session — the workspace's address and the phone's token — is kept in the app's
  private storage, where the background sync can read it.
- `android/` is generated from `app.config.ts` (`node scripts/android.js prebuild`) and not committed.

## Running it on this computer

Java 17 and the Android SDK live in the user's own folder (`%LOCALAPPDATA%\Programs\jdk-17` and
`%LOCALAPPDATA%\Android\Sdk`); `scripts/android.js` points every command at them.

```
npm install
npm run android:dev        # a development build on the emulator (deskzo-test)
```

A development build (`DESKZO_APP_DEV=1`) may talk plain HTTP to a `*.localhost` workspace on this computer,
reached from the emulator at `10.0.2.2`. On Deskzo, set `DESKZO_APP=on` in `.env` so Settings › Deskzo app
shows a pairing code. A release build only ever talks HTTPS to a real workspace.

## Before it goes to Google Play

- An upload key, kept out of the repository.
- Google Play's declaration for reading the call log (CRM is an allowed use).
- A privacy policy page that says what is read and what leaves the phone.
- Firebase, for notifications with the app closed (below).

## Notifications (Firebase)

Deskzo's notifications — what the bell says, chat (who, never what) and "Ring my phone" — reach a closed app
through Firebase Cloud Messaging, sent by each workspace's Deskzo itself (`src/lib/app/push.ts`), received by
`expo-notifications` (`src/lib/push.ts`). One Firebase project is Deskzo's, for every workspace:

1. In the Firebase console, make a project and add an **Android app** with package `com.deskzo.app`.
2. Download its `google-services.json` and put it in this folder (`mobile/google-services.json`). It holds only
   public identifiers and may be committed. `app.config.ts` picks it up; without it the app builds and simply
   gets no notifications while closed.
3. In Project settings › Service accounts, generate a private key, and set the JSON it gives (as it is, or
   base64) as `DESKZO_APP_FCM_SERVICE_ACCOUNT` on the server — in Coolify, never in the repository or a chat.
4. Build the app again (`node scripts/android.js release`) and install it; it asks once whether it may notify.

`npm run check:app-sales` and `check:app-chat` (in the main project) check what is sent, with Firebase stood in for.
