import { NextResponse, type NextRequest } from "next/server";
import { currentUser, refuseWhileViewingAs } from "@/lib/session";
import { startConnect } from "@/lib/mail/connect";
import { CONNECT_COOKIE, CONNECT_COOKIE_PATH, CONNECT_TTL_SECONDS, newState, publicOrigin, safeNext, sealState } from "@/lib/mail/connect-state";
import { MAIL_SLUGS, mailCallbackPath, providerOfMailSlug } from "@/lib/workplace/providers";

/**
 * Step one of connecting somebody's own mailbox — off to Microsoft, Google or Zoho, to approve sending
 * as themselves. See src/lib/mail/connect.ts. Outside the proxy (it is under /api), so it checks the
 * session itself.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const provider = providerOfMailSlug((await params).provider);
  if (!provider) return new NextResponse("Not found", { status: 404 });
  const origin = await publicOrigin();
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const back = (outcome: string) =>
    NextResponse.redirect(new URL(`${next}${next.includes("?") ? "&" : "?"}mailbox=${outcome}&via=${MAIL_SLUGS[provider]}`, origin));

  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL(`/login?callbackUrl=${encodeURIComponent(next)}`, origin));
  // Borrowing somebody's account to look around is not a licence to connect a mailbox to it.
  if (await refuseWhileViewingAs()) return back("viewing-as");

  const state = newState();
  const started = await startConnect(provider, { redirectUri: `${origin}${mailCallbackPath(provider)}`, state, email: user.email ?? null });
  if (!started.ok) return back(started.outcome);

  const res = NextResponse.redirect(started.url);
  res.cookies.set(
    CONNECT_COOKIE,
    await sealState({ state, verifier: started.verifier, userId: user.id, expires: Date.now() + CONNECT_TTL_SECONDS * 1000, next, provider: MAIL_SLUGS[provider] }),
    {
      httpOnly: true,
      // Lax, not strict: the provider sends the browser back here with a top-level GET, which is
      // exactly what lax lets the cookie ride along on.
      sameSite: "lax",
      secure: origin.startsWith("https:"),
      path: CONNECT_COOKIE_PATH,
      maxAge: CONNECT_TTL_SECONDS,
    },
  );
  res.headers.set("cache-control", "no-store");
  return res;
}
