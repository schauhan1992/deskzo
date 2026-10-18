#!/usr/bin/env node
/**
 * Runs Expo's Android commands with this computer's Java 17 and Android SDK, without changing any system
 * setting: both live in the user's own folder (%LOCALAPPDATA%\Programs\jdk-17 and %LOCALAPPDATA%\Android\Sdk).
 *
 *   npm run android:dev                 a development build on the emulator, talking to http://*.localhost
 *   node scripts/android.js prebuild    regenerate android/ from app.config.ts
 *   node scripts/android.js gradle assembleRelease
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
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (what === "dev") {
  env.DESKZO_APP_DEV = "1";
  run("npx", ["expo", "run:android", ...rest]);
} else if (what === "prebuild") {
  run("npx", ["expo", "prebuild", "--platform", "android", "--no-install", ...rest]);
} else if (what === "gradle") {
  // A debug build is a development build: it embeds app.config.ts as evaluated now, so say so here.
  if (rest.some((task) => /debug/i.test(task))) env.DESKZO_APP_DEV = "1";
  const dir = path.join(__dirname, "..", "android");
  // By its full path: Windows may not look in the current folder for a bare command name.
  run('"' + path.join(dir, process.platform === "win32" ? "gradlew.bat" : "gradlew") + '"', rest, { cwd: dir });
} else {
  run(what, rest);
}
