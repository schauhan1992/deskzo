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
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: "deskzo",
  userInterfaceStyle: "light",
  android: {
    package: "com.deskzo.app",
    versionCode: 1,
    adaptiveIcon: {
      backgroundColor: "#4F46E5",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    // Only what calling needs; the camera is added by expo-camera, for scanning the pairing code.
    permissions: ["android.permission.READ_CALL_LOG", "android.permission.READ_PHONE_STATE", "android.permission.POST_NOTIFICATIONS"],
    blockedPermissions: ["android.permission.RECORD_AUDIO", "android.permission.SYSTEM_ALERT_WINDOW"],
    allowBackup: false,
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    ["expo-camera", { recordAudioAndroid: false, barcodeScannerEnabled: true, cameraPermission: "Deskzo uses the camera to scan the code that pairs this phone." }],
    ["expo-build-properties", { android: { usesCleartextTraffic: dev } }],
    "./plugins/with-short-native-paths",
  ],
  experiments: { typedRoutes: false },
  extra: { dev },
};

export default config;
