import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { getBranding } from "@/actions/branding";
import { brandInitials, contrastColor, type Branding } from "@/lib/branding";
import { brandColor, iconPicture, isPwaIcon, PWA_ICONS } from "@/lib/pwa";

/**
 * The workspace app's home-screen icons (src/lib/pwa.ts): its favicon or a square logo on white when one is
 * sharp enough, else its initials on its brand colour. Public — a phone fetches them with no session.
 *
 * The iPhone one is square to the edge (iOS rounds it, and turns transparent corners black); the maskable
 * one keeps its picture inside the middle 80%, the circle Android may crop it to.
 */

export const dynamic = "force-dynamic";

const notFound = () => new NextResponse("Not found.", { status: 404, headers: { "cache-control": "no-store" } });

function drawn(branding: Branding, name: keyof typeof PWA_ICONS, picture: string | null) {
  const { size, maskable, rounded } = PWA_ICONS[name];
  const radius = rounded ? Math.round(size * 0.22) : 0;
  if (picture) {
    const side = Math.round(size * (maskable ? 0.56 : 0.72));
    return new ImageResponse(
      (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#ffffff", borderRadius: radius }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- drawn into a PNG, never shown as a page */}
          <img src={picture} width={side} height={side} alt="" style={{ objectFit: "contain" }} />
        </div>
      ),
      { width: size, height: size },
    );
  }
  const color = brandColor(branding);
  const initials = brandInitials(branding).slice(0, 3) || "D";
  const scale = (initials.length > 2 ? 0.3 : initials.length > 1 ? 0.38 : 0.48) * (maskable ? 0.8 : 1);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: color,
          color: contrastColor(color),
          borderRadius: radius,
          fontSize: Math.round(size * scale),
          fontWeight: 700,
          letterSpacing: -Math.round(size * 0.01),
        }}
      >
        {initials}
      </div>
    ),
    { width: size, height: size },
  );
}

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!isPwaIcon(name)) return notFound();
  const branding = await getBranding();
  const picture = iconPicture(branding);
  let png: ArrayBuffer;
  try {
    png = await drawn(branding, name, picture).arrayBuffer();
  } catch {
    // A picture the renderer can't read (a malformed SVG): the initials instead, never a broken icon.
    png = await drawn(branding, name, null).arrayBuffer();
  }
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
