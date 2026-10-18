const { withAppBuildGradle } = require("expo/config-plugins");

/**
 * Building on Windows: React Native's codegen puts C++ sources so deep that CMake's object files land past
 * Windows' 260-character path limit ("Filename longer than 260 characters"). Capping CMake's object paths
 * just under it makes CMake shorten the long ones to a hash itself, so the build works without turning on
 * long paths in Windows. The cap has to stay above the length of the object folders, or CMake can't shorten
 * anything under them — 128 was too low. Harmless elsewhere: only paths over the cap are shortened.
 */
const MARKER = "-DCMAKE_OBJECT_PATH_MAX=";

module.exports = function withShortNativePaths(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.contents.includes(MARKER)) return mod;
    const anchor = /defaultConfig\s*\{/;
    if (!anchor.test(mod.modResults.contents)) throw new Error("with-short-native-paths: no defaultConfig in app/build.gradle");
    mod.modResults.contents = mod.modResults.contents.replace(
      anchor,
      (found) => `${found}\n        externalNativeBuild {\n            cmake {\n                // Windows' 260-character limit (plugins/with-short-native-paths.js).\n                arguments "${MARKER}240"\n            }\n        }`,
    );
    return mod;
  });
};
