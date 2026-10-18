/**
 * eval:automate-drafting — Deskzo Automate, Phase 5 acceptance (plan of 17 Oct 2026): "Of 20 written
 * descriptions, at least 16 become valid drafts needing only their blanks filled, on each of the three
 * providers."
 *
 * THIS CALLS A REAL AI PROVIDER AND SPENDS ITS TOKENS. It is not a check suite and nothing runs it on
 * its own. It drafts in a scratch workspace that holds no customer data, and drops it at the end.
 *
 *   AUTOMATE_EVAL_PROVIDER=ANTHROPIC|OPENAI|GEMINI  AUTOMATE_EVAL_MODEL=<model>  AUTOMATE_EVAL_KEY=<key>  npm run eval:automate-drafting
 *
 * Set the key in your own shell; it is never printed. A draft counts when it came back, is a workflow
 * Deskzo can read, and has no problem other than its blanks (a person, connection, record or stage to
 * choose). Each description's result and the problems left are printed.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import type { AiProvider } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";

const DESCRIPTIONS = [
  "When a new lead comes in from the website, let the assignment rules give it to someone and email the contact a thank-you.",
  "When a lead is won, create a task for its owner to send the welcome kit, due in 2 days.",
  "Every Monday at 9:00, email me a report of last week's leads by owner.",
  "When a ticket is opened with high priority, notify the support manager.",
  "When an invoice becomes overdue by 7 days, email the customer's main contact a polite reminder from the company's mail server.",
  "When a lead has gone quiet for 10 days, give its owner a task to follow up.",
  "When a lead moves to Qualified, post a message to our sales Slack channel with the lead's title.",
  "When a payment comes in, notify the account manager of the customer.",
  "When somebody books a slot, wait until an hour before it starts and send the booker a WhatsApp reminder using the template booking_reminder.",
  "When a form is sent, create a lead from it and tell the owner of the workflow.",
  "When a document is issued and it's a quotation, wait 3 days, then create a task for the salesperson to follow up.",
  "When a subscription is 30 days from renewal, email the customer's main contact and create a task for the account manager.",
  "When a ticket's status changes to resolved, email the contact asking for feedback.",
  "When a lead is lost, add a note on the lead saying it was reviewed, and tell the sales head.",
  "When an outside app calls the webhook with a name and an email, create a lead from them.",
  "When a lead is created with a value above 500000, notify the owner of the workflow and the lead owner.",
  "Every day at 18:00, post to our Teams channel that the daily backup reminder is due.",
  "When a task is completed, if it was about a lead, add a note on the lead.",
  "When an order is approved, call our ERP's API to create the order there with its number and quantity.",
  "When a lead comes in from the website, add a row to our leads Google Sheet with the lead's title, source and value.",
];

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function main() {
  const provider = (process.env.AUTOMATE_EVAL_PROVIDER ?? "") as AiProvider;
  const model = process.env.AUTOMATE_EVAL_MODEL ?? "";
  const key = process.env.AUTOMATE_EVAL_KEY ?? "";
  if (!["ANTHROPIC", "OPENAI", "GEMINI"].includes(provider) || !model || !key) {
    console.error("Set AUTOMATE_EVAL_PROVIDER (ANTHROPIC, OPENAI or GEMINI), AUTOMATE_EVAL_MODEL and AUTOMATE_EVAL_KEY in your shell first.");
    process.exitCode = 2;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("Runs only beside a local database.");
  const realName = new URL(url).pathname.slice(1);
  const names = { a: `${realName}_autoeval_a`, control: `${realName}_autoeval_ctl` };
  const admin = directClient(withDatabase(url, "postgres"));
  let close: (() => Promise<void>) | null = null;
  try {
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.a}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, names.a) }, timeout: 10 * 60_000 });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.control}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: withDatabase(url, names.control) }, timeout: 5 * 60_000 });
    process.env.TENANT_DB_ZZEVAL_A = withDatabase(url, names.a);
    process.env.CONTROL_DATABASE_URL = withDatabase(url, names.control);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    close = async () => {
      await closeAllClients();
      await closeControlDb();
    };
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { draftWithAI } = require("../src/lib/automate/ai/draft") as typeof import("../src/lib/automate/ai/draft");
    const copilotSettings = require("../src/lib/copilot/settings") as typeof import("../src/lib/copilot/settings");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const tenant = (await registry.tenantBySlug("zzeval-a"))!;
    const inA = <T,>(work: () => Promise<T>) => runAsTenant(tenant, work);
    const owner = await inA(() => db.user.create({ data: { name: "Eval Owner", email: "eval-owner@zzeval.invalid", passwordHash: "!", role: "ADMIN", isSuperAdmin: true }, select: { id: true } }));
    // Drafting goes through Deskzo AI's gateway: a route to the provider and model asked for, on the key from the shell.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const aiAccounts = require("../src/lib/ai/accounts") as typeof import("../src/lib/ai/accounts");
    aiAccounts.setTestRoute((feature) => ({
      feature,
      model: { key: `eval-${model}`, label: model, providerModel: model, inputRate: 0, outputRate: 0, inputCost: null, outputCost: null },
      account: { id: "eval", name: "eval", kind: provider, residency: "eval", noTraining: false },
      connection: () => ({ kind: provider, apiKey: key }),
    }));
    copilotSettings.setTestSettings({ enabled: false, draftingEnabled: true, dailyCreditLimit: null });

    console.log(`\nDrafting ${DESCRIPTIONS.length} descriptions with ${provider} (${model})\n`);
    let good = 0;
    const tokens = { input: 0, output: 0 };
    for (const [i, description] of DESCRIPTIONS.entries()) {
      const started = Date.now();
      try {
        const d = await inA(() => draftWithAI({ userId: owner.id, description }));
        tokens.input += d.usage.input;
        tokens.output += d.usage.output;
        const usable = d.others.length === 0;
        if (usable) good += 1;
        console.log(`${usable ? "  ok  " : " MISS "} ${String(i + 1).padStart(2)}. ${d.name} — ${d.definition.steps.length} steps, ${d.blanks.length} blank(s), ${d.usage.turns} turn(s), ${Math.round((Date.now() - started) / 1000)} s`);
        for (const p of d.others) console.log(`         ${p.stepId ?? "trigger"}${p.field ? `/${p.field}` : ""}: ${p.message}`);
      } catch (err) {
        console.log(` MISS  ${String(i + 1).padStart(2)}. refused: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`\n${good} of ${DESCRIPTIONS.length} usable (the plan asks for 16). Tokens: ${tokens.input.toLocaleString("en-IN")} in, ${tokens.output.toLocaleString("en-IN")} out.\n`);
    if (good < 16) process.exitCode = 1;
  } finally {
    if (close) await close().catch(() => undefined);
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    await admin.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
