import { WIDGET_SCRIPT } from "@/lib/inbox/widget-script";

/**
 * The Customer inbox's chat bubble, as a script any website may include (src/lib/inbox/widget-script.ts).
 * The same for every workspace and every channel — the `data-key` on the tag says which — so it is cached
 * for a while and reads nothing. Outside the proxy (src/proxy.ts matcher), like the bubble's own calls.
 */

export const dynamic = "force-static";

export function GET() {
  return new Response(WIDGET_SCRIPT, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    },
  });
}
