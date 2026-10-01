/**
 * The partner programme from the server — above all a partner's first admin, and moving workspaces to
 * a partner in bulk (the console moves them one at a time).
 *
 *   npm run partners -- list
 *   npm run partners -- user list <partner-slug>
 *   npm run partners -- user create <partner-slug> --email asha@acme.example --name "Asha" [--role ADMIN|FINANCE|SALES|VIEWER]
 *   npm run partners -- user link <email>              a new one-time link to choose a password
 *   npm run partners -- user reset-2fa <email>         a lost phone: their authenticator is forgotten
 *   npm run partners -- user deactivate <email>
 *   npm run partners -- assign <partner-slug|direct> <workspace-slug…> --reason "…" [--no-commission]
 *   npm run partners -- two-factor [required|optional] show or pin the portal's two-factor policy
 *   npm run partners -- accrue                          work out commission now, as the tick does
 *   npm run partners -- statements                      draft last IST month's statements now
 *
 * No password is ever given here: `user create` and `user link` print a link to choose one (it is
 * emailed too), and nothing else is printed that should stay secret. A partner's first user must be an
 * ADMIN; after that --role is needed. `assign` is effective from now (never backdated), needs a reason
 * of 10 to 500 characters and prints one line per workspace; --no-commission attributes without
 * commission (a partner's own workspace, spec §4.5).
 *
 * Everything is in the partner's own activity log as "script", and in the platform's audit log as a
 * SCRIPT entry, "partners:<command>". The portal's address is partners.<PLATFORM_DOMAIN> (docs/runbook.md).
 */
import "dotenv/config";
import type { PartnerRole, Prisma } from "@deskzo/control-client";
import { setAttribution } from "../src/lib/partners/attribution";
import { accrueCommissions } from "../src/lib/partners/commission";
import { partnerIdBySlug } from "../src/lib/partners/registry";
import { partnerTwoFactorPolicy } from "../src/lib/partners/settings";
import { generateStatements } from "../src/lib/partners/statements";
import { PARTNER_ROLES } from "../src/lib/partners/types";
import { createPartnerUser, deactivatePartnerUser, listPartnerUsers, newPartnerSetupLink, partnerAdminCount, partnerOfUser, resetPartnerUserTwoFactor } from "../src/lib/partners/users";
import { redactSecrets } from "../src/lib/console-shared/redact";
import { closeControlDb, controlDb } from "../src/lib/platform/control-db";
import { setSetting } from "../src/lib/platform/settings";

const args = process.argv.slice(2);
/** Flags that take a value — whatever follows them is not a positional argument. */
const VALUED = new Set(["email", "name", "role", "reason"]);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && VALUED.has(args[i - 1]!.slice(2))));
const SCRIPT = { kind: "script" } as const;

/** What the operator typed does not work: said plainly, like a library's refusal. */
class Usage extends Error {}

/** A refusal the operator can act on (the libraries' PartnerRefused, or a Usage), as opposed to a bug. */
const isRefusal = (err: unknown): boolean => err instanceof Usage || (err instanceof Error && err.name === "PartnerRefused");

/** The platform audit entry every change writes: a SCRIPT, "partners:<command>". */
async function audit(command: string, action: string, detail: Record<string, unknown>, tenantId: string | null = null): Promise<void> {
  await controlDb().platformAuditLog.create({ data: { actorKind: "SCRIPT", actor: `partners:${command}`, action, tenantId, detail: detail as Prisma.InputJsonValue }, select: { id: true } });
}

function roleFrom(value: string | undefined): PartnerRole {
  const role = (value ?? "").toUpperCase() as PartnerRole;
  if (!(PARTNER_ROLES as readonly string[]).includes(role)) throw new Usage(`A role is one of ${PARTNER_ROLES.join(", ")}.`);
  return role;
}

async function partnerBySlug(slug: string | undefined): Promise<{ id: string; slug: string }> {
  if (!slug) throw new Usage("Which partner? Give its slug (npm run partners -- list).");
  const id = await partnerIdBySlug(slug);
  if (!id) throw new Usage(`There is no partner "${slug}".`);
  return { id, slug: slug.trim().toLowerCase() };
}

async function userByEmail(email: string | undefined): Promise<{ userId: string; partnerId: string; partnerSlug: string; email: string }> {
  if (!email || !email.includes("@")) throw new Usage("Whose? Give their email address.");
  const owner = await partnerOfUser(email);
  if (!owner) throw new Usage(`There is no partner portal account ${email}.`);
  return { ...owner, email: email.trim().toLowerCase() };
}

