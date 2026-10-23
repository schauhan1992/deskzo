# App Store — App Privacy

The answers for App Store Connect (App Privacy), describing the iPhone app as built (mobile/, src/lib/app). Apple counts
data as **collected** when it leaves the phone and is kept longer than it takes to answer the request; **linked** when it
is tied to the person's identity; **tracking** when it is combined with others' data for advertising. They agree with
Google Play's form (`data-safety.md`), except where the iPhone does less — it reads no call history — and with the
privacy manifest in `app.config.ts` (`ios.privacyManifests`). If the app changes what it reads or sends, update this,
`data-safety.md`, the manifest and the privacy page (https://deskzo.com/privacy/app) first.

## Data used to track you

**None.** No advertising, no analytics SDK, no third party. (`NSPrivacyTracking` is false.)

## Data linked to you

Everything collected goes only to the person's company's Deskzo workspace, which Deskzo runs for that company, and is
seen there as the company's own records.

| Apple's type | Collected | Purpose | Notes |
|---|---|---|---|
| **Location › Precise Location** | Yes | App Functionality | The phone's position when the person clocks in or out, or checks in at a customer's on a visit and checks out again, if they allow it; once when they sign in, if their company requires location at sign-in. Kept with the attendance, or the visit. Asked "While Using the App" only — never in the background (no background location key, no background modes; `npm run ios:check` refuses one). |
| **Location › Coarse Location** | Yes | App Functionality | The same reading; iOS may give it approximately if the person chooses. |
| **User Content › Emails or Text Messages** | Yes | App Functionality | The messages the person sends in team chat. |
| **User Content › Photos or Videos** | Yes | App Functionality | Only the photos the person picks (iOS's own picker — the app has no access to the library) or takes, to send in chat, add to an expense claim as its receipt (made smaller on the phone first), or add on a Deskzo page. |
| **User Content › Other User Content** | Yes | App Functionality | A call the person logs from the after-call sheet or Log a call — the customer's number, when, how it went, the notes, a callback; leads, companies and contacts they add or change; visits they plan and write up, and meetings they schedule; tasks they add or tick off; leave they ask for; their decisions on approvals; documents sent in chat. |
| **Financial Info › Other Financial Info** | Yes | App Functionality | The expense claims the person makes in the app: the amount, what it was for, when and how it was paid. No card or bank details. |
| **Identifiers › Device ID** | Yes | App Functionality | The phone's own sign-in — an identifier Deskzo makes when it is paired — with its model and the app's version, and, if the person allows notifications, Apple's push address for it (a notification carries only its title and where it leads). Administrators see the phone in Security › Devices and can sign it out. |
| **Usage Data › Other Usage Data** | Yes | App Functionality | Where the person's company limits screenshots: that one was taken in the app, when, and on which screen — never the image. |

## Data not linked to you

**None.**

## Not collected

- **Contact Info** — the person's name and email are shown from their Deskzo account; the app sends none.
- **Contacts** — the phone's contacts are never read. The caller ID list goes the other way: Deskzo sends the phone
  the names and numbers of the customers the person may see, which stay on the phone for CallKit and are deleted on
  signing out.
- **Call history** — an iPhone gives no app its calls; nothing is read.
- **Audio** — calls are not recorded; the microphone is never asked for.
- **Health, Sensitive Info, Browsing History, Search History, Purchases, Diagnostics** — none. The app has no crash
  reporter or analytics. Financial info: only the expense claims above — no payment details.
- **Calendar** — the app's calendar is the person's Deskzo calendar; the phone's own calendar is never read.
- **Update checks** (23 Oct 2026) — at each launch the app asks deskzo.com whether a newer version of its own screens
  is published, saying which version and native build it runs (`expo-updates`). No user, account or device
  identifier goes with it, and nothing is kept.

## Permissions the app asks for

| Info.plist key | When | Words shown |
|---|---|---|
| `NSCameraUsageDescription` | Scanning a pairing code; taking a photo for chat, a receipt or a Deskzo page | Deskzo uses the camera to scan the code that pairs this phone, and to take photos you send in chat, add to an expense claim or add on a Deskzo page. |
| `NSPhotoLibraryUsageDescription` | Picking photos to send (iOS's picker needs no permission; the key is there for the pages' own file inputs) | Deskzo opens your photos only to send the ones you pick — in chat, with an expense claim, or on a Deskzo page. |
| `NSLocationWhenInUseUsageDescription` | Clocking in or out; checking in or out of a visit; signing in where the company requires it | Deskzo reads where you are only when you clock in or out (to check you are at your office, and save it with your attendance), check in or out of a customer visit, or sign in if your company asks. Never in the background. |
| Notifications (no key) | Turning on calls on this iPhone, or "Turn on notifications" — never at launch | iOS's own question |

Not asked for, and refused by `npm run ios:check` if it ever appears: the microphone, contacts, Face ID, motion,
location always or in the background, full location accuracy, background modes.

## Encryption

The app uses only the system's HTTPS, which is exempt: `ITSAppUsesNonExemptEncryption` is `false`, so App Store
Connect asks no export-compliance questions.
