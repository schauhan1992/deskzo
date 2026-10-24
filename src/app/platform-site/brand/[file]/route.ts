import sharp from "sharp";
import { DESKZO_BLUE, deskzoIconSvg, deskzoWordmarkSvg } from "@/lib/brand/deskzo-logo";
import { productIconSvg } from "@/lib/brand/product-icons";
import { PRODUCTS } from "@/lib/products";

/**
 * Deskzo's official logo at a fixed address on the public site, /brand/<file> (owner, 23 Oct 2026;
 * src/lib/brand/deskzo-logo.ts) — what the site's structured data names as the organisation's logo, and what
 * an email or a partner can link to. Drawn from the traced shapes, so there is one copy of the logo.
 *
 *   deskzo-logo.svg        the wordmark in Deskzo blue
 *   deskzo-logo-white.svg  the wordmark in white, for dark backgrounds
 *   deskzo-icon.svg        the icon: the blue D on its white tile
 *   deskzo-icon-512.png    the icon as a 512 px picture, for places that don't take SVG
 *
 * And each product's icon (src/lib/brand/product-icons.ts), by its key in src/lib/products.ts:
 *
 *   product-<key>.svg      deskzo.com/brand/product-crm.svg
 *   product-<key>-512.png  the same as a 512 px picture
 */

const SVG = "image/svg+xml";
const svgFile = (svg: string) => async () => ({ type: SVG, body: new TextEncoder().encode(svg) });
const pngFile = (svg: string) => async () => ({ type: "image/png", body: new Uint8Array(await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer()) });

const FILES: Record<string, () => Promise<{ type: string; body: Uint8Array<ArrayBuffer> }>> = {
  "deskzo-logo.svg": svgFile(deskzoWordmarkSvg(DESKZO_BLUE)),
  "deskzo-logo-white.svg": svgFile(deskzoWordmarkSvg("#FFFFFF")),
  "deskzo-icon.svg": svgFile(deskzoIconSvg()),
  "deskzo-icon-512.png": pngFile(deskzoIconSvg()),
  ...Object.fromEntries(
    PRODUCTS.flatMap((p) => [
      [`product-${p.key}.svg`, svgFile(productIconSvg(p.key, { size: 128 }))],
      // Drawn at 512 from the start, so the picture is sharp rather than a small one blown up.
      [`product-${p.key}-512.png`, pngFile(productIconSvg(p.key, { size: 512 }))],
    ]),
  ),
};

export async function GET(_request: Request, { params }: RouteContext<"/platform-site/brand/[file]">) {
  const { file } = await params;
  const make = Object.hasOwn(FILES, file) ? FILES[file] : undefined;
  if (!make) return new Response("Not found.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const { type, body } = await make();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(body.byteLength),
      // A day: long enough to be cheap, short enough that a change to the logo reaches everyone soon.
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
