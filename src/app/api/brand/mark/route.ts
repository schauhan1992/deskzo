import { NextResponse } from "next/server";
import { getBranding } from "@/actions/branding";

/**
 * The workspace's logo as an image, for the workspace switcher on its linked workspaces' pages, which
 * show it beside this workspace's name (`<img src="<origin>/api/brand/mark">`, spec §2.1).
 *
 * Public, with no session: it is the same logo this workspace's sign-in page shows anybody who opens
 * it, and a page on another workspace's address has no session here to send. Under /api, so the proxy
 * only asks which workspace and whether it is open (src/proxy.ts).
 *
 * Only the image types the branding upload accepts (src/actions/branding.ts), each sent as its own type
 * with `nosniff`. An SVG can carry script: shown as an image a browser never runs it, and opened
 * directly it gets a policy that allows nothing and a sandbox (spec §5.1 T21).
 */

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/x-icon"]);

/** No logo yet: asked again within minutes, so one uploaded meanwhile shows up soon. */
function notFound() {
  return new NextResponse("Not found.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" },
  });
}

export async function GET() {
  const { logoDataUrl } = await getBranding();
  const match = logoDataUrl ? /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(logoDataUrl) : null;
  if (!match || !ALLOWED.has(match[1])) return notFound();
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) return notFound();

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": match[1],
      "content-length": String(bytes.length),
      // private, not public: the proxy's NextAuth wrapper can set its CSRF and callback cookies on any /api
      // answer to a browser that has none yet, and a shared cache must never store those for the next
      // visitor. The browser still keeps the mark for an hour.
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Shown on the other workspaces' addresses, which are other origins.
      "cross-origin-resource-policy": "cross-origin",
      "content-disposition": 'inline; filename="mark"',
    },
  });
}
