# Releasing the Deskzo app on the App Store

The iPhone app is built in the cloud by EAS (eas.json), which also keeps its signing — certificates, provisioning
profiles and the push key's certificate side — so none of it is on a computer or in the repository. A Mac is needed only
to build on one's own machine (Xcode 26.4+, macOS Tahoe 26.2+); everything below works from Windows.

## Once: the accounts

1. **Apple Developer Program** — https://developer.apple.com/programs/ — US$99 a year, enrolled as the company
   (an organisation needs its D-U-N-S number). Note the **Team ID** (Membership details).
2. **Expo account** — https://expo.dev/signup. Then, in `mobile/`:

   ```
   npx eas-cli@latest login
   npx eas-cli@latest init
   ```

   `init` makes the EAS project and prints its id: add it to `app.config.ts` as `extra: { dev, eas: { projectId: "…" } }`
   (the config is TypeScript, so EAS can't write it in itself).
3. **The Team ID for the build**: in EAS, under the project's Environment variables, `DESKZO_APPLE_TEAM_ID` = the Team
   ID (it isn't secret). `app.config.ts` gives it to the app and to the caller ID extension.

## Once: App Store Connect

1. https://appstoreconnect.apple.com › Apps › **+** › New App: platform iOS, name **Deskzo**, language English (India),
   bundle ID **com.deskzo.app** (EAS registers it on the first build if it isn't there yet — or register it under
   Certificates, Identifiers & Profiles › Identifiers), SKU `deskzo-ios`, full access.
2. Note the app's **Apple ID** (App Information › General): it goes in `eas.json` as `submit.production.ios.ascAppId`
   so `eas submit` doesn't ask.

## Once: the push key (APNs) — for "Ring my phone", chat and approvals

1. Certificates, Identifiers & Profiles › **Keys** › **+**: a name (`Deskzo push`), tick **Apple Push Notifications
   service (APNs)**, environment **Sandbox & Production**, Continue, Register, **Download** the `.p8` — Apple lets you
   download it once. Note the **Key ID**.
2. On the Deskzo server, never in the repository — in Coolify's environment, or `.env` on the VM (`.env.example`):

   ```
   DESKZO_APP_APNS_KEY='{"key_id":"ABC123DEFG","team_id":"<Team ID>","private_key":"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}'
   ```

   (or the same JSON in base64). Restart the app. Without it nothing is pushed to iPhones: a ring still reaches an
   iPhone whose app is open on Calls.
3. Keep the `.p8` in the password manager. It is one key for every workspace, and Apple allows two at a time — to
   replace it, make the new one, change the variable, then revoke the old one.

EAS's signing doesn't need the key (pushes come from Deskzo's server, not Expo's).

## Each release

1. Raise `version` in `app.config.ts` (what people see, e.g. 0.4.0) — shared with Android; the build number is EAS's
   (`appVersionSource: remote`) and goes up by itself on each production build. Add the release to `CHANGELOG.md`.
2. If the app now does something new with people's data, update `ios-privacy.md`, the privacy manifest
   (`ios.privacyManifests` in `app.config.ts`), App Store Connect's App Privacy and the privacy page **first**.
3. `npm run ios:check` — ios/ generated as the release will be; it stops on a permission the store isn't told about,
   plain HTTP, background modes, or a missing caller ID extension, App Group or production push.
4. `npm test`, `npx tsc --noEmit`, `npm run lint`, `npx expo-doctor` — all clean.
5. `npm run ios:build:production` — EAS asks, the first time, to sign in to Apple and to make the certificate and
   profiles for the app **and** the caller ID extension (`com.deskzo.app.CallDirectory`); let it. It enables Push
   Notifications and App Groups (`group.com.deskzo.app`) on both identifiers from their entitlements.
6. `npx eas-cli@latest submit -p ios --latest` — uploads the build to App Store Connect. It appears in **TestFlight**
   after Apple's processing (10–30 minutes).
7. TestFlight › Internal Testing: a group with the team's Apple IDs; they install TestFlight and the build. Go
   through `ios-test-checklist.md` on a real iPhone against the live site.
8. App Store › the version: the build, the What's New text, then **Add for Review** › Submit.

For testers outside the team before the App Store: TestFlight › External Testing (Apple reviews the first build, about
a day). For a few registered iPhones without TestFlight: `npm run ios:build:preview` (ad hoc — register them first with
`npx eas-cli@latest device:create`).

## First release only — App Store Connect

- **App Information**: category Business (secondary Productivity), content rights (no third-party content), age
  rating questionnaire (all None → 4+).
- **Pricing and Availability**: free; India first, or wherever the customers are.
- **App Privacy**: privacy policy URL `https://deskzo.com/privacy/app`, then the answers in `ios-privacy.md`.
- **The version**: text from `ios-listing.md`; the review notes and demo account there (make the demo workspace and
  reviewer account first); the screenshots.

### Screenshots

From the iOS Simulator (Xcode 26.4+, or a development build), with the demo workspace — `Cmd+S` saves one:

| Display | Device to take them on | Size (portrait) | Needed |
|---|---|---|---|
| 6.9" iPhone | iPhone 17 Pro Max / 16 Pro Max | 1320 × 2868 | Yes |
| 6.5" iPhone | iPhone 11 Pro Max / XS Max | 1242 × 2688 (or 1284 × 2778) | Yes, unless 6.9" is given (Apple scales) — give both to be safe |
| 13" iPad | iPad Pro 13-inch (M4) | 2064 × 2752 | Yes — the app supports iPad (`supportsTablet`) |

Three to ten each: Today, Sales with a lead, a visit checked in, Calls with the after-call sheet, a chat conversation,
Approvals, Settings › Calls on this iPhone. Keep them in `store/graphics/ios/` (6.9, 6.5, ipad-13), as Google Play's are in `store/graphics/`.

Apple's review of a business app that needs an account usually takes a day or two; most rejections are the review
notes not getting them in, so keep the demo account working.
