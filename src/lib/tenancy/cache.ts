import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * The key every per-workspace cache is filed under.
 *
 * A process serves every workspace, so anything it remembers between requests — a settings row, a
 * lockout, an IP rule, when a job last ran — is remembered *for one of them*, and must be filed under
 * that one's id. The ids differ between workspaces even where their contents might not: a workspace
 * restored from another's backup has the same user ids, which is exactly why a user id alone is not
 * a safe key. check:tenancy lists every such cache.
 */
export async function tenantKey(): Promise<string> {
  return (await currentTenant()).id;
}
