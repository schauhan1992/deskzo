import { randomUUID } from "node:crypto";
import { directClient } from "@/lib/tenancy/direct-client";
import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";
import { defaultZoneFor } from "@/lib/time/zones";
import { bootstrapOwner } from "@/lib/platform/bootstrap-owner";
import { controlDb } from "@/lib/platform/control-db";
import { openForPlatform, openForTenant, sealForPlatform, sealForTenant } from "@/lib/platform/kek";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { latestMigrationName, migrateDeploy } from "@/lib/platform/migrate";
import { createWorkspaceDatabase } from "@/lib/platform/provisioner";
import { newKeyBundle, sealKeyBundle } from "@/lib/tenancy/keys";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";
import { forgetRegistry, subdomainHost } from "@/lib/tenancy/registry";
import { PlanRefused, planForNewWorkspace, startOnPlan } from "@/lib/platform/plans";
import { refreshEntitlements } from "@/lib/platform/entitlements";
import { trialDays } from "@/lib/platform/settings";
import { workspaceNameVerdict, type InviteHold } from "@/lib/platform/name-rules";
import { NAME_TAKEN } from "@/lib/workspace-names";
import { mailNewCustomer, recordSignupAttribution, type AttributionDecision } from "@/lib/partners/attribution";
import { templateOf } from "@/lib/industry-templates/catalogue";
import { applyTemplate } from "@/lib/industry-templates/apply";
import { moduleEntitled, parseEntitlements } from "@/lib/entitlements";

/**
 * Setting a workspace up, from a name to a working address.
 *
 *   1. `startProvisioning` reserves the name: a Tenant row, PROVISIONING, with its keys already made,
 *      and a job. Instant — this is what the signup form waits for.
 *   2. The platform worker (scripts/platform-worker.ts) takes the job (`runNextJob`) and:
 *        · takes a warm database — made and migrated ahead of time — or makes one and migrates it;
 *        · seals its address for the workspace;
 *        · creates the owner, the super admin, with the password they chose (already hashed);
 *        · fills in the organisation and its branding from the signup;
 *        · marks the workspace ACTIVE and emails the owner its address.
 *      Each step says where it is (`step`), which the progress page shows. A failure is retried a
 *      few times, a minute apart, then left FAILED for staff; every step is safe to run again.
 *   3. `fillWarmPool` keeps a couple of migrated databases waiting, so step 2 takes seconds.
 */

export const WARM_POOL_SIZE = Math.max(0, Number(process.env.PLATFORM_WARM_POOL ?? 2));
const MAX_ATTEMPTS = 3;
/** A job RUNNING this long belonged to a worker that died; it is taken again. */
const STALE_MS = 30 * 60_000;

export class ProvisioningRefused extends Error {}

export type ProvisioningInput = {
  slug: string;
  companyName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPasswordHash: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** The plan it starts on — an invitation's; the default plan when absent. */
  planKey?: string | null;
  /** The partner signup credited it to (src/lib/partners/attribution.ts); none: a direct customer. */
  attribution?: AttributionDecision | null;
  /** The address its invitation holds for it, when the invitation holds one — checked again here, never skipped. */
  hold?: InviteHold | null;
  /** The industry template chosen at signup (src/lib/industry-templates), applied as the workspace is set up. */
  industryTemplate?: string | null;
};

/** What `slugProblem` says of a name that is fine but belongs to a workspace already (or is held for another customer). */
export const SLUG_TAKEN = NAME_TAKEN;

/**
 * Why a workspace name cannot be had, or null when it can — every new workspace, whoever makes it:
 * the pattern, never a platform address, staff's blocks, the built-in reserved words, our name and
 * competitors' (unless staff released the word), never a name an open invitation holds for somebody
 * else, never one taken (src/lib/workspace-names.ts, with src/lib/platform/name-rules.ts). `hold`: the
 * invitation this workspace comes with, whose address it may have — and, when the invitation says
 * so, even a reserved word or a blocked name.
 */
export async function slugProblem(slug: string, opts: { hold?: InviteHold | null } = {}): Promise<string | null> {
  const verdict = await workspaceNameVerdict(slug, opts.hold ?? null);
  return verdict.ok ? null : verdict.message;
}

