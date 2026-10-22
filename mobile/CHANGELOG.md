# The Deskzo app — what changed

Each version as people see it (`version` in `app.config.ts`, shared by both phones), newest first. Android's
`versionCode` goes up with every Play upload; the iPhone's build number is EAS's own (`eas.json`).

## 0.3.0 — the iPhone (22 Oct 2026) · Android versionCode 4

The app on iPhone and iPad, from the same code as Android's — every screen and feature, with calling as iOS allows it
(README.md, "On an iPhone"):

- Signing in by the browser, a QR or a code; the phone's token in the iOS Keychain, on this iPhone only.
- Today, Tasks, Approvals, Leave, team chat (photos, the camera, files, copy) and all of Deskzo's pages — WKWebView
  signed in, uploads, downloads to the share sheet (exports the page makes itself too), other sites in Safari, the back
  swipe.
- Calls: no call log on an iPhone, so the after-call sheet asks how a call started in the app went, and **Log a call**
  notes any other; caller ID through CallKit's Call Directory, loaded with the customers the person may see; "Ring my
  phone" as a notification with a Call button.
- Notifications through Apple's push service — "Ring my phone", chat messages, approvals — asked for when they are
  first needed, never at launch; a quiet reminder after a call.
- Dark mode, Dynamic Type, the notch and Dynamic Island, iPad in a readable column, VoiceOver labels.
- No microphone, no background location, no Face ID; HTTPS only; a privacy manifest.

On the server: pushes to iPhones (`DESKZO_APP_APNS_KEY`), calls logged by hand with their length marked unknown, and
the caller ID list (`/api/app/calls/directory`).

Android is unchanged: the same screens, the same build (the iPhone's packages are left out of it), version 0.3.0.

## 0.2.1 (18 Oct 2026) · versionCode 3

- A customer's calls from the phone show on its Activity in Deskzo.
- "Your company's Deskzo hasn't been updated for this part of the app yet" where the workspace is older than the app;
  Chat and Tasks only where the workspace has them.
- The release keeps what the pairing scanner needs.
- Later, without a new version: GPS attendance — clocking in and out only at the office, with exceptions an approver
  allows (21 Oct 2026).

## 0.2.0 (18 Oct 2026) · versionCode 2

- Team chat, WhatsApp-style: a Chat tab, conversations full screen, live.

## 0.1.0 (18 Oct 2026) · versionCode 1

- The Deskzo app for Android, calling first: pairing, calls that log themselves, caller ID, the after-call card,
  "Ring my phone".
- Ready for Google Play: the privacy notice, the store listing, data safety, the call-log declaration, a checked release
  build.
- All of Deskzo inside the app, signed in as the phone.
- The day's work: Today, Tasks, Approvals, Leave; browser sign-in, the device rules and the screenshot rule.
