import { NextResponse } from "next/server";

/** Images that may go in an email: no SVG (it can carry script), and only these. */
const SAFE_IMAGE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** A stored `data:` image as a response a mail client can load, or a 404 when it isn't a safe one. */
export function dataUrlImage(dataUrl: string | null | undefined, maxAgeSeconds: number): NextResponse {
  const match = dataUrl ? /^data:([a-z/+.-]+);base64,(.*)$/i.exec(dataUrl) : null;
  const mime = match?.[1]?.toLowerCase();
  if (!match || !mime || !SAFE_IMAGE.has(mime)) return new NextResponse("Not found", { status: 404 });
  const bytes = Buffer.from(match[2]!, "base64");
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.length),
      "Cache-Control": `public, max-age=${maxAgeSeconds}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