export async function startProvisioning(input: ProvisioningInput): Promise<{ tenantId: string; jobId: string }> {
  const slug = input.slug.trim().toLowerCase();
  const problem = await slugProblem(slug, { hold: input.hold ?? null });
  if (problem) throw new ProvisioningRefused(problem);
  const country = WORLD_COUNTRIES.find((c) => c.code === input.country.toUpperCase());
  if (!country) throw new ProvisioningRefused("Choose a country from the list.");
  const trialEnds = new Date(Date.now() + (await trialDays()) * 86_400_000);
  let plan: Awaited<ReturnType<typeof planForNewWorkspace>>;
  try {
    plan = await planForNewWorkspace(input.planKey, country.code);
  } catch (err) {
    if (err instanceof PlanRefused) throw new ProvisioningRefused(err.message);
    throw err;
  }

  const tenantId = randomUUID();
  const control = controlDb();
  const job = await control.$transaction(async (tx) => {
    await tx.tenant.create({
      data: {
        id: tenantId,
        slug,
        name: input.companyName.trim(),
        status: "PROVISIONING",
        keyBundleCipher: sealKeyBundle(tenantId, newKeyBundle()),
        country: country.code,
        currency: country.currency ?? "USD",
        // Its country's zone to start with (src/lib/time/zones.ts); the owner changes it under Settings → Profile.
        timezone: defaultZoneFor(country.code),
        ownerEmail: input.ownerEmail.trim().toLowerCase(),
      },
    });
    const created = await tx.provisioningJob.create({
      data: {
        tenantId,
        ownerName: input.ownerName.trim(),
        ownerEmail: input.ownerEmail.trim().toLowerCase(),
        ownerPasswordHash: input.ownerPasswordHash,
        companyName: input.companyName.trim(),
        country: country.code,
        planKey: plan?.key ?? null,
        industryTemplate: templateOf(input.industryTemplate)?.key ?? null,
      },
      select: { id: true },
    });
    // Without a plan offered it has the core alone, until staff give it one from the console.
    // On a free trial of it; an internal plan is never a trial.
    if (plan) await startOnPlan(tx, tenantId, plan.id, plan.kind === "INTERNAL" ? null : trialEnds);
    await tx.platformAuditLog.create({ data: { actorKind: "SYSTEM", actor: "signup", action: "tenant.provision.requested", tenantId, detail: { slug } } });
    // Its partner, with the workspace: both are made, or neither.
    if (input.attribution) await recordSignupAttribution(tx, tenantId, input.attribution, new Date());
    return created;
  });
  await refreshEntitlements(tenantId);
  // Its partner hears of it once it exists; mailNewCustomer logs a failure and never throws.
  if (input.attribution) await mailNewCustomer(input.attribution, input.companyName.trim());
  return { tenantId, jobId: job.id };
}

// ─── The warm pool ──────────────────────────────────────────────────────────────────────────────

async function makeWarmDatabase(version: string | null): Promise<void> {
  const made = await createWorkspaceDatabase();
  await migrateDeploy(made.url);
  await controlDb().warmDatabase.create({
    data: { dbName: made.dbName, dbRole: made.dbRole, dbUrlCipher: sealForPlatform("warm-db-url", made.url), schemaVersion: version },
  });
}

/** Tops the pool up to `size`, and brings a waiting database that is behind up to date. */
export async function fillWarmPool(size = WARM_POOL_SIZE): Promise<{ made: number; migrated: number }> {
  const control = controlDb();
  const version = latestMigrationName();
  let migrated = 0;
  for (const stale of await control.warmDatabase.findMany({ where: { claimedAt: null, NOT: { schemaVersion: version } } })) {
    await migrateDeploy(openForPlatform("warm-db-url", stale.dbUrlCipher));
    await control.warmDatabase.update({ where: { id: stale.id }, data: { schemaVersion: version } });
    migrated += 1;
  }
  const waiting = await control.warmDatabase.count({ where: { claimedAt: null } });
  let made = 0;
  for (let i = waiting; i < size; i++) {
    await makeWarmDatabase(version);
    made += 1;
  }
  return { made, migrated };
}

/** Takes one waiting database that is current, or null. SKIP LOCKED: two workers never take the same. */
async function claimWarmDatabase(tenantId: string): Promise<{ dbName: string; dbRole: string; url: string } | null> {
  const version = latestMigrationName();
  const rows = await controlDb().$queryRaw<{ dbName: string; dbRole: string; dbUrlCipher: string }[]>`
    UPDATE "warm_databases" SET "claimedAt" = now(), "claimedByTenantId" = ${tenantId}
    WHERE id = (
      SELECT id FROM "warm_databases" WHERE "claimedAt" IS NULL AND "schemaVersion" = ${version}
      ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING "dbName", "dbRole", "dbUrlCipher"`;
  const row = rows[0];
  return row ? { dbName: row.dbName, dbRole: row.dbRole, url: openForPlatform("warm-db-url", row.dbUrlCipher) } : null;
}

// ─── Jobs ───────────────────────────────────────────────────────────────────────────────────────

type ClaimedJob = { id: string; tenantId: string; attempts: number };

async function claimNextJob(): Promise<ClaimedJob | null> {
  const rows = await controlDb().$queryRaw<ClaimedJob[]>`
    UPDATE "provisioning_jobs" SET "status" = 'RUNNING', "startedAt" = now(), "attempts" = "attempts" + 1, "error" = NULL
    WHERE id = (
      SELECT id FROM "provisioning_jobs"
      WHERE ("status" = 'PENDING' AND "runAfter" <= now())
         OR ("status" = 'RUNNING' AND "startedAt" < ${new Date(Date.now() - STALE_MS)})
      ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, "tenantId", attempts`;
  return rows[0] ?? null;
}

const step = (id: string, text: string) => controlDb().provisioningJob.update({ where: { id }, data: { step: text } });

