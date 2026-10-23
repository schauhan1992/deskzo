const path = require("node:path");

/**
 * The iPhone's launch screen, from expo-splash-screen's own iOS plugin — its iOS half only. Its Android half would
 * replace the splash Android has always had, and Android is to stay as it is: expo-splash-screen is left out of
 * Android's build too (package.json, expo.autolinking.android.exclude).
 *
 * The package exports only its whole plugin, so the iOS half is loaded by its file, from the package's own folder.
 * Takes the plugin's own props: backgroundColor, image, imageWidth, dark: { backgroundColor, image }.
 */
const root = path.dirname(require.resolve("expo-splash-screen/package.json"));
const { withIosSplashScreen } = require(path.join(root, "plugin", "build", "withIosSplashScreen"));

module.exports = function withIosSplash(config, props) {
  return withIosSplashScreen(config, props);
};
