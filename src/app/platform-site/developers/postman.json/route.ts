import { postmanFromOperations } from "@/lib/api/openapi";

/** The public API's Postman collection for any workspace — `{workspace}` in its address (src/lib/api/openapi.ts). */

export const dynamic = "force-static";

export async function GET() {
  return new Response(JSON.stringify(postmanFromOperations(null), null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": 'inline; filename="deskzo-api.postman_collection.json"' },
  });
}
