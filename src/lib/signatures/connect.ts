import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { can } from "@/lib/authz/resolve";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { zohoApp } from "@/lib/workplace/settings";
import { fetchZohoMe, regionOfAccountsServer, zohoAuthorizeUrl, zohoExchangeCode } from "@/lib/mail/zoho";
import { ZOHO_SIGNATURE_SCOPES, zohoOrgId } from "@/lib/signatures/zoho";

/**
 * Connecting Zoho Mail for signatures: a Zoho Mail administrator approves ZohoMail.organization.accounts
 * once, through the same callback address the company already registered for mailboxes
 * (/api/mail/zoho/callback) — the signed connect state says which of the two it was started for.
 */

/** Whether this person may connect the company's mail suite for signatures. */
export async function mayConnectSignatures(userId: string): Promise<boolean> {
  return (await moduleAvailableForTenant("signatures")) && (await can(userId, "signatures.manage"));
}

export async function startZohoSignatureConnect(p: { redirectUri: string; state: string }): Promise<{ ok: true; url: string } | { ok: false; outcome: string }> {
  const app = await zohoApp();
  if (!app) return { ok: false, outcome: "not-configured" };
  return { ok: true, url: zohoAuthorizeUrl(app, { redirectUri: p.redirectUri, state: p.state, scope: ZOHO_SIGNATURE_SCOPES }) };
}

/** The code exchanged and kept: the grant (encrypted), who gave it, and the organisation when Zoho says. */
export async function finishZohoSignatureConnect(p: { userId: string; code: string; redirectUri: string; accountsServer: string | null }): Promise<string> {
  const app = await zohoApp();
  if (!app) return "not-configured";
  const region = regionOfAccountsServer(p.accountsServer) ?? app.region;
  if (region !== app.region) return "wrong-region";
  const exchanged = await zohoExchangeCode(app, region, { code: p.code, redirectUri: p.redirectUri });
  if (!exchanged.ok) return "failed";
  if (!exchanged.tokens.refreshToken) return "no-refresh";
  const [me, zoid] = await Promise.all([fetchZohoMe(region, exchanged.tokens.accessToken), zohoOrgId(region, exchanged.tokens.accessToken)]);
  const data = {
    provider: "ZOHO",
    zohoRefreshCipher: await encryptSecret(exchanged.tokens.refreshToken),
    zohoOrgId: zoid,
    zohoAdminEmail: me?.email ?? null,
    googleServiceEmail: null,
    googleKeyCipher: null,
    connectedById: p.userId,
    connectedAt: new Date(),
    lastError: null,
  };
  await db.signatureSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  // Everybody's signature goes to the newly connected suite on the next run.
  await db.signatureSync.updateMany({ where: { provider: { not: "ZOHO" } }, data: { status: "PENDING" } });
  return "connected";
}