async function userCommand(sub: string | undefined, target: string | undefined): Promise<void> {
  switch (sub) {
    case "list": {
      const partner = await partnerBySlug(target);
      const rows = await listPartnerUsers(partner.id);
      if (!rows.length) console.log(`${partner.slug} has no portal users yet. Make its first admin: npm run partners -- user create ${partner.slug} --email … --name …`);
      for (const r of rows) {
        const password = r.hasPassword ? "password set " : "link pending ";
        const twoFactor = r.twoFactor ? "2fa on " : "2fa off";
        console.log(`${r.email.padEnd(36)} ${r.role.padEnd(7)} ${twoFactor} ${password}${r.active ? "active  " : "off     "}${r.name}`);
      }
      return;
    }
    case "create": {
      const partner = await partnerBySlug(target);
      const admins = await partnerAdminCount(partner.id);
      // Its first user has to be an admin, or nobody could ever add anybody from inside the portal.
      if (!admins && flag("role") && roleFrom(flag("role")) !== "ADMIN") throw new Usage(`${partner.slug} has no active admin yet, so its first user must be one: --role ADMIN.`);
      if (admins && !flag("role")) throw new Usage(`Which role? --role ${PARTNER_ROLES.join("|")}`);
      const role = flag("role") ? roleFrom(flag("role")) : "ADMIN";
      const made = await createPartnerUser(partner.id, { email: flag("email") ?? "", name: flag("name") ?? "", role }, SCRIPT);
      const email = (flag("email") ?? "").trim().toLowerCase();
      await audit("user-create", "partner.user.invite", { partner: partner.slug, email, role, partnerUserId: made.id, emailed: made.emailed });
      console.log(`Added ${email} to ${partner.slug} as ${role}${made.emailed ? "" : " (the email could not be sent)"}. Their link to choose a password (works once, for 3 days):\n${made.setupUrl}`);
      return;
    }
    case "link": {
      const user = await userByEmail(target);
      const sent = await newPartnerSetupLink(user.partnerId, user.userId, SCRIPT, true);
      await audit("user-link", "partner.user.setup-link", { partner: user.partnerSlug, email: user.email, partnerUserId: user.userId, emailed: sent.emailed });
      console.log(`A new link for ${user.email} (the previous one no longer works)${sent.emailed ? "" : " — the email could not be sent"}:\n${sent.setupUrl}`);
      return;
    }
    case "reset-2fa": {
      const user = await userByEmail(target);
      await resetPartnerUserTwoFactor(user.partnerId, user.userId, SCRIPT);
      await audit("user-reset-2fa", "partner.user.two-factor.reset", { partner: user.partnerSlug, email: user.email, partnerUserId: user.userId });
      console.log(`${user.email}'s authenticator is removed and they are signed out.`);
      return;
    }
    case "deactivate": {
      const user = await userByEmail(target);
      await deactivatePartnerUser(user.partnerId, user.userId, SCRIPT);
      await audit("user-deactivate", "partner.user.deactivate", { partner: user.partnerSlug, email: user.email, partnerUserId: user.userId });
      console.log(`${user.email} is switched off and signed out.`);
      return;
    }
    default:
      console.log("User commands: user list <partner-slug>, user create <partner-slug> --email … --name … [--role …], user link <email>, user reset-2fa <email>, user deactivate <email>.");
      process.exitCode = 1;
  }
}

async function assign(target: string | undefined, slugs: string[]): Promise<void> {
  if (!target) throw new Usage("To whom? Give a partner's slug, or direct.");
  const reason = (flag("reason") ?? "").trim();
  if (reason.length < 10 || reason.length > 500) throw new Usage('Give a reason of 10 to 500 characters: --reason "…"');
  if (!slugs.length) throw new Usage("Which workspaces? Give their slugs after the partner.");
  const partner = target.trim().toLowerCase() === "direct" ? null : await partnerBySlug(target);
  const commissionable = !args.includes("--no-commission");
  let refused = 0;
  for (const slug of [...new Set(slugs.map((s) => s.trim().toLowerCase()))]) {
    const tenant = await controlDb().tenant.findUnique({ where: { slug }, select: { id: true, slug: true } });
    if (!tenant) {
      refused += 1;
      console.log(`${slug}: there is no such workspace.`);
      continue;
    }
    try {
      const done = await setAttribution(tenant.id, { partnerId: partner?.id ?? null, reason, commissionable }, SCRIPT);
      await audit(
        "assign",
        "partner.attribution",
        { partner: done.to ?? done.from, from: done.from, to: done.to, commissionable: done.commissionable, reason, workspace: done.tenantSlug, ...(done.outsideTerritory ? { outsideTerritory: true } : {}) },
        tenant.id,
      );
      const outside = done.outsideTerritory ? " — outside the partner's territories" : "";
      console.log(`${tenant.slug}: ${done.from ?? "direct"} → ${done.to ?? "direct"}${done.to && !done.commissionable ? " (no commission)" : ""}${outside}`);
    } catch (err) {
      if (!isRefusal(err)) throw err;
      const why = (err as Error).message;
      if (why === "Nothing to change.") {
        console.log(`${tenant.slug}: already so — nothing changed.`);
        continue;
      }
      refused += 1;
      console.log(`${tenant.slug}: not changed — ${why}`);
    }
  }
  if (refused) process.exitCode = 1;
}

