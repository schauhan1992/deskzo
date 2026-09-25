import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * Where the server's own headless browser should load a page of this workspace — for the PDF of
 * an emailed document (src/lib/documents/pdf.ts).
 *
 * The page must be reached *as this workspace*, which means on its host: a loopback address alone
 * would name no workspace at all. So:
 *
 *   · With INTERNAL_APP_URL set (behind a reverse proxy, e.g. http://127.0.0.1:3000), the browser is
 *     sent to the workspace's hostname on that internal port, and told — with Chrome's
 *     --host-resolver-rules — that the hostname lives at the internal address. The request never
 *     leaves the machine and still says which workspace it is for.
 *   · Without it, the workspace's own address, which in development (*.localhost) resolves to this
 *     machine anyway.
 */
export async function renderTarget(path: string): Promise<{ url: string; hostRules: string | null }> {
  const origin = new URL(await tenantOrigin());
  const internal = process.env.INTERNAL_APP_URL?.trim();
  if (!internal) return { url: `${origin.origin}${path}`, hostRules: null };
  const target = new URL(internal);
  return {
    url: `${target.protocol}//${origin.hostname}${target.port ? `:${target.port}` : ""}${path}`,
    hostRules: `MAP ${origin.hostname} ${target.hostname}`,
  };
}
