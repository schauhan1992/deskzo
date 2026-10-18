const { withAppBuildGradle } = require("expo/config-plugins");

/**
 * Release builds signed with Deskzo's upload key — which never goes in the repository. Its file and
 * passwords are Gradle properties kept on the computer that builds (in ~/.gradle/gradle.properties):
 *
 *   DESKZO_UPLOAD_STORE_FILE=C:/Users/<you>/.deskzo/upload-key.jks
 *   DESKZO_UPLOAD_STORE_PASSWORD=…
 *   DESKZO_UPLOAD_KEY_ALIAS=deskzo-upload
 *   DESKZO_UPLOAD_KEY_PASSWORD=…
 *
 * Without them a release build is signed with the debug key: fine to install for a test, refused by
 * Google Play. scripts/android.js release says which it did.
 */
const MARKER = "DESKZO_UPLOAD_STORE_FILE";

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    let text = mod.modResults.contents;
    if (text.includes(MARKER)) return mod;
    const debugKey = /(signingConfigs\s*\{\s*\n\s*debug\s*\{[^}]*\})/;
    if (!debugKey.test(text)) throw new Error("with-release-signing: no signingConfigs.debug in app/build.gradle");
    text = text.replace(
      debugKey,
      (found) =>
        `${found}\n        release {\n            // Deskzo's upload key, from ~/.gradle/gradle.properties (plugins/with-release-signing.js).\n            if (project.hasProperty('${MARKER}')) {\n                storeFile file(${MARKER})\n                storePassword DESKZO_UPLOAD_STORE_PASSWORD\n                keyAlias DESKZO_UPLOAD_KEY_ALIAS\n                keyPassword DESKZO_UPLOAD_KEY_PASSWORD\n            }\n        }`,
    );
    const releaseUsesDebug = /(release\s*\{[^{}]*?)signingConfig signingConfigs\.debug/;
    if (!releaseUsesDebug.test(text)) throw new Error("with-release-signing: no release build type signed with debug in app/build.gradle");
    text = text.replace(releaseUsesDebug, (_, before) => `${before}signingConfig project.hasProperty('${MARKER}') ? signingConfigs.release : signingConfigs.debug`);
    mod.modResults.contents = text;
    return mod;
  });
};
