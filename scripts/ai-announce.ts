/**
 * The What's new post for Deskzo AI on credits (owner, 17 Oct 2026: workspaces' own AI keys end at
 * launch, announced in What's new) — saved as a draft in console › Help content › What's new, for staff to
 * read, change and publish. Never published from here. Running it again finds the draft and leaves it.
 *
 *   npm run ai:announce              the draft, written by the first owner in the console
 *   npm run ai:announce -- --dry     says what it would do
 */
import "dotenv/config";
import { controlDb, closeControlDb } from "../src/lib/platform/control-db";

export const TITLE = "Deskzo AI: the copilot now runs on credits";

export const BODY = [
  "The AI copilot and Automate's “Draft with AI” now run on Deskzo AI — no API key to bring, nothing to set up. Requests are processed in India (Mumbai and Hyderabad) and are never used to train models.",
  "",
  "Every plan includes credits each month: 100 a person on Deskzo One, 50 a person on every other product, and 200 for a free trial. A copilot question usually takes 2–8 credits. When you need more, buy a pack in Settings → Plan & billing (500, 2,000 or 10,000 credits, valid for a year), or add AI Plus for 750 more every month.",
  "",
  "Keys saved for your own Claude, ChatGPT or Gemini account were removed, and the copilot no longer uses them. Admins switch the copilot and drafting on or off, and set a daily cap for each person, in Settings → Deskzo AI.",
].join("\n");

async function main() {
  const dry = process.argv.includes("--dry");
  const control = controlDb();
  const existing = await control.platformUpdate.findFirst({ where: { title: TITLE, archivedAt: null }, select: { id: true, publishedAt: true } });
  if (existing) {
    console.log(existing.publishedAt ? "Already published — nothing to do." : "The draft is already there — open it in console › Help content › What's new.");
    return;
  }
  const owner = await control.platformUser.findFirst({ where: { role: "OWNER", active: true }, orderBy: { createdAt: "asc" }, select: { id: true, email: true } });
  if (!owner) throw new Error("No active console owner to write it as. Add one first (npm run platform:staff).");
  if (dry) {
    console.log(`Would save a draft "${TITLE}" as ${owner.email}.`);
    return;
  }
  await control.platformUpdate.create({ data: { title: TITLE, body: BODY, createdById: owner.id, updatedById: owner.id }, select: { id: true } });
  console.log(`Saved the draft "${TITLE}". Read it and publish it in console › Help content › What's new.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
