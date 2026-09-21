/**
 * Runs a production build into `.next-build` instead of `.next`.
 *
 * A build and the dev server both default to `.next`, so verifying compilation while `next dev` is
 * running overwrites the chunks the dev server is serving — the browser then gets a stale mix,
 * which looks exactly like a change that didn't apply. This keeps the two apart.
 *
 * It's a script rather than an inline env var in package.json because npm runs scripts through
 * cmd.exe on Windows, where `VAR=value cmd` isn't a thing.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["next", "build"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: ".next-build" },
  shell: true,
});

process.exit(result.status ?? 1);
