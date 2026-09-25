import { db } from "@/lib/db";

/**
 * A picture from an uploaded email template, for the mail clients that load it.
 *
 * Public by necessity — Gmail's image proxy and Outlook don't sign in — and under /api so the
 * crawler check in front of the app doesn't turn them away. Nothing here is private: these are the
 * pictures in a marketing email, sent to thousands of people. The id is unguessable all the same.
 *
 * Only images were ever stored (each checked by its bytes on upload), and each is sent with its own
 * type and `nosniff`, so nothing served from here can be persuaded to run as a page.
 */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id } = await params;
  const asset = /^[a-z0-9]{8,40}$/i.test(id)
    ? await db.marketingAsset.findUnique({ where: { id }, select: { data: true, mimeType: true } }).catch(() => null)
    : null;
  if (!asset || !asset.mimeType.startsWith("image/")) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(asset.data), {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.data.length),
      // A picture never changes under its id — a replaced template gets new ids.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
