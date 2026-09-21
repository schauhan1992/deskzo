import { NextResponse } from "next/server";
import { kioskDirectory } from "@/actions/visitor-public";

/**
 * The web app manifest, generated per kiosk.
 *
 * `display: "fullscreen"` is what removes the address bar once the tablet has been added to its
 * home screen — the requirement that the URL not be visible. It matters for more than tidiness:
 * the URL *is* the credential here, so a visible address bar is a credential on display in a lobby.
 *
 * `start_url` points at this kiosk's own form, so the installed icon opens the right desk.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const directory = await kioskDirectory(token);
  if (!directory) return new NextResponse("Not found", { status: 404 });

  return NextResponse.json(
    {
      name: `${directory.kioskName} — Visitor sign-in`,
      short_name: "Sign in",
      description: "Visitor sign-in for reception.",
      start_url: `/kiosk/${token}`,
      scope: `/kiosk/${token}`,
      display: "fullscreen",
      orientation: "portrait",
      background_color: "#ffffff",
      theme_color: "#4f46e5",
      icons: [
        { src: "/kiosk-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
      ],
    },
    {
      headers: {
        "content-type": "application/manifest+json",
        // The manifest carries the token in start_url, so it is never a shared cache entry.
        "cache-control": "no-store",
      },
    },
  );
}
