import type { ZohoRegion } from "@/lib/workplace/providers";
import { zohoMailBase } from "@/lib/mail/zoho";

/**
 * Zoho Mail signatures through its administrator API: a Zoho Mail administrator grants
 * ZohoMail.organization.accounts once, and Deskzo adds — then updates in place — an admin-added
 * signature on each person's account (/api/organization/{zoid}/accounts/{zuid}/signature).
 *
 * The organisation's id comes from the administrator's own account (GET /api/accounts → policyId.zoid),
 * which is why the grant also asks for ZohoMail.accounts.READ. Plain fetch; the data centre's hosts can
 * be swapped for stand-ins (setTestZohoRegions in src/lib/mail/zoho.ts).
 */

export const ZOHO_SIGNATURE_SCOPES = "ZohoMail.organization.accounts.ALL,ZohoMail.accounts.READ,AaaServer.profile.Read";

/** The signature's name in Zoho — one per person, made by Deskzo. */
export const ZOHO_SIGNATURE_NAME = "Company signature (Deskzo)";

export type ZohoOutcome<T = null> = { ok: true; data: T } | { ok: false; error: string; status: number };

const auth = (token: string) => ({ authorization: `Zoho-oauthtoken ${token}`, accept: "application/json" });

async function call<T>(region: ZohoRegion, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<ZohoOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(`${zohoMailBase(region)}${path}`, {
      method: init.method ?? "GET",
      headers: { ...auth(token), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Zoho Mail didn't answer. It is tried again on its own.", status: 0 };
  }
  const body = (await res.json().catch(() => ({}))) as { status?: { code?: number; description?: string }; data?: unknown };
  const code = body.status?.code ?? res.status;
  if (res.ok && code >= 200 && code < 300) return { ok: true, data: body.data as T };
  const more = (body.data as { moreInfo?: unknown } | undefined)?.moreInfo;
  const why = typeof more === "string" ? more : (body.status?.description ?? "");
  if (code === 401 || res.status === 401) return { ok: false, error: "Zoho Mail refused the administrator's grant. Connect Zoho Mail again.", status: 401 };
  return { ok: false, error: `Zoho Mail refused (${why || code}).`, status: code };
}

/** The organisation's id, from the administrator's own Zoho Mail account. */
export async function zohoOrgId(region: ZohoRegion, token: string): Promise<string | null> {
  const accounts = await call<unknown[]>(region, token, "/api/accounts");
  if (!accounts.ok || !Array.isArray(accounts.data)) return null;
  for (const account of accounts.data) {
    const zoid = (account as { policyId?: { zoid?: unknown } } | null)?.policyId?.zoid;
    if (typeof zoid === "number" || (typeof zoid === "string" && /^\d+$/.test(zoid))) return String(zoid);
  }
  return null;
}

export type ZohoAccount = { zuid: string; email: string };

/** Every account in the organisation, by its primary address. */
export async function zohoOrgAccounts(region: ZohoRegion, token: string, zoid: string): Promise<ZohoOutcome<ZohoAccount[]>> {
  const out: ZohoAccount[] = [];
  for (let start = 0; start < 10_000; start += 100) {
    const page = await call<unknown[]>(region, token, `/api/organization/${encodeURIComponent(zoid)}/accounts?start=${start}&limit=100`);
    if (!page.ok) return page;
    const rows = Array.isArray(page.data) ? page.data : [];
    for (const row of rows) {
      const r = row as { zuid?: unknown; primaryEmailAddress?: unknown; mailboxAddress?: unknown };
      const email = typeof r.primaryEmailAddress === "string" ? r.primaryEmailAddress : typeof r.mailboxAddress === "string" ? r.mailboxAddress : "";
      if ((typeof r.zuid === "number" || typeof r.zuid === "string") && email) out.push({ zuid: String(r.zuid), email: email.toLowerCase() });
    }
    if (rows.length < 100) break;
  }
  return { ok: true, data: out };
}

/**
 * The person's signature, put into their account: updated in place when Deskzo has put one there
 * before, added when it hasn't — or when the one it remembers was deleted in Zoho meanwhile.
 */
export async function putZohoSignature(
  region: ZohoRegion,
  token: string,
  where: { zoid: string; zuid: string; signatureId: string | null },
  html: string,
  /** Set on the one retry after finding a lost signature by name, so it can never go round again. */
  recovered = false,
): Promise<ZohoOutcome<{ signatureId: string }>> {
  const path = `/api/organization/${encodeURIComponent(where.zoid)}/accounts/${encodeURIComponent(where.zuid)}/signature`;
  if (where.signatureId) {
    const updated = await call<{ id?: unknown }>(region, token, path, {
      method: "PUT",
      body: { id: where.signatureId, name: ZOHO_SIGNATURE_NAME, content: html, position: 1 },
    });
    if (updated.ok) return { ok: true, data: { signatureId: where.signatureId } };
    if (updated.status === 401 || updated.status === 0) return updated;
    // Gone in Zoho since — add it again below.
  }
  const added = await call<{ id?: unknown }>(region, token, path, { method: "POST", body: { name: ZOHO_SIGNATURE_NAME, content: html, position: 1 } });
  if (!added.ok && !recovered && /already/i.test(added.error)) {
    // Deskzo's signature is there but its id was lost (a sync record cleared): find it by name, update it.
    const existing = await call<unknown>(region, token, path);
    const list = existing.ok ? (Array.isArray(existing.data) ? existing.data : [existing.data]) : [];
    const mine = list.find((s) => (s as { name?: unknown } | null)?.name === ZOHO_SIGNATURE_NAME) as { id?: unknown } | undefined;
    if (mine && (typeof mine.id === "string" || typeof mine.id === "number")) return putZohoSignature(region, token, { ...where, signatureId: String(mine.id) }, html, true);
  }
  if (!added.ok) return added;
  const id = added.data?.id;
  if (typeof id !== "string" && typeof id !== "number") return { ok: false, error: "Zoho Mail added the signature but didn't say its id.", status: 500 };
  return { ok: true, data: { signatureId: String(id) } };
}
