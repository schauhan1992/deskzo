import { NextResponse } from "next/server";
import { ASSET_HASH } from "@/lib/app-updates/protocol";
import { appUpdateAsset, updatesNotMigrated } from "@/lib/app-updates/store";

export const dynamic = "force-dynamic";

/**
 * A file of a phone app update — its JavaScript, a font, an image — by the hash its manifest names it by (owner,
 * 23 Oct 2026). A hash names one set of bytes forever, so it may be cached anywhere for good.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!ASSET_HASH.test(hash)) return NextResponse.json({ error: "No such file." }, { status: 404 });
  let asset: Awaited<ReturnType<typeof appUpdateAsset>>;
  try {
    asset = await appUpdateAsset(hash);
  } catch (err) {
    if (updatesNotMigrated(err)) asset = null;
    else throw err;
  }
  if (!asset) return NextResponse.json({ error: "No such file." }, { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(Buffer.from(asset.bytes), {
    headers: {
      "content-type": asset.contentType,
      "content-length": String(asset.bytes.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
