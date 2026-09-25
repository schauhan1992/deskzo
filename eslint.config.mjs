import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  /**
   * Multi-tenancy guard rails — the editor-time half of `npm run check:tenancy`. One server answers
   * for every workspace, so anything that caches, batches or defers work without knowing which
   * workspace it is for can hand one customer's data to another. See src/lib/tenancy.
   */
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='$transaction'][arguments.0.type!='ArrowFunctionExpression'][arguments.0.type!='FunctionExpression']",
          message: "Use the interactive form — db.$transaction(async (tx) => { … }). The array form needs its queries built on one client up front, which the per-workspace db can't do.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "next/server", importNames: ["after"], message: "after() from a page can't see which workspace it is for — use tenantAfter() from src/lib/tenancy." },
            { name: "next/cache", importNames: ["unstable_cache"], message: "Next's data cache is shared by every workspace — cache per workspace with src/lib/tenancy/cache." },
          ],
        },
      ],
    },
  },
  /**
   * A promise where a yes/no belongs. `if (secretMatches(…))` is always true — a promise is a value —
   * and the type checker says nothing. Found twice when stored-secret encryption went asynchronous
   * (per-workspace keys): an API key check and a redirect guard, both of which would have let
   * everything through.
   */
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.ts", "prisma/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksConditionals: true, checksSpreads: true, checksVoidReturn: false }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // This project builds to .next-build (see scripts/build-check.mjs), which the default ignore
    // list doesn't know about. Without this, generated chunks bury real findings in src.
    ".next-build/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
