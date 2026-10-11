import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { getBranding } from "@/actions/branding";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { inkOn, safeColor } from "@/lib/signatures/render";
import { OUTLOOK_ICON_SIZES } from "@/lib/signatures/outlook";

/**
 * The Outlook add-in's icons (src/lib/signatures/outlook.ts), drawn at each size Outlook asks for: an
 * envelope on the workspace's brand colour. Public: Outlook and the Microsoft 365 admin center fetch
 * them with no session.
 */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!OUTLOOK_ICON_SIZES.includes(size as (typeof OUTLOOK_ICON_SIZES)[number]) || !(await moduleAvailableForTenant("signatures"))) {
    return new NextResponse("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const color = safeColor((await getBranding()).primaryColor ?? "");
  const ink = inkOn(color);
  const glyph = Math.round(size * 0.64);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: color, borderRadius: Math.round(size * 0.22) }}>
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth={size < 32 ? 2.4 : 2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M22 7 13.03 12.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      </div>
    ),
    { width: size, height: size, headers: { "cache-control": "private, max-age=3600" } },
  );
}
