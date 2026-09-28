/**
 * Linked sign-in's kill switch — pauses every link and every switch between workspaces at once, or
 * resumes them (spec §3.4).
 *
 *   npm run linked-sign-in -- status
 *   npm run linked-sign-in -- off      paused: switchers say so, nothing links or switches
 *   npm run linked-sign-in -- on
 *
 * Links already made are kept either way. The running server follows within thirty seconds (its
 * copy of the switch). Each change is in the platform audit as `link.kill-switch`, by this script.
 * Owners can flip the same switch on the console's Settings page.
 */
import "dotenv/config";
import { closeControlDb, controlConfigured } from "../src/lib/platform/control-db";
import { linkedSignInSetting, setLinkedSignInEnabled } from "../src/lib/platform/linked/groups";

async function main() {
  if (!controlConfigured()) throw new Error("CONTROL_DATABASE_URL is not set — linked sign-in lives in the control plane (see .env.example).");
  const [command] = process.argv.slice(2);
  if (command === "on" || command === "off") {
    await setLinkedSignInEnabled(command === "on", "script:linked-sign-in");
  } else if (command !== "status") {
    console.log("Commands: status, on, off — see the top of scripts/linked-sign-in.ts.");
    process.exitCode = 1;
    return;
  }
  const setting = await linkedSignInSetting();
  const changed = setting.updatedAt ? ` (last set ${setting.updatedAt.toISOString()}${setting.updatedBy ? ` by ${setting.updatedBy}` : ""})` : " (never set: on by default)";
  console.log(`Linked sign-in is ${setting.enabled ? "on" : "off — paused everywhere"}${changed}.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
