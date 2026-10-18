# Deskzo app

The Deskzo app for phones, Android first (owner, 18 Oct 2026). Calling comes first: the phone is paired
with a person's Deskzo, its calls with customers log themselves on the Calls module, a customer's name shows
while they ring, and "Ring my phone" in Deskzo's call dialog makes this phone offer to dial.

It talks only to Deskzo's `/api/app/*` (`src/lib/app` and `src/app/api/app` in the main project); the
server's suite `npm run check:phone-app` covers everything the app relies on.

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
- Firebase, for "Ring my phone" with the app closed (`DESKZO_APP_FCM_SERVICE_ACCOUNT` on the server).
