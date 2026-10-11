import type { SignatureSettings, SignatureSyncStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { zohoApp } from "@/lib/workplace/settings";
import { zohoRefresh } from "@/lib/mail/zoho";
import type { ZohoRegion } from "@/lib/workplace/providers";
import { readServiceAccount, setGmailSignature, type ServiceAccount } from "@/lib/signatures/google";
import { putZohoSignature, zohoOrgAccounts, zohoOrgId } from "@/lib/signatures/zoho";
import { PERSON_SELECT, personSignature, signatureContext, type Person } from "@/lib/signatures/person";

/**
 * Putting the company's signatures into everybody's mailbox — Gmail or Zoho Mail, whichever suite the
 * workspace connected — and keeping them in step.
 *
 * Every run draws each person's signature afresh and compares it with what was last put there: the
 * same signature is never sent twice, so a changed title or phone goes out on the next beat and nothing
 * else does. A person who fails is tried again later, waiting longer each time; a fault in the
 * connection itself — a missing delegation, a revoked grant — stops the run and is said once, on the
 * settings, not once per person.
 */

export type SignatureProvider = "GOOGLE" | "ZOHO";

export async function readSignatureSettings(): Promise<SignatureSettings | null> {
  try {
    return await db.signatureSettings.findUnique({ where: { id: "global" } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

type Connection =
  | { provider: "GOOGLE"; sa: ServiceAccount }
  | { provider: "ZOHO"; region: ZohoRegion; token: string; zoid: string; accounts: Map<string, string> };

/** The connected suite, opened: a key to sign with, or a fresh Zoho token and the organisation's accounts. */
export async function openConnection(settings: SignatureSettings | null): Promise<{ ok: true; conn: Connection } | { ok: false; error: string }> {
  if (!settings?.provider) return { ok: false, error: "No mail suite is connected yet." };
  if (settings.provider === "GOOGLE") {
    if (!settings.googleKeyCipher) return { ok: false, error: "The Google service account's key is missing. Connect Google Workspace again." };
    let raw: string;
    try {
      raw = await decryptSecret(settings.googleKeyCipher);
    } catch {
      return { ok: false, error: "The Google key couldn't be opened. Connect Google Workspace again." };
    }
    const sa = readServiceAccount(raw);
    return "error" in sa ? { ok: false, error: sa.error } : { ok: true, conn: { provider: "GOOGLE", sa } };
  }
  if (settings.provider === "ZOHO") {
    const app = await zohoApp();
    if (!app) return { ok: false, error: "The Zoho app in Settings → Security isn't set up." };
    if (!settings.zohoRefreshCipher) return { ok: false, error: "Zoho Mail isn't connected. Connect it again." };
    let refresh: string;
    try {
      refresh = await decryptSecret(settings.zohoRefreshCipher);
    } catch {
      return { ok: false, error: "The Zoho grant couldn't be opened. Connect Zoho Mail again." };
    }
    const token = await zohoRefresh(app, app.region, refresh);
    if (!token.ok) return { ok: false, error: token.revoked ? "Zoho Mail's grant was withdrawn. Connect Zoho Mail again." : token.error };
    const zoid = settings.zohoOrgId ?? (await zohoOrgId(app.region, token.tokens.accessToken));
    if (!zoid) return { ok: false, error: "Zoho Mail didn't say which organisation this is. Enter its Organisation ID (Zoho Mail Admin Console → Organization)." };
    if (!settings.zohoOrgId) await db.signatureSettings.update({ where: { id: "global" }, data: { zohoOrgId: zoid } });
    const accounts = await zohoOrgAccounts(app.region, token.tokens.accessToken, zoid);
    if (!accounts.ok) return { ok: false, error: accounts.error };
    return { ok: true, conn: { provider: "ZOHO", region: app.region, token: token.tokens.accessToken, zoid, accounts: new Map(accounts.data.map((a) => [a.email, a.zuid])) } };
  }
  return { ok: false, error: "No mail suite is connected yet." };
}

export type SyncReport = { synced: number; unchanged: number; failed: number; skipped: number; waiting: number; stopped: string | null };

/** How long a person who failed waits before the next try: 10 minutes, doubling, at most a day. */
function retryAfter(attempts: number): number {
  return Math.min(24 * 60, 10 * 2 ** Math.max(0, attempts - 1)) * 60_000;
}

export async function syncSignatures(opts: { budgetMs: number; userIds?: string[]; force?: boolean }, now = new Date()): Promise<SyncReport> {
  const report: SyncReport = { synced: 0, unchanged: 0, failed: 0, skipped: 0, waiting: 0, stopped: null };
  const settings = await readSignatureSettings();
  const opened = await openConnection(settings);
  if (!opened.ok) return { ...report, stopped: opened.error };
  const { conn } = opened;
  const started = Date.now();

  const people = (await db.user.findMany({
    where: { active: true, kind: "MEMBER", ...(opts.userIds ? { id: { in: opts.userIds } } : {}) },
    orderBy: { name: "asc" },
    select: PERSON_SELECT,
  })) as Person[];
  const rows = new Map((await db.signatureSync.findMany({ where: { userId: { in: people.map((p) => p.id) } } })).map((r) => [r.userId, r]));
  const ctx = await signatureContext();

  for (const person of people) {
    if (Date.now() - started > opts.budgetMs) {
      report.waiting++;
      continue;
    }
    const row = rows.get(person.id);
    const sig = await personSignature(person, ctx);
    if (!opts.force && row && row.provider === conn.provider && row.syncedHash === sig.hash && row.status === "SYNCED") {
      report.unchanged++;
      continue;
    }
    // Somebody who failed waits their turn — "Sync now" (force) doesn't.
    if (!opts.force && row?.status === "FAILED" && row.updatedAt.getTime() + retryAfter(row.attempts) > now.getTime()) {
      report.waiting++;
      continue;
    }

    let status: SignatureSyncStatus;
    let error: string | null = null;
    let zohoSignatureId = row?.zohoSignatureId ?? null;
    let zohoAccountId = row?.zohoAccountId ?? null;
    if (conn.provider === "GOOGLE") {
      const out = await setGmailSignature(conn.sa, person.email, sig.html);
      if (!out.ok && out.setup) return { ...report, stopped: out.error };
      status = out.ok ? "SYNCED" : "FAILED";
      error = out.ok ? null : out.error;
    } else {
      const zuid = conn.accounts.get(person.email.toLowerCase());
      if (!zuid) {
        status = "SKIPPED";
        error = "No Zoho Mail account at this address.";
      } else {
        const out = await putZohoSignature(conn.region, conn.token, { zoid: conn.zoid, zuid, signatureId: row?.zohoAccountId === zuid ? zohoSignatureId : null }, sig.html);
        if (!out.ok && out.status === 401) return { ...report, stopped: out.error };
        status = out.ok ? "SYNCED" : "FAILED";
        error = out.ok ? null : out.error;
        if (out.ok) {
          zohoSignatureId = out.data.signatureId;
          zohoAccountId = zuid;
        }
      }
    }

    const data = {
      provider: conn.provider,
      status,
      lastError: error,
      zohoSignatureId,
      zohoAccountId,
      ...(status === "SYNCED" ? { syncedHash: sig.hash, syncedAt: now, attempts: 0 } : status === "FAILED" ? { attempts: (row?.attempts ?? 0) + 1 } : {}),
    };
    await db.signatureSync.upsert({ where: { userId: person.id }, create: { userId: person.id, ...data }, update: data });
    if (status === "SYNCED") report.synced++;
    else if (status === "FAILED") report.failed++;
    else report.skipped++;
  }
  return report;
}

/**
 * The five-minute beat's step: only where Signatures is in the plan, a suite is connected, and the
 * company keeps them in step on its own. A minute at most; the rest go on the next beat.
 */
export async function signatureChores(opts: { budgetMs: number }): Promise<SyncReport | null> {
  if (!(await moduleAvailableForTenant("signatures"))) return null;
  const settings = await readSignatureSettings();
  if (!settings?.provider || !settings.autoSync) return null;
  return recordRun(await syncSignatures({ budgetMs: opts.budgetMs }));
}

/** A run's outcome on the settings: when, and — when it stopped on the connection — why. */
export async function recordRun(report: SyncReport): Promise<SyncReport> {
  await db.signatureSettings.update({ where: { id: "global" }, data: { lastRunAt: new Date(), lastError: report.stopped } }).catch(() => undefined);
  return report;
}
