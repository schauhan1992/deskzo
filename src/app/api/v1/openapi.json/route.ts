import { openApiDocument } from "@/lib/api/openapi";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * The public API's OpenAPI document, for this workspace's own address (src/lib/api/openapi.ts) — what Settings ›
 * Developers & API offers to download. Documentation only: no key needed, nothing of the workspace's in it.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(JSON.stringify(openApiDocument(await tenantOrigin()), null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="deskzo-api.openapi.json"', "cache-control": "no-store" },
  });
}
