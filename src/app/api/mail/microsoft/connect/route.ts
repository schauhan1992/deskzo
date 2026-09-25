import { NextResponse, type NextRequest } from "next/server";
import { currentUser, refuseWhileViewingAs } from "@/lib/session";
import { CALLBACK_PATH, authorizeUrl, microsoftApp, pkcePair } from "@/lib/mail/microsoft";
import { CONNECT_COOKIE, CONNECT_COOKIE_PATH, CONNECT_TTL_SECONDS, newState, publicOrigin, safeNext, sealState } from "@/lib/mail/connect-state";

/**
 * Step one of connecting somebody's own Outlook — off to Microsoft, to approve sending as themselves.
 * See src/lib/mail/microsoft.ts. Outside the proxy (it is under /api), so it checks the session itself.
 */
export async function GET(req: NextRequest) {
  const origin = await publicOrigin();
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const back = (outcome: string) => NextResponse.redirect(new URL(`${next}${next.includes("?") ? "&" : "?"}outlook=${outcome}`, origin));

  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL(`/login?callbackUrl=${encodeURIComponent(next)}`, origin));
  // Borrowing somebody's account to look around is not a licence to connect a mailbox to it.
  if (await refuseWhileViewingAs()) return back("viewing-as");

  const app = await microsoftApp();
  if (!app) return back("not-configured");

  const { verifier, challenge } = pkcePair();
  const state = newState();
  const res = NextResponse.redirect(
    authorizeUrl(app, { redirectUri: `${origin}${CALLBACK_PATH}`, state, challenge, loginHint: user.email ?? null }),
  );
  res.cookies.set(CONNECT_COOKIE, await sealState({ state, verifier, userId: user.id, expires: Date.now() + CONNECT_TTL_SECONDS * 1000, next }), {
    httpOnly: true,
    // Lax, not strict: Microsoft sends the browser back here with a top-level GET, which is exactly
    // what lax lets the cookie ride along on.
    sameSite: "lax",
    secure: origin.startsWith("https:"),
    path: CONNECT_COOKIE_PATH,
    maxAge: CONNECT_TTL_SECONDS,
  });
  res.headers.set("cache-control", "no-store");
  return res;
}
