# Deskzo app

The Deskzo app for phones — Android first (owner, 18 Oct 2026), and the iPhone from the same code (owner, 22 Oct
2026). Calling comes first: the phone is paired with a person's Deskzo, its calls with customers are logged on the
Calls module, a customer's name shows while they ring, and "Ring my phone" in Deskzo's call dialog makes this phone
offer to dial. Then the day's work: Today (clocking in, with where the phone is if the person allows it; tasks due;
what waits for a decision; leave), Tasks, Approvals and Leave, team chat — and all of Deskzo's own pages on the
Deskzo tab, signed in as the phone.

It talks only to Deskzo's `/api/app/*` (`src/lib/app` and `src/app/api/app` in the main project); the
server's suites `npm run check:phone-app` (pairing, calling, the pages, the iPhone's pushes and caller ID list) and
`npm run check:app-daily` (the everyday screens) cover everything the app relies on.

## How it is put together

- **Expo SDK 58**, React Native, Expo Router. Screens are in `src/app`, shared code in `src/lib`. One codebase for
  both phones: where they differ, a `Platform.OS` branch or a `*.ios.ts` file beside the shared one
  (`native.ios.ts`, `calling.ios.ts`, `notifications.ios.ts`) — Android never loads those.
- **`modules/deskzo-calls`** is Android's native part (Kotlin): reading the call log, the phone-state receiver
  (works with the app closed), call sync in the background (WorkManager), caller ID and after-call
  notifications. Its session — the workspace's address and the phone's token — is kept in the app's
  private storage, where the background sync can read it.
- **`modules/deskzo-ios`** is the iPhone's (Swift): the caller ID list for CallKit, clearing the in-app pages'
  sign-in on signing out, a file a Deskzo page offers handed to the share sheet — sent by the server, or made by the
  page itself, like an export (`src/lib/web-downloads.ts`) — and screenshots reported.
- **`targets/call-directory`** is the iPhone's caller ID extension (CallKit's Call Directory), added to the Xcode
  project at prebuild by `@bacons/apple-targets`. It shares an App Group (`group.com.deskzo.app`) with the app.
- `android/` and `ios/` are generated from `app.config.ts` (`node scripts/android.js prebuild`,
  `node scripts/ios.js prebuild`) and never committed or edited by hand.
- Packages only the iPhone uses (`expo-notifications`, `expo-secure-store`, `expo-splash-screen`, and
  `expo-application` with them) are left out of Android's build (`package.json`, `expo.autolinking.android.exclude`),
  so Android's build is what it was. `.npmrc` keeps `npm ci` installing exactly the lockfile.

## Running it on this computer

### Android

Java 17 and the Android SDK live in the user's own folder (`%LOCALAPPDATA%\Programs\jdk-17` and
`%LOCALAPPDATA%\Android\Sdk`); `scripts/android.js` points every command at them.

```
npm install
npm run android:dev        # a development build on the emulator (deskzo-test)
```

A development build (`DESKZO_APP_DEV=1`) may talk plain HTTP to a `*.localhost` workspace on this computer,
reached from the emulator at `10.0.2.2`. On Deskzo, set `DESKZO_APP=on` in `.env` so Settings › Deskzo app
shows a pairing code. A release build only ever talks HTTPS to a real workspace.

### iPhone

Building for iOS needs a Mac with **Xcode 26.4 or later** (which needs macOS Tahoe 26.2) — what Expo SDK 58 builds
with. Without one, build in the cloud with EAS (below); nothing else needs a Mac.

```
npm install
npm run ios:dev            # a development build on the iOS Simulator
npm run ios:check          # ios/ generated as a release would be, and checked — works on Linux too
npm test                   # the unit tests (jest-expo)
```

A development build talks plain HTTP to this Mac's Deskzo: the API at `127.0.0.1`, naming the workspace — Apple's
networking finds no `*.localhost` name on its own — and the Deskzo tab at `localhost:3000`, which is the Mac's first
workspace (`TENANCY_LEGACY_HOSTS`): pair a development build with that one. Pushes don't reach the Simulator from
Deskzo; caller ID needs a real iPhone.

