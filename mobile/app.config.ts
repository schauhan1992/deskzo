import type { ExpoConfig } from "expo/config";

// Read by Node when Expo loads this file; the app's own types don't include Node's.
declare const require: (id: "node:fs") => { existsSync: (file: string) => boolean };
declare const __dirname: string;

/**
 * The Deskzo app (owner, 18 Oct 2026) — Android first, calling first; and the iPhone (owner, 22 Oct 2026), from the
 * same code, with what iOS allows instead of the call log (README.md, "On an iPhone").
 *
 * DESKZO_APP_DEV=1 makes a development build: it may talk plain HTTP, to a Deskzo running on this
 * computer (a `*.localhost` workspace, reached from the emulator at 10.0.2.2, or from the iOS Simulator at
 * 127.0.0.1). A release build only ever talks HTTPS to a real workspace.
 */
const dev = process.env.DESKZO_APP_DEV === "1";

/**
 * Notifications with the app closed (owner, 22 Oct 2026) come through Firebase Cloud Messaging on Android: Deskzo's own
 * Firebase project's google-services.json, kept beside this file (it holds only public identifiers). Without it the app
 * still builds and works — it just asks nothing of Firebase, and gets no notifications while closed. An iPhone's come
 * through Apple's own service (APNs), which needs no file here.
 */
const firebase = require("node:fs").existsSync(`${__dirname}/google-services.json`);

/** Shared with the caller ID extension (targets/call-directory), which reads the customers' numbers from it. */
const APP_GROUP = "group.com.deskzo.app";

