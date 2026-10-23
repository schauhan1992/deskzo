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

It talks only to Deskzo's `/api/app/*` (`src/lib/app` and `src/app/api/app` in the main project), and to
deskzo.com for newer versions of its own screens (Updates over the air, below); the
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

## Updates over the air

The app's own screens — its JavaScript — reach phones without a store release (owner, 23 Oct 2026). At each launch
the app asks `https://deskzo.com/api/app-updates/manifest` whether there's a newer version for its native build,
downloads it in the background, and runs it from the next launch (Settings › This app can take it at once). Pushing
to main changes no phone: an update goes out only when it's published, by hand.

```
npm run app:update -- publish               # this commit's screens, to every phone on a matching build
npm run app:update -- list                  # what's been published
npm run app:update -- rollback              # back to the update before the newest
npm run app:update -- rollback --embedded   # back to the screens that came inside the installed app
```

(Run from the main project's folder.) What needs a store release instead: anything native — a new library from
npm with Android code, a permission, a config plugin, `app.config.ts` itself, Firebase. The runtime version is a
fingerprint of exactly those parts (`runtimeVersion: { policy: "fingerprint" }`), so an update made after a native
change goes only to phones that have the release with it; phones on the older release keep the screens they have.
`node scripts/android.js release` prints the native build it made.

**The update key.** Every update is signed with Deskzo's update key, kept at
`~/.deskzo/app-updates/private-key.pem` — never in the repository. The app runs only updates whose signature checks
out against `certs/certificate.pem`, built into it; the server (`src/lib/app-updates`) keeps nothing it can't
verify against the same certificate, so the key is all publishing takes, and there's no password on the server.
**Back the key up somewhere safe**: lose it and no update reaches the phones already installed — only a store
release with a new certificate would; leak it and whoever has it can publish screens to every phone (make a new
key and certificate, and release).

**Trying it on the emulator.** `node scripts/android.js updates-test` builds a release-like APK that asks the Deskzo
on this computer (`http://localhost:3000`, through `adb reverse tcp:3000 tcp:3000`) instead. Publish to it with the
same address, so the update is for that build:

```
DESKZO_APP_UPDATES_URL=http://localhost:3000/api/app-updates/manifest npm run app:update -- publish --server http://localhost:3000 --allow-uncommitted
```

`npm run check:app-updates` (main project) checks the server: what's served, what's refused, rollbacks.