async function twoFactor(mode: string | undefined): Promise<void> {
  const now = await partnerTwoFactorPolicy();
  if (mode !== "required" && mode !== "optional") {
    console.log(`Partner portal two-factor is ${now.mode}${now.chosen ? "" : " (this environment's default — nobody has chosen)"}. Set it with: two-factor required | optional`);
    return;
  }
  if (now.chosen && now.mode === mode) {
    console.log(`Partner portal two-factor is ${mode} already.`);
    return;
  }
  // Written directly, not through setPartnerSettings: that writes nothing when the value equals the
  // environment's default, and pinning it is the point here.
  await setSetting("partners.twoFactor", mode, "script");
  await audit("two-factor", "partner.settings", { changed: ["partners.twoFactor"], to: { "partners.twoFactor": mode } });
  console.log(`Partner portal two-factor is now ${mode}.`);
}

async function main() {
  const [command, first, second, ...rest] = positional;
  switch (command) {
    case "list": {
      const rows = await controlDb().partner.findMany({
        orderBy: [{ displayName: "asc" }, { slug: "asc" }],
        select: {
          slug: true,
          kind: true,
          status: true,
          displayName: true,
          _count: { select: { users: { where: { active: true } }, tenants: { where: { status: { not: "DEPROVISIONED" } } } } },
        },
      });
      if (!rows.length) console.log("No partners yet. They are created in the console (/partners).");
      for (const r of rows) {
        console.log(`${r.slug.padEnd(28)} ${r.kind.padEnd(11)} ${r.status.padEnd(11)} ${String(r._count.users).padStart(3)} users ${String(r._count.tenants).padStart(5)} customers  ${r.displayName}`);
      }
      return;
    }
    case "user":
      return userCommand(first, second);
    case "assign":
      return assign(first, [second, ...rest].filter((s): s is string => !!s));
    case "two-factor":
      return twoFactor(first);
    case "accrue": {
      const run = await accrueCommissions(new Date());
      await audit("accrue", "partner.commissions.run", { invoices: run.invoices, accrued: run.accrued, reversed: run.reversed, failed: run.failed, outcomes: run.outcomes });
      const outcomes = Object.entries(run.outcomes).map(([k, n]) => `${k} ${n}`).join(", ");
      console.log(`${run.invoices} invoice(s) looked at: ${run.accrued} commission entr${run.accrued === 1 ? "y" : "ies"} and ${run.reversed} reversal(s) written, ${run.failed} failed.${outcomes ? ` (${outcomes})` : ""}`);
      if (run.failed) process.exitCode = 1;
      return;
    }
    case "statements": {
      const run = await generateStatements(new Date(), { by: "script" });
      await audit("statements", "partner.statements.generate", { period: run.period, made: run.made, partners: run.partners, ...(run.failed ? { failed: run.failed } : {}) });
      console.log(`${run.period}: ${run.made} statement(s) drafted for ${run.partners} partner(s)${run.failed ? `, ${run.failed} failed` : ""}.${run.numbers.length ? `\n${run.numbers.join("\n")}` : ""}`);
      if (run.failed) process.exitCode = 1;
      return;
    }
    default:
      console.log("Commands: list, user, assign, two-factor, accrue, statements — see the top of scripts/partners.ts.");
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    // A refusal is the operator's to read; anything else is cut to its first line, secrets masked.
    const message = err instanceof Error ? (isRefusal(err) ? err.message : `${err.name}: ${err.message.split("\n")[0]!.slice(0, 300)}`) : String(err);
    console.error(redactSecrets(message) ?? "error");
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