const config: ExpoConfig = {
  name: "Deskzo",
  slug: "deskzo",
  version: "0.3.1",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: "deskzo",
  userInterfaceStyle: "light",
  android: {
    package: "com.deskzo.app",
    versionCode: 5,
    adaptiveIcon: {
      backgroundColor: "#4F46E5",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    // Calling, and where the phone is when somebody clocks in or out (asked then, only while the app is open);
    // the camera is added by expo-camera, for scanning the pairing code.
    permissions: [
      "android.permission.READ_CALL_LOG",
      "android.permission.READ_PHONE_STATE",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
    ],
    // Nothing the app does: the microphone, drawing over other apps, files, and location in the background or
    // motion (a library asks for them on its own).
    blockedPermissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
      "android.permission.FOREGROUND_SERVICE_LOCATION",
      "android.permission.ACTIVITY_RECOGNITION",
      // Asked for by expo-notifications' launcher-badge library and by an install-referrer library: the app sets no
      // badge counts (src/lib/push.ts — shouldSetBadge: false) and tracks no installs (22 Oct 2026).
      "com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE",
      "android.permission.READ_APP_BADGE",
      "com.android.launcher.permission.READ_SETTINGS",
      "com.android.launcher.permission.WRITE_SETTINGS",
      "com.android.launcher.permission.INSTALL_SHORTCUT",
      "com.android.launcher.permission.UNINSTALL_SHORTCUT",
      "com.sec.android.provider.badge.permission.READ",
      "com.sec.android.provider.badge.permission.WRITE",
      "com.htc.launcher.permission.READ_SETTINGS",
      "com.htc.launcher.permission.UPDATE_SHORTCUT",
      "com.sonyericsson.home.permission.BROADCAST_BADGE",
      "com.sonymobile.home.permission.PROVIDER_INSERT_BADGE",
      "com.anddoes.launcher.permission.UPDATE_COUNT",
      "com.majeur.launcher.permission.UPDATE_BADGE",
      "com.huawei.android.launcher.permission.CHANGE_BADGE",
      "com.huawei.android.launcher.permission.READ_SETTINGS",
      "com.huawei.android.launcher.permission.WRITE_SETTINGS",
      "com.oppo.launcher.permission.READ_SETTINGS",
      "com.oppo.launcher.permission.WRITE_SETTINGS",
      "me.everything.badger.permission.BADGE_COUNT_READ",
      "me.everything.badger.permission.BADGE_COUNT_WRITE",
    ],
    allowBackup: false,
    predictiveBackGestureEnabled: false,
    ...(firebase ? { googleServicesFile: "./google-services.json" } : {}),
  },
  ios: {
    bundleIdentifier: "com.deskzo.app",
    buildNumber: "1",
    // The minimum Expo SDK 58 supports; the caller ID extension follows it.
    deploymentTarget: "16.4",
    supportsTablet: true,
    // The phone's light or dark appearance (src/components/ui.tsx). Android stays light.
    userInterfaceStyle: "automatic",
    // Opaque and edge to edge — the App Store refuses an icon with transparency (scripts/brand-assets.js).
    icon: { light: "./assets/ios-icon.png", dark: "./assets/ios-icon-dark.png", tinted: "./assets/ios-icon-tinted.png" },
    // Signing is EAS's (eas.json); a team is only needed to build with Xcode on a Mac.
    appleTeamId: process.env.DESKZO_APPLE_TEAM_ID || undefined,
    // HTTPS through the system's own TLS only: exempt from export compliance.
    config: { usesNonExemptEncryption: false },
    entitlements: {
      // Pushes from Deskzo ("Ring my phone", chat, approvals) — Apple's sandbox for a development build.
      "aps-environment": dev ? "development" : "production",
      "com.apple.security.application-groups": [APP_GROUP],
    },
    infoPlist: {
      // A release only ever talks HTTPS; a development build may reach this computer's Deskzo over plain HTTP.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: dev },
      // For the iPhone module (modules/deskzo-ios): where the caller ID list goes, and the extension iOS reloads.
      DeskzoAppGroup: APP_GROUP,
      DeskzoCallDirectory: "com.deskzo.app.CallDirectory",
    },
    // What the app's own code reads from the phone, and what leaves it (store/ios-privacy.md). The libraries' own
    // manifests are merged in at pod install. Nothing is used for tracking.
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyAccessedAPITypes: [
        // The app's own defaults: whether it has run since it was installed (modules/deskzo-ios).
        { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults", NSPrivacyAccessedAPITypeReasons: ["CA92.1"] },
        // React Native's own, as Expo's guide lists them.
        { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp", NSPrivacyAccessedAPITypeReasons: ["C617.1"] },
        { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime", NSPrivacyAccessedAPITypeReasons: ["35F9.1"] },
        { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace", NSPrivacyAccessedAPITypeReasons: ["E174.1", "85F4.1"] },
      ],
      NSPrivacyCollectedDataTypes: [
        // Where the phone is when somebody clocks in or out, checks in or out of a visit, or signs in where their company requires it.
        { NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypePreciseLocation", NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
        { NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeCoarseLocation", NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
        // Team chat's messages.
        { NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeEmailsOrTextMessages", NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
        // The photos somebody picks or takes to send in chat, and a receipt's for an expense claim.
        { NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypePhotosorVideos", NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
        // Expense claims made in the app: the amount and what it was for — never a card or bank details.
        { NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeOtherFinancialInfo", NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
        // A call logged from the after-call sheet, its notes; leads, visits, meetings, tasks, leave, decisions; documents sent in chat.
        { NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeOtherUserContent", NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
        // The phone's own sign-in, its model and the app's version — administrators see it in Security › Devices.
        { NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeDeviceID", NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
        // That a screenshot was taken, where the company limits them — never what is in it.
        { NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeOtherUsageData", NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
      ],
    },
  },
  plugins: [
    "expo-router",
    // iOS: the camera only — never the microphone (its default asks for both, and is applied after expo-image-picker's).
    [
      "expo-camera",
      {
        recordAudioAndroid: false,
        barcodeScannerEnabled: true,
        cameraPermission: "Deskzo uses the camera to scan the code that pairs this phone, and to take photos you send in chat, add to an expense claim or add on a Deskzo page.",
        microphonePermission: false,
      },
    ],
    // Photos for chat: Android's own photo picker (no permission), or the camera; never the microphone.
    [
      "expo-image-picker",
      {
        photosPermission: "Deskzo opens your photos only to send the ones you pick — in chat, with an expense claim, or on a Deskzo page.",
        cameraPermission: "Deskzo uses the camera to scan the code that pairs this phone, and to take photos you send in chat, add to an expense claim or add on a Deskzo page.",
        microphonePermission: false,
      },
    ],
    [
      "expo-location",
      {
        locationWhenInUsePermission: "Deskzo reads where you are only when you clock in or out (to check you are at your office, and save it with your attendance), check in or out of a customer visit, or sign in if your company asks. Never in the background.",
        locationAlwaysAndWhenInUsePermission: false,
        locationAlwaysPermission: false,
        motionUsagePermission: false,
        locationFullAccuracyPermission: false,
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: false,
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          usesCleartextTraffic: dev,
          // A release is shrunk (R8). Android's background jobs (WorkManager) open their database by a constructor
          // nothing calls directly — kept, or the app crashes on launch; the calling module, kept whole; and the
          // pairing scanner's parts (ML Kit), which Google's component discovery makes by their constructors.
          extraProguardRules:
            "-keep class * extends androidx.room.RoomDatabase { <init>(); }\n-keep class com.deskzo.calls.** { *; }\n-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }",
        },
      },
    ],
    // Deskzo's notifications — a lead given to you, something to approve, a task, a ticket's reply (src/lib/push.ts).
    ["expo-notifications", { icon: "./assets/android-icon-monochrome.png", color: "#4F46E5", defaultChannel: "deskzo" }],
    "./plugins/with-short-native-paths",
    "./plugins/with-release-signing",
    // iOS: the caller ID extension (targets/call-directory), and the launch screen — light, and dark for a dark phone.
    "@bacons/apple-targets",
    ["./plugins/with-ios-splash", { backgroundColor: "#FFFFFF", image: "./assets/splash-icon.png", imageWidth: 120, dark: { backgroundColor: "#0F172A", image: "./assets/ios-icon-dark.png" } }],
  ],
  experiments: { typedRoutes: false },
  // The app's project on EAS (eas.json), where its iOS builds are made.
  extra: { dev, firebase, eas: { projectId: "41dff9e9-46dd-4253-99c9-b85e40e7122e" } },
};

export default config;