async function runJob(claimed: ClaimedJob): Promise<void> {
  const control = controlDb();
  const job = await control.provisioningJob.findUniqueOrThrow({ where: { id: claimed.id } });
  const tenant = await control.tenant.findUniqueOrThrow({ where: { id: job.tenantId } });

  // 1. A database — the one a previous attempt already took, a warm one, or a new one.
  let url: string;
  if (tenant.dbUrlCipher) {
    url = openForTenant(tenant.id, "db-url", tenant.dbUrlCipher);
    await step(job.id, "Checking your database");
    await migrateDeploy(url);
  } else {
    await step(job.id, "Preparing your database");
    let db = await claimWarmDatabase(tenant.id);
    if (!db) {
      await step(job.id, "Preparing your database — this one takes about a minute");
      const made = await createWorkspaceDatabase();
      await migrateDeploy(made.url);
      db = made;
    }
    url = db.url;
    await control.tenant.update({
      where: { id: tenant.id },
      data: { dbName: db.dbName, dbRole: db.dbRole, dbUrlCipher: sealForTenant(tenant.id, "db-url", db.url), schemaVersion: latestMigrationName() },
    });
  }

  // 2. The owner, and the organisation they signed up for.
  const workspace = directClient(url);
  try {
    await step(job.id, "Creating your account");
    let owner = await workspace.user.findUnique({ where: { email: job.ownerEmail }, select: { id: true } });
    if (!owner) {
      if (!job.ownerPasswordHash) throw new Error("The owner's password is no longer on the job; the signup has to be started again.");
      owner = await bootstrapOwner(workspace, { name: job.ownerName, email: job.ownerEmail, passwordHash: job.ownerPasswordHash });
    }
    await step(job.id, "Setting up your organisation");
    const countryName = WORLD_COUNTRIES.find((c) => c.code === job.country)?.name ?? null;
    await workspace.organisationSettings.upsert({
      where: { id: "global" },
      create: { id: "global", legalName: job.companyName, country: countryName },
      update: {},
    });
    // Their name on their sign-in page and in the sidebar, not the platform's.
    await workspace.brandingSettings.upsert({ where: { id: "global" }, create: { id: "global", appName: job.companyName }, update: {} });
    // The industry they chose: its pipeline, steps, words and fields. Safe to run again — a second time
    // finds it all there — so a retried job applies it once.
    const template = templateOf(job.industryTemplate);
    if (template) {
      await step(job.id, `Setting up for ${template.name.toLowerCase()}`);
      const entitlements = parseEntitlements(tenant.entitlements);
      const done = await applyTemplate(workspace, template, (key) => moduleEntitled(entitlements, tenant.country, key), owner.id);
      if (done.changes.length) {
        await workspace.auditLog.create({
          data: { userId: owner.id, action: "UPDATE", entityType: "IndustryTemplate", entityId: template.key, entityLabel: `Industry template: ${template.name} — ${done.changes.join("; ")}` },
        });
      }
    }
  } finally {
    await workspace.$disconnect();
  }

  // 3. Open.
  await control.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: tenant.id }, data: { status: "ACTIVE" } });
    await tx.provisioningJob.update({
      where: { id: job.id },
      data: { status: "SUCCEEDED", step: "Ready", finishedAt: new Date(), ownerPasswordHash: null },
    });
    await tx.platformAuditLog.create({ data: { actorKind: "SYSTEM", actor: "platform-worker", action: "tenant.provision.done", tenantId: tenant.id } });
  });
  forgetRegistry();

  const host = subdomainHost(tenant.slug);
  await sendPlatformMail({
    type: "ACCOUNT",
    to: job.ownerEmail,
    subject: `${tenant.name} is ready`,
    text: [
      `Hello ${job.ownerName},`,
      "",
      `Your workspace is ready at ${protocolFor(host)}://${host} — sign in there with ${job.ownerEmail} and the password you chose.`,
      "",
      `Every workspace on ${PLATFORM_DOMAIN} has its own address; keep this one.`,
    ].join("\n"),
  }).catch((err) => console.error("[provisioning] the ready email could not be sent", err));
}

/**
 * Takes the next job that is due and runs it. Returns what happened, or null when there was nothing
 * to do. A failure is recorded and retried later; it never throws out of here.
 */
export async function runNextJob(): Promise<{ jobId: string; ok: boolean; error?: string } | null> {
  const claimed = await claimNextJob();
  if (!claimed) return null;
  try {
    await runJob(claimed);
    return { jobId: claimed.id, ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[provisioning] job ${claimed.id} failed (attempt ${claimed.attempts})`, err);
    const last = claimed.attempts >= MAX_ATTEMPTS;
    await controlDb().provisioningJob.update({
      where: { id: claimed.id },
      data: {
        status: last ? "FAILED" : "PENDING",
        error: error.slice(0, 1000),
        runAfter: new Date(Date.now() + 60_000 * claimed.attempts),
        step: last ? "Something went wrong — we have been told and will be in touch" : "Retrying shortly",
      },
    });
    return { jobId: claimed.id, ok: false, error };
  }
}
