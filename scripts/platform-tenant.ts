/**
 * Looking after workspaces from the server, until the platform console does it.
 *
 *   npm run platform:tenant -- list
 *   npm run platform:tenant -- invite [--note "Acme, via Ravi"] [--uses 1] [--days 14] [--plan crm-starter]
 *   npm run platform:tenant -- create --slug acme --company "Acme Ltd" --owner-name "Asha" --owner-email asha@acme.com --country IN [--plan crm-starter]
 *   npm run platform:tenant -- plans <slug> crm-starter extra-seats:2      the plans it is on, with quantities
 *   npm run platform:tenant -- entitlements <slug>                          what it may use, worked out again
 *   npm run platform:tenant -- suspend <slug> --reason "unpaid"
 *   npm run platform:tenant -- resume <slug>
 *   npm run platform:tenant -- deprovision <slug> [--no-backup]
 *   npm run platform:tenant -- purge <slug> [--force]
 *
 * `create` sets a workspace up without the signup form; the owner's password comes from the
 * environment (OWNER_PASSWORD), never the command line, and the worker does the rest. `invite` prints
 * a signup code once — only its hash is kept. Without --plan, a workspace starts on the default plan.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { closeControlDb, controlDb } from "../src/lib/platform/control-db";
import { deprovisionTenant, purgeTenant, resumeTenant, suspendTenant } from "../src/lib/platform/lifecycle";
import { startProvisioning } from "../src/lib/platform/provisioning";
import { setWorkspacePlans } from "../src/lib/platform/plans";
import { refreshEntitlements } from "../src/lib/platform/entitlements";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ACTOR = "platform:tenant";

async function bySlug(slug: string | undefined) {
  if (!slug) throw new Error("Which workspace? Give its slug.");
  const tenant = await controlDb().tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error(`There is no workspace "${slug}".`);
  return tenant;
}

async function main() {
  const [command, target] = args;
  switch (command) {
    case "list": {
      const rows = await controlDb().tenant.findMany({ orderBy: { createdAt: "asc" }, select: { slug: true, name: true, status: true, isDefault: true, schemaVersion: true } });
      for (const r of rows) console.log(`${r.slug.padEnd(24)} ${r.status.padEnd(14)} ${r.isDefault ? "first " : "      "}${r.name}  (${r.schemaVersion ?? "—"})`);
      return;
    }
    case "invite": {
      const code = randomBytes(9).toString("base64url");
      const days = Number(flag("days") ?? 14);
      const planKey = flag("plan") ?? null;
      if (planKey && !(await controlDb().plan.findFirst({ where: { key: planKey, active: true } }))) throw new Error(`There is no plan "${planKey}" on offer.`);
      await controlDb().signupInvite.create({
        data: {
          codeHash: createHash("sha256").update(code).digest("hex"),
          note: flag("note") ?? null,
          maxUses: Number(flag("uses") ?? 1),
          expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : null,
          createdBy: ACTOR,
          planKey,
        },
      });
      console.log(`Invitation code (shown once): ${code}`);
      return;
    }
    case "create": {
      const password = process.env.OWNER_PASSWORD;
      if (!password || password.length < 10) throw new Error("Put the owner's password in OWNER_PASSWORD (10 characters or more) — never on the command line.");
      const created = await startProvisioning({
        slug: flag("slug") ?? "",
        companyName: flag("company") ?? "",
        ownerName: flag("owner-name") ?? "",
        ownerEmail: flag("owner-email") ?? "",
        ownerPasswordHash: await bcrypt.hash(password, 10),
        country: flag("country") ?? "IN",
        planKey: flag("plan") ?? null,
      });
      console.log(`Queued ${flag("slug")} (${created.tenantId}). npm run platform:worker -- --once sets it up now.`);
      return;
    }
    case "plans": {
      const t = await bySlug(target);
      const items = args.slice(2).filter((a) => !a.startsWith("--")).map((a) => {
        const [planKey, qty] = a.split(":");
        return { planKey: planKey!, quantity: qty ? Number(qty) : 1 };
      });
      if (!items.length) throw new Error("Which plans? e.g. plans acme crm-starter extra-seats:2");
      await setWorkspacePlans(t.id, items, `script:${ACTOR}`);
      console.log(`${t.slug} is on ${items.map((i) => (i.quantity > 1 ? `${i.planKey} ×${i.quantity}` : i.planKey)).join(", ")}.`);
      return;
    }
    case "entitlements": {
      const t = await bySlug(target);
      const e = await refreshEntitlements(t.id);
      console.log(`${t.slug} (${t.country}) — plans: ${e.plans.join(", ") || "none"}`);
      console.log(`  modules: ${e.all ? "every module" : e.modules.join(", ") || "the core only"}`);
      console.log(`  seats: ${e.seats ?? "no limit"}   copilot tokens a month: ${e.copilotTokens ?? "no limit"}`);
      return;
    }
    case "suspend": {
      const t = await bySlug(target);
      await suspendTenant(t.id, ACTOR, flag("reason") ?? "held from the server");
      console.log(`${t.slug} is suspended.`);
      return;
    }
    case "resume": {
      const t = await bySlug(target);
      await resumeTenant(t.id, ACTOR);
      console.log(`${t.slug} is open again.`);
      return;
    }
    case "deprovision": {
      const t = await bySlug(target);
      const { backup } = await deprovisionTenant(t.id, ACTOR, { finalBackup: !args.includes("--no-backup") });
      console.log(`${t.slug} is closed.${backup ? ` Final backup: ${backup}.` : ""} Its keys are kept for the retention period; purge wipes them.`);
      return;
    }
    case "purge": {
      const t = await bySlug(target);
      await purgeTenant(t.id, ACTOR, { force: args.includes("--force") });
      console.log(`${t.slug}: keys wiped and backups deleted.`);
      return;
    }
    default:
      console.log("Commands: list, invite, create, plans, entitlements, suspend, resume, deprovision, purge — see the top of scripts/platform-tenant.ts.");
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
