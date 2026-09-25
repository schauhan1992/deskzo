import { NextResponse } from "next/server";
import { unsubscribeByToken } from "@/lib/marketing/unsubscribe";

/**
 * One-click unsubscribe (RFC 8058) — where every marketing email's `List-Unsubscribe` header points.
 *
 * Gmail and Yahoo POST here themselves when somebody presses "Unsubscribe" beside our name in their
 * inbox, with `List-Unsubscribe=One-Click` in the body and no cookies, no browser, no sign-in. The
 * token is the authority, exactly as in the preference-centre link. Under /api so the crawler check
 * doesn't refuse a mail provider's server.
 *
 * A GET — somebody pasting the address into a browser — goes to the preference centre instead, so
 * nothing is changed by a link-scanner merely following it.
 */

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const done = await unsubscribeByToken(token, "ONE_CLICK").catch((err) => {
    console.error("one-click unsubscribe failed", err);
    return false;
  });
  // 200 either way to the provider: an unknown token has nobody to unsubscribe, and saying so would
  // only tell a stranger which tokens are real.
  return NextResponse.json({ ok: true, done }, { status: 200 });
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return NextResponse.redirect(new URL(`/preferences/${encodeURIComponent(token)}`, request.url), 303);
}
