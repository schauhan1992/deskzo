import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { deskzoIconDataUrl } from "@/lib/brand/deskzo-logo";
import { isPwaIcon, PWA_ICONS } from "@/lib/pwa";

/**
 * The workspace app's home-screen and desktop icons (src/lib/pwa.ts): Deskzo's icon on every workspace (owner,
 * 23 Oct 2026 — Deskzo's icon on the apps, the company's own logo inside them). Public — a phone or a computer
 * installing the app fetches them with no session.
 *
 * The iPhone one is square to the edge (iOS rounds it, and turns transparent corners black), and so is the
 * maskable one, whose D already sits inside the middle 80% — the circle Android may crop it to.
 */

export const dynamic = "force-dynamic";

const notFound = () => new NextResponse("Not found.", { status: 404, headers: { "cache-control": "no-store" } });

function drawn(name: keyof typeof PWA_ICONS) {
  const { size, rounded } = PWA_ICONS[name];
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- drawn into a PNG, never shown as a page */}
        <img src={deskzoIconDataUrl({ rounded })} width={size} height={size} alt="" />
      </div>
    ),
    { width: size, height: size },
  );
}

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!isPwaIcon(name)) return notFound();
  const png = await drawn(name).arrayBuffer();
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      "content-length": String(png.byteLength),
      // private: the proxy's NextAuth wrapper may set a cookie on any /api answer (src/app/api/brand/mark).
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
