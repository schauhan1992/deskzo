import type { ExpoConfig } from "expo/config";

/**
 * The Deskzo app (owner, 18 Oct 2026) — Android first, calling first.
 *
 * DESKZO_APP_DEV=1 makes a development build: it may talk plain HTTP, to a Deskzo running on this
 * computer (a `*.localhost` workspace, reached from the emulator at 10.0.2.2). A release build only ever
 * talks HTTPS to a real workspace.
 */
const dev = process.env.DESKZO_APP_DEV === "1";

const config: ExpoConfig = {
  name: "Deskzo",
  slug: "deskzo",
  version: "0.2.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: "deskzo",
  userInterfaceStyle: "light",
  android: {
    package: "com.deskzo.app",
    versionCode: 2,
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
    ],
    allowBackup: false,
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    ["expo-camera", { recordAudioAndroid: false, barcodeScannerEnabled: true, cameraPermission: "Deskzo uses the camera to scan the code that pairs this phone, and to take photos you send in chat." }],
    // Photos for chat: Android's own photo picker (no permission), or the camera; never the microphone.
    [
      "expo-image-picker",
      {
        photosPermission: "Deskzo opens your photos only to send the ones you pick in chat.",
        cameraPermission: "Deskzo uses the camera to scan the code that pairs this phone, and to take photos you send in chat.",
        microphonePermission: false,
      },
    ],
    [
      "expo-location",
      {
        locationWhenInUsePermission: "Deskzo saves where you are when you clock in or out, with your attendance. Only then — never in the background.",
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
          // nothing calls directly — kept, or the app crashes on launch; and the calling module, kept whole.
          extraProguardRules: "-keep class * extends androidx.room.RoomDatabase { <init>(); }\n-keep class com.deskzo.calls.** { *; }",
        },
      },
    ],
    "./plugins/with-short-native-paths",
    "./plugins/with-release-signing",
  ],
  experiments: { typedRoutes: false },
  extra: { dev },
};

export default config;
