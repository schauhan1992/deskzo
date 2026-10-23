#!/usr/bin/env node
/**
 * The iPhone's commands (owner, 22 Oct 2026), as scripts/android.js is Android's.
 *
 *   npm run ios:dev              a development build on the iOS Simulator, talking to http://*.localhost on this Mac
 *                                (needs a Mac with Xcode 26.4 or later — what Expo SDK 58 builds with)
 *   node scripts/ios.js prebuild regenerate ios/ from app.config.ts
 *   npm run ios:check            generate ios/ afresh as a release build would, and check what it asks for — works on
 *                                any computer, Linux included, as it needs no Xcode
 *
 * The App Store's builds are made by EAS (eas.json): npm run ios:build:preview, npm run ios:build:production.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const IOS = path.join(ROOT, "ios");
const env = { ...process.env };
const [what = "dev", ...rest] = process.argv.slice(2);

/**
 * What the App Store is told the app asks for (store/ios-privacy.md): the camera, the photos picked to send, and where
 * the phone is while the app is in use. Never the microphone, contacts, Face ID, motion, or location in the background.
 */
const ALLOWED_USAGE = ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription", "NSLocationWhenInUseUsageDescription"];

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32", cwd: ROOT, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

/** A release's ios/, generated afresh without the development build's settings, then checked. */
function check() {
  const plist = require("@expo/plist").default;
  delete env.DESKZO_APP_DEV;
  run("npx", ["expo", "prebuild", "--platform", "ios", "--no-install", "--clean"]);

  const app = fs.readdirSync(IOS).find((d) => fs.existsSync(path.join(IOS, d, "Info.plist")) && fs.existsSync(path.join(IOS, `${d}.xcodeproj`)));
  if (!app) fail("No app folder in ios/ after prebuild.");
  const info = plist.parse(fs.readFileSync(path.join(IOS, app, "Info.plist"), "utf8"));
  const entitlements = plist.parse(fs.readFileSync(path.join(IOS, app, `${app}.entitlements`), "utf8"));
  const project = fs.readFileSync(path.join(IOS, `${app}.xcodeproj`, "project.pbxproj"), "utf8");
  const problems = [];

  const usage = Object.keys(info).filter((k) => /^NS.*UsageDescription$/.test(k));
  for (const key of usage.filter((k) => !ALLOWED_USAGE.includes(k))) problems.push(`asks for ${key}, which the App Store isn't told about`);
  for (const key of ALLOWED_USAGE.filter((k) => !usage.includes(k))) problems.push(`has no ${key} — the app uses it, and iOS stops an app that asks without one`);
  if (info.NSLocationTemporaryUsageDescriptionDictionary) problems.push("asks for full location accuracy");
  if (info.UIBackgroundModes?.length) problems.push(`runs in the background (${info.UIBackgroundModes.join(", ")})`);
  const ats = info.NSAppTransportSecurity ?? {};
  if (ats.NSAllowsArbitraryLoads !== false || ats.NSAllowsLocalNetworking !== false || ats.NSExceptionDomains) problems.push("allows plain HTTP — a release must only talk HTTPS. Was DESKZO_APP_DEV set?");
  if (info.ITSAppUsesNonExemptEncryption !== false) problems.push("doesn't say it uses only exempt encryption (ITSAppUsesNonExemptEncryption)");
  if (info.UIUserInterfaceStyle !== "Automatic") problems.push("doesn't follow the phone's dark mode");
  if (entitlements["aps-environment"] !== "production") problems.push(`pushes through Apple's ${entitlements["aps-environment"] ?? "nothing"}, not production`);
  if (!(entitlements["com.apple.security.application-groups"] ?? []).includes(info.DeskzoAppGroup)) problems.push("isn't in the App Group the caller ID extension reads from");
  if (!project.includes("com.apple.callkit.call-directory") && !fs.existsSync(path.join(ROOT, "targets", "call-directory"))) problems.push("has no caller ID extension");
  if (!/DeskzoCallDirectory/.test(project)) problems.push("has no DeskzoCallDirectory target in the Xcode project");
  if (!fs.existsSync(path.join(IOS, app, "PrivacyInfo.xcprivacy"))) problems.push("has no privacy manifest (PrivacyInfo.xcprivacy)");

  console.log(`\nPermissions asked for:\n  ${usage.join("\n  ")}`);
  console.log(`Entitlements:\n  ${Object.keys(entitlements).join("\n  ")}`);
  if (problems.length) fail(`The release ${problems.join(";\n  ")}.`);
  console.log("\nios/ is ready for a release build: HTTPS only, the permissions the store is told of, caller ID, pushes.");
}

if (what === "dev") {
  env.DESKZO_APP_DEV = "1";
  run("npx", ["expo", "run:ios", ...rest]);
} else if (what === "prebuild") {
  run("npx", ["expo", "prebuild", "--platform", "ios", "--no-install", ...rest]);
} else if (what === "check") {
  check();
} else {
  fail(`Unknown command: ${what}. Use dev, prebuild or check.`);
}
