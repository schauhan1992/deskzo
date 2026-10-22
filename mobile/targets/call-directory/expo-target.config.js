/**
 * Deskzo's caller ID on an iPhone (owner, 22 Oct 2026): a CallKit Call Directory extension (CallDirectoryHandler.swift),
 * added to the Xcode project by @bacons/apple-targets at prebuild — never by hand in ios/. It shares the app's App
 * Group, where the app writes the customers' numbers for it (modules/deskzo-ios).
 *
 * Its bundle id is the app's with ".CallDirectory" — what the app asks iOS to reload, and what the extension reads its
 * App Group from. "Deskzo" is the name the person sees in Settings › Phone › Call Blocking & Identification.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: "call-directory",
  name: "DeskzoCallDirectory",
  displayName: "Deskzo",
  bundleIdentifier: ".CallDirectory",
  deploymentTarget: config.ios.deploymentTarget,
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
