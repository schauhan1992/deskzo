import { createHmac, timingSafeEqual } from "node:crypto";
import { currentKeys } from "@/lib/tenancy/keys";
import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * The secret a mail provider's delivery reports must carry to be believed (/api/marketing/webhook).
 *
 * One per workspace, derived from its keys: nothing to store or rotate separately, shown to its
 * admins in Mail & messaging settings as part of the address to give the provider, and worthless at
 * any other workspace — a shared secret would let anybody who holds it write bounces and
 * unsubscribes into every workspace on the server.
 */
export async function marketingWebhookSecret(): Promise<string> {
  const { digestKey } = await currentKeys();
  return createHmac("sha256", digestKey).update("wroffy/marketing-webhook").digest("base64url").slice(0, 32);
}

/**
 * Whether a presented secret is one this workspace accepts: its own, and for the first workspace also
 * MARKETING_WEBHOOK_SECRET, which providers were configured with before workspaces existed.
 */
export async function isMarketingWebhookSecret(provided: string): Promise<boolean> {
  if (!provided) return false;
  const accepted = [await marketingWebhookSecret()];
  const legacy = process.env.MARKETING_WEBHOOK_SECRET?.trim();
  if (legacy && (await currentTenant()).isDefault) accepted.push(legacy);
  const given = Buffer.from(provided);
  return accepted.some((secret) => {
    const expected = Buffer.from(secret);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}
