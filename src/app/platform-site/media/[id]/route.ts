import { mediaFile } from "@/lib/cms/media";
import { controlConfigured } from "@/lib/platform/control-db";

/**
 * An image from the website's media library, at /media/<id> on the public site (and on the CMS host,
 * for its previews — src/proxy.ts). Only images the CMS accepted are stored (PNG, JPEG, WebP, GIF,
 * checked by their bytes), and each is sent with its stored type, never sniffed, and a policy that
 * runs nothing if it is opened on its own. Ids are never reused, so a response is cacheable for good.
 */

const notFound = () => new Response("Not found.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function GET(_request: Request, { params }: RouteContext<"/platform-site/media/[id]">) {
  const { id } = await params;
  if (!controlConfigured() || !/^[a-z0-9]{20,40}$/.test(id)) return notFound();
  let file: Awaited<ReturnType<typeof mediaFile>>;
  try {
    file = await mediaFile(id);
  } catch (err) {
    console.error(`[site] a media image could not be read: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
    return new Response("Unavailable.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "30" } });
  }
  if (!file) return notFound();
  return new Response(new Uint8Array(file.data), {
    status: 200,
    headers: {
      "content-type": file.mime,
      "content-length": String(file.data.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${file.sha256}"`,
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
