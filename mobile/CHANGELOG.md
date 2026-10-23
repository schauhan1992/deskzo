# The Deskzo app — what changed

Each version as people see it (`version` in `app.config.ts`, shared by both phones), newest first. Android's
`versionCode` goes up with every Play upload; the iPhone's build number is EAS's own (`eas.json`).

## 0.3.1 (23 Oct 2026) · Android versionCode 5

- Tasks is a screen of its own, opened from Today's **All my tasks** and from More — "All my tasks" used to bring
  Today back instead of opening it.
- **Updates over the air**: the app's own screens come from deskzo.com when a newer version is published
  (`npm run app:update`, signed with Deskzo's key), on Android and on the iPhone (`--platform ios`); Settings › This
  app says which version runs and can take a newer one at once.

## 0.3.0 — the native app, on Android and the iPhone (23 Oct 2026) · Android versionCode 4

The app made native, and the same app on iPhone and iPad, from the same code — every screen and feature on both
phones, with calling as iOS allows it (README.md, "On an iPhone"):

- **Sales first:** leads, companies and contacts as the app's own screens — the pipeline, a lead's stage, won or lost,
  calling, WhatsApp or emailing a contact in a tap, adding a lead, company or contact, and search across them. The rest
  of Deskzo's pages under **More**.
- **Field work:** visits planned, checked in and out with where the phone was, and written up; expense claims with a
  receipt photo (made smaller on the phone first); meetings and the calendar.
- **Notifications** — what the bell says on the web, chat messages and "Ring my phone", even with the app closed;
  a tap opens the lead, company, task or chat it is about. Through Firebase on Android and Apple's push service on an
  iPhone, asked for when they are first needed, never at launch.
- **The iPhone:** signing in by the browser, a QR or a code, the phone's token in the iOS Keychain on this iPhone only;
  Today, Tasks, Approvals, Leave, team chat and all of Deskzo's pages (WKWebView signed in, uploads, downloads to the
  share sheet, other sites in Safari, the back swipe). Calls: no call log on an iPhone, so the after-call sheet asks how
  a call started in the app went, and **Log a call** notes any other; caller ID through CallKit's Call Directory,
  loaded with the customers the person may see; "Ring my phone" with a Call button. Dark mode, Dynamic Type, the notch
  and Dynamic Island, iPad in a readable column, VoiceOver labels. No microphone, no background location, no Face ID;
  HTTPS only; a privacy manifest.

On the server: pushes to iPhones (`DESKZO_APP_APNS_KEY`) beside Android's (`FIREBASE_SERVICE_ACCOUNT`), one call for
both (`pushToDevice`); calls logged by hand with their length marked unknown; the caller ID list
(`/api/app/calls/directory`).

Android's calling — calls that log themselves, the after-call card, caller ID — is unchanged; the iPhone's packages are
left out of its build.

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
