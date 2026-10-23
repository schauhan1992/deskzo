// Expo's own rules (npx expo lint). ios/ and android/ are generated (app.config.ts), never linted.
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");
const globals = require("globals");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "ios/*", "android/*", ".expo/*"],
  },
  {
    // The React Compiler's own checks. The app isn't built with the compiler (app.config.ts has no reactCompiler), and
    // the screens' effects and refs were written before these rules — meeting them means rewriting what Android runs
    // on, which is not to change. The rest of react-hooks (the rules of hooks, exhaustive deps) stays on.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      // TypeScript already checks every name read from a namespace; this rule can't follow expo-notifications'
      // re-exports and calls real ones missing (Notifications.AndroidImportance).
      "import/namespace": "off",
    },
  },
  {
    // Run by Node: the scripts, the config plugins, the targets' configs.
    files: ["scripts/**/*.js", "plugins/**/*.js", "targets/**/*.js", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    // The unit tests (npm test): Jest's globals.
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    languageOptions: { globals: globals.jest },
  },
]);
