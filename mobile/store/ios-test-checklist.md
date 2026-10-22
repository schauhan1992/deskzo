# The iPhone app — tests by hand

What the automated checks can't show — they need a real iPhone, Apple's push service or a Mac with Xcode 26.4+:

- `npm test` (the unit tests), `npx tsc --noEmit`, `npm run lint`, `npx expo-doctor` and `npm run ios:check` (ios/ as a
  release generates it) run anywhere; the server's `npm run check:phone-app` and `check:app-daily` run against the
  database.
- The Swift (`modules/deskzo-ios`, `targets/call-directory`) has only been type-checked, against the iOS 18 SDK — the
  whole app has never been compiled or run on a device. That is what this list is for.

Do it on a **real iPhone** with a TestFlight or ad hoc build of the release (not a development build), against the live
site or the demo workspace, with a second phone to call from. Note the iPhone model and iOS version, and tick each.

## 1. Installing and signing in

- [ ] Installed, the icon is the indigo D, square-cornered by iOS; in Settings › Home Screen › Dark, the dark icon; Tinted, the tinted one.
- [ ] The launch screen is white with the D (dark phone: dark with the light D), then the sign-in screen.
- [ ] **Browser sign-in**: type the workspace, Sign in — a Safari sheet asks "Deskzo wants to use … to sign in"; sign in, Allow — the app opens on Today.
- [ ] **QR pairing**: Pair with a code › Scan the code — the camera permission asks with the camera words; scan Settings › Deskzo app on a computer — signed in.
- [ ] **Code pairing**: type the address and the ten-letter code — signed in.
- [ ] Close the app (swipe it away) and open it again — still signed in, no sign-in screen.
- [ ] Restart the iPhone, open the app before and after unlocking — signed in once unlocked.
- [ ] Delete the app and install it again — it starts on the sign-in screen (the token isn't left in the Keychain).
- [ ] An administrator revokes the phone in Security › Devices — the next screen says this iPhone was signed out.

## 2. Today, Tasks, Approvals, Leave

- [ ] Clock in where the office checks location: iOS asks for location **While Using the App** (not Always); the words are the app's; clocked in.
- [ ] Refuse location: the card says how to allow it, and Open the app's settings goes to Deskzo's settings.
- [ ] Location off entirely (Settings › Privacy › Location Services): the card says so.
- [ ] Settings › Privacy › Location Services › Deskzo lists only Never / Ask Next Time / While Using — no Always.
- [ ] Tasks: tick one off, open it again, add one. Approvals: approve one, reject one with a reason. Leave: ask for two days, cancel it.
- [ ] Pull to refresh on each.
- [ ] The **notifications** card on Today: Turn on asks iOS's question once; Not now hides it for good (Settings › Notifications still has it).

## 3. Chat

- [ ] A conversation: send text; a photo from **Photos** (iOS's picker — no permission asked); a photo from the **Camera**; a PDF from **Files**.
- [ ] Long-press a message › Copy — paste it elsewhere. Where the workspace blocks copying, Copy isn't offered.
- [ ] Swipe a message right to reply; swipe from the left edge to go back to the list.
- [ ] The keyboard doesn't cover the message field, on an iPhone with a home bar and on an iPhone SE.
- [ ] With the app open on another tab, a message shows the app's own banner, not iOS's.

## 4. The Deskzo tab

- [ ] Opens signed in (Dashboard), no sign-in page.
- [ ] Swipe from the left edge goes back a page.
- [ ] A link to another site opens in Safari; an email address opens Mail.
- [ ] A phone number on a contact dials (iOS asks "Call …?") and, back in the app after the call, the after-call sheet opens.
- [ ] Upload: a page's file input offers Photo Library / Take Photo / Choose File; the file arrives.
- [ ] Download a file the server sends (a document's PDF, a chat file): the share sheet; Save to Files saves it; no "Save Image" (it would need a permission the app doesn't have).
- [ ] Download an export the page makes itself (Leads › Export, the aging report): the share sheet with the CSV or Excel file, named as on a computer.
- [ ] A page with something embedded from another site (a map, a payment form) shows it inside the page — Safari doesn't open.
- [ ] Sign out of Deskzo (Settings) and sign in again — the Deskzo tab asks nothing and opens as the new sign-in (the old cookies went).

## 5. Calls on this iPhone

- [ ] Calls › Set up calls on this iPhone: the words say iPhones don't let apps read calls; Turn on — iOS asks to send notifications.
- [ ] Settings › Phone › Call Blocking & Identification lists **Deskzo**; turn it on. Back in the app, Settings shows "Caller ID is on" and how many numbers were loaded.
- [ ] Refresh caller ID — the count and time update.
- [ ] **Caller ID**: from the second phone, call from a number that is a contact in Deskzo (written with +91, without it, or with a 0 — try each) — the iPhone shows "Ravi Kumar · Acme" under the number while it rings (iOS adds that Deskzo identified it).
- [ ] A contact the person can't see in Deskzo (another rep's account, a reseller's customer): no name.
- [ ] Add a contact in Deskzo, reopen the app (or Refresh) — their name shows on the next call.
- [ ] **After-call sheet**: Calls › Callbacks › Call — iOS asks "Call …?"; Cancel: no sheet. Call, talk, hang up, back to the app: "How did it go?" with the contact's name; Connected + a note + Tomorrow 10:00 + a lead; Save. In Deskzo on a computer: the call on the contact's history with the note, the callback as a task, the length shown as not known.
- [ ] Call, then stay out of the app for more than two minutes: a quiet notification "How did the call with … go?" is in Notification Centre; tapping it opens the sheet.
- [ ] Not now on the sheet: nothing logged.
- [ ] **Log a call**: a number typed by hand, They called me, Connected, Save — logged.
- [ ] A number that isn't a customer: the sheet says so, and there is nothing to save.
- [ ] **Ring my phone** (needs `DESKZO_APP_APNS_KEY` on the server): from a contact on a computer, Ring my phone — with the iPhone locked, a notification "Call Ravi Kumar, Acme" arrives within seconds; long-press it › **Call** — the app opens and iOS asks "Call …?"; call — afterwards, the sheet, and the call is logged with what the dialog was about. Tapping the notification itself opens Calls with the ring on top.
- [ ] With the app open on Calls, a ring appears there without a notification banner getting in the way.
- [ ] Turn calls off on this iPhone: caller ID no longer shows names; Ring my phone says no phone of yours has calling on.

## 6. Notifications

- [ ] A colleague sends a message with the app closed: "New message from Priya" — never what it says; tapping it opens that conversation.
- [ ] A muted chat: nothing.
- [ ] A leave request that the person approves: "… waiting for your decision"; tapping it opens Approvals.
- [ ] Notifications off in iOS Settings: Settings › Notifications in the app offers to open iOS's settings.
- [ ] Sign out: Notification Centre has nothing of Deskzo's left; a message to the person afterwards doesn't reach the phone.

## 7. Screen rules (a workspace that limits screenshots or watermarks)

- [ ] A screenshot in the app is counted in the workspace's security log, and the app says how many are left. (iOS can't block them — past the allowance they are still counted.)
- [ ] The watermark shows on the customer screens and not on the Deskzo tab.

## 8. How it looks and reads

- [ ] **Dark mode** (Control Centre): every screen dark — Today, Calls, the after-call sheet, chat (dark bubbles and wallpaper), Settings, the tab bar and headers; nothing white left, all text readable.
- [ ] **Dynamic Type** at the largest accessibility size (Settings › Accessibility › Display & Text Size): text grows, nothing overlaps or is cut off on Today, the calendar on Leave, chat bubbles, the after-call sheet.
- [ ] **VoiceOver**: every button and field says what it is — the gear, the tabs, Call, Done, the chips (as selected or not), the attach and send buttons, the calendar's days; Approve/Reject on each item.
- [ ] **Notch and Dynamic Island**: nothing under them, on an iPhone 15 Pro or later and an iPhone SE.
- [ ] **iPad**, portrait and landscape: the screens sit in a column of readable width; the share sheet for a download appears as a popover; pairing by QR works with the iPad's camera.

## 9. Once, before submitting

- [ ] `npm run ios:check` passes on the commit being built.
- [ ] The build's Info.plist (App Store Connect › TestFlight › the build › Build Metadata) lists only camera, photos and location when in use.
