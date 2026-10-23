#!/usr/bin/env node
/**
 * Runs Expo's Android commands with this computer's Java 17 and Android SDK, without changing any system
 * setting: both live in the user's own folder (%LOCALAPPDATA%\Programs\jdk-17 and %LOCALAPPDATA%\Android\Sdk).
 *
 *   npm run android:dev                 a development build on the emulator, talking to http://*.localhost
 *   node scripts/android.js prebuild    regenerate android/ from app.config.ts
 *   node scripts/android.js gradle assembleRelease
 *   node scripts/android.js release        the release: the bundle for Google Play and an APK, checked
 *   node scripts/android.js updates-test   a release-like APK that takes its updates from the Deskzo on this computer
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const local = process.env.LOCALAPPDATA ?? "";
const env = {
  ...process.env,
  JAVA_HOME: process.env.JAVA_HOME || path.join(local, "Programs", "jdk-17"),
  ANDROID_HOME: process.env.ANDROID_HOME || path.join(local, "Android", "Sdk"),
};
env.ANDROID_SDK_ROOT = env.ANDROID_HOME;
env.PATH = [path.join(env.JAVA_HOME, "bin"), path.join(env.ANDROID_HOME, "platform-tools"), path.join(env.ANDROID_HOME, "emulator"), env.PATH].join(path.delimiter);

const [what = "dev", ...rest] = process.argv.slice(2);

/**
 * What Google Play is told the app asks for (store/data-safety.md, store/permissions-declaration.md). A
 * release that asks for anything else stops here rather than reaching the store.
 */
const ALLOWED_PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.READ_CALL_LOG",
  "android.permission.READ_PHONE_STATE",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.CAMERA",
  // Where the phone is when somebody clocks in or out — only while the app is open.
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_FINE_LOCATION",
  // Told that a screenshot was taken in the app (Android 14+), for the workspace's screenshot allowance.
  "android.permission.DETECT_SCREEN_CAPTURE",
  // Android's background jobs (WorkManager), which send the calls with the app closed.
  "android.permission.WAKE_LOCK",
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.VIBRATE",
  // Firebase Cloud Messaging receiving Deskzo's notifications (expo-notifications, 22 Oct 2026 — store/data-safety.md).
  "com.google.android.c2dm.permission.RECEIVE",
  "com.deskzo.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
];

/**
 * A release: android/ generated afresh without the development build's settings (no plain HTTP), then the
 * bundle Google Play takes (.aab) and an APK to install by hand, both checked before they're handed over.
 */
function release() {
  const fs = require("node:fs");
  delete env.DESKZO_APP_DEV;
  if (env.DESKZO_APP_UPDATES_URL) {
    console.error("DESKZO_APP_UPDATES_URL is set — a release takes its updates from deskzo.com. Unset it and build again.");
    process.exit(1);
  }
  run("npx", ["expo", "prebuild", "--platform", "android", "--no-install", "--clean"]);
  const dir = path.join(__dirname, "..", "android");
  run('"' + path.join(dir, process.platform === "win32" ? "gradlew.bat" : "gradlew") + '"', ["bundleRelease", "assembleRelease", "--console=plain"], { cwd: dir });

  const manifest = fs.readFileSync(path.join(dir, "app", "build", "intermediates", "merged_manifest", "release", "processReleaseMainManifest", "AndroidManifest.xml"), "utf8");
  const permissions = [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);
  const extra = permissions.filter((p) => !ALLOWED_PERMISSIONS.includes(p));
  const cleartext = /usesCleartextTraffic="true"/.test(manifest);
  const props = path.join(require("node:os").homedir(), ".gradle", "gradle.properties");
  const hasKey = fs.existsSync(props) && /^DESKZO_UPLOAD_STORE_FILE=/m.test(fs.readFileSync(props, "utf8"));

  console.log("\nPermissions:\n  " + permissions.join("\n  "));
  if (extra.length) {
    console.error(`\nThe release asks for permissions Google Play isn't told about: ${extra.join(", ")}. Block them in app.config.ts or add them to the store's declarations.`);
    process.exit(1);
  }
  if (cleartext) {
    console.error("\nThe release allows plain HTTP — it must only talk HTTPS. Was DESKZO_APP_DEV set?");
    process.exit(1);
  }
  console.log(`\nSigned with ${hasKey ? "Deskzo's upload key — ready for Google Play" : "the debug key — fine to install for a test; Google Play will refuse it (see plugins/with-release-signing.js)"}.`);
  console.log(`Bundle for Google Play: ${path.join(dir, "app", "build", "outputs", "bundle", "release", "app-release.aab")}`);
  console.log(`APK to install:         ${path.join(dir, "app", "build", "outputs", "apk", "release", "app-release.apk")}`);
  console.log(`Native build:           ${runtimeVersion()} — over-the-air updates published for it reach it (npm run app:update).`);
}

/** The runtime version a build of the app as it is now carries — the fingerprint of its native parts (app.config.ts). */
function runtimeVersion() {
  const r = spawnSync("npx", ["expo-updates", "runtimeversion:resolve", "--platform", "android"], { env, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("{"));
  return line ? JSON.parse(line).runtimeVersion : "(unknown)";
}

/**
 * A release-like build for trying over-the-air updates on the emulator: it asks the Deskzo on this computer
 * (http://localhost:3000, through `adb reverse tcp:3000 tcp:3000`) instead of deskzo.com, so it may talk plain HTTP
 * — never one to hand out. Publish to it with `npm run app:update -- publish --server http://localhost:3000` run with
 * the same DESKZO_APP_UPDATES_URL, so the update is for this build.
 */
function updatesTest() {
  delete env.DESKZO_APP_DEV;
  env.DESKZO_APP_UPDATES_URL = env.DESKZO_APP_UPDATES_URL || "http://localhost:3000/api/app-updates/manifest";
  run("npx", ["expo", "prebuild", "--platform", "android", "--no-install", "--clean"]);
  const dir = path.join(__dirname, "..", "android");
  run('"' + path.join(dir, process.platform === "win32" ? "gradlew.bat" : "gradlew") + '"', ["assembleRelease", "--console=plain"], { cwd: dir });
  console.log(`\nA test build asking ${env.DESKZO_APP_UPDATES_URL} — native build ${runtimeVersion()}:`);
  console.log(`  ${path.join(dir, "app", "build", "outputs", "apk", "release", "app-release.apk")}`);
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (what === "dev") {
  env.DESKZO_APP_DEV = "1";
  run("npx", ["expo", "run:android", ...rest]);
} else if (what === "prebuild") {
  run("npx", ["expo", "prebuild", "--platform", "android", "--no-install", ...rest]);
} else if (what === "release") {
  release();
} else if (what === "updates-test") {
  updatesTest();
} else if (what === "gradle") {
  // A debug build is a development build: it embeds app.config.ts as evaluated now, so say so here.
  if (rest.some((task) => /debug/i.test(task))) env.DESKZO_APP_DEV = "1";
  const dir = path.join(__dirname, "..", "android");
  // By its full path: Windows may not look in the current folder for a bare command name.
  run('"' + path.join(dir, process.platform === "win32" ? "gradlew.bat" : "gradlew") + '"', rest, { cwd: dir });
} else {
  run(what, rest);
}
