import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * Whether the workspace in hand may change what every workspace on the server shares: the PIN
 * directory and world places (the reference database), and the GeoIP file the access gate reads.
 *
 * These are the platform's, not any one customer's — an admin of one workspace re-syncing the PIN
 * directory or uploading a GeoIP file would be changing every other workspace's address lookups and
 * network rules. Until the platform console exists they are managed from the first workspace, which
 * is the installation's own; every other workspace sees them and cannot change them.
 */
export async function mayManageSharedData(): Promise<boolean> {
  return (await currentTenant()).isDefault;
}

export const SHARED_DATA_REFUSAL = "This is shared by every workspace on the server, and only the platform can change it.";
