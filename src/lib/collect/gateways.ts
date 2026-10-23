import type { PaymentGateway } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";
import type { GatewayKeys } from "@/lib/collect/gateway-api";

/**
 * The gateways a workspace has connected (src/lib/collect/gateway-api.ts): at most one Razorpay and one
 * Cashfree, each with the business's own keys, kept encrypted with the workspace's key.
 */

export type ConnectedGateway = Pick<PaymentGateway, "id" | "provider" | "mode" | "keyId" | "bankAccountId" | "isDefault" | "active">;

const SELECT = { id: true, provider: true, mode: true, keyId: true, bankAccountId: true, isDefault: true, active: true } as const;

/** Every gateway connected and switched on. None where the workspace isn't migrated. */
export async function activeGateways(): Promise<ConnectedGateway[]> {
  try {
    return await db.paymentGateway.findMany({ where: { active: true }, orderBy: [{ isDefault: "desc" }, { connectedAt: "asc" }], select: SELECT });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** The one new links are made in: the default, else the only one. */
export async function linkGateway(): Promise<ConnectedGateway | null> {
  return (await activeGateways())[0] ?? null;
}

/** A gateway's keys, decrypted for the call about to be made — never kept. */
export async function gatewayKeys(gatewayId: string): Promise<GatewayKeys | null> {
  const row = await db.paymentGateway.findUnique({ where: { id: gatewayId }, select: { provider: true, mode: true, keyId: true, secretEnc: true } });
  if (!row || !row.secretEnc) return null;
  return { provider: row.provider, mode: row.mode, keyId: row.keyId, secret: await decryptSecret(row.secretEnc) };
}