`npm run ios:check` stops a release that asks for a permission the App Store isn't told about
(`store/ios-privacy.md`), runs in the background, allows plain HTTP, or lacks the caller ID extension, the App Group
or production pushes.

## Building for the stores

- Android: `node scripts/android.js release` (`store/release-checklist.md`).
- iPhone: EAS Build, signing managed by EAS — no certificates or keys in the repository (`store/ios-release-checklist.md`).

| Command | What |
|---|---|
| `npx eas-cli@latest build -p ios --profile development` | A development build for the iOS Simulator (`DESKZO_APP_DEV=1`) |
| `npx eas-cli@latest build -p ios --profile development-device` | The same for a registered iPhone |
| `npm run ios:build:preview` | A release build for registered iPhones (ad hoc, internal) |
| `npm run ios:build:production` | The App Store's build — then `npx eas-cli@latest submit -p ios` for TestFlight and review |

Build numbers are EAS's own (`appVersionSource: remote`), raised on every production build; `version` in
`app.config.ts` is what people see on both phones.

## On an iPhone

The same screens, the same Deskzo, with these differences — each because iOS doesn't allow what Android does:

| | Android | iPhone | Why |
|---|---|---|---|
| Logging calls | Itself: the call log is read after each call, and the ones with customers are logged | From the after-call sheet: a call started in the app — a callback, "Ring my phone", a number on a Deskzo page — is asked about when the person comes back; **Log a call** on Calls notes any other | iOS gives no app the call log, nor tells it a call ended while it is in the background |
| A call's length | From the call log | Not known — Deskzo marks it as logged by hand | The same |
| Caller ID | Looked up live while it rings | A list loaded ahead of time — the customers the person may see in Deskzo, refreshed each time the app opens and with **Refresh caller ID** in Settings — once the person turns on Deskzo in Settings › Phone › Call Blocking & Identification | iOS lets no app run while the phone rings; CallKit's Call Directory is how it shows a name |
| "Ring my phone" | A data message; the app offers to dial | A notification with a **Call** button; iOS asks "Call …?" before dialling | No app may dial without the person's tap |
| After-call reminder | A notification once the call ends | A quiet notification two minutes after the call starts, in case the person doesn't come straight back | iOS doesn't tell an app when a call ends |
| Notifications | The calling module's own | Through Apple's push service: "Ring my phone", chat messages and what waits for a decision — who and where, never what | — |
| Screenshots | Counted, and blocked once the day's allowance is used | Counted; never blocked | iOS lets no app block screenshots |
| Sign-in | Kept in the app's private storage | Kept in the iOS Keychain, on this iPhone only; a reinstalled app starts signed out | — |
| Appearance | Light | Light or dark, as the phone is; iPad shown in a phone's column | — |

Nothing on an iPhone runs in the background: no location, no call reading, no sync with the app closed. Calls on this
iPhone are switched on by the person (Settings › Calls on this iPhone), which tells Deskzo it takes "Ring my phone".

## Before it goes to the stores

Google Play:

- An upload key, kept out of the repository.
- Google Play's declaration for reading the call log (CRM is an allowed use).
- A privacy policy page that says what is read and what leaves the phone.
- Firebase, for "Ring my phone" with the app closed (`DESKZO_APP_FCM_SERVICE_ACCOUNT` on the server).

App Store (`store/ios-release-checklist.md`):

- An Apple Developer account, the app in App Store Connect, and an APNs key (`DESKZO_APP_APNS_KEY` on the server).
- The App Privacy answers (`store/ios-privacy.md`) and the listing and review notes (`store/ios-listing.md`).
- What only a real iPhone can show — caller ID, pushes, the after-call sheet — tried by hand (`store/ios-test-checklist.md`).
