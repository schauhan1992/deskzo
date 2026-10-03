import { NextResponse, type NextRequest } from "next/server";
import { currentUser, refuseWhileViewingAs } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { finishConnect } from "@/lib/mail/connect";
import { CONNECT_COOKIE, CONNECT_COOKIE_PATH, openState, publicOrigin } from "@/lib/mail/connect-state";
import { MAIL_NAMES, MAIL_SLUGS, mailCallbackPath, providerOfMailSlug } from "@/lib/workplace/providers";

/**
 * Step two: the provider sends the browser back with a code. Every check happens before anything is
 * stored — the state matches, it was started for this provider, the person is the one who started,
 * the code is good, and the mailbox is theirs (src/lib/mail/connect.ts).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const provider = providerOfMailSlug((await params).provider);
  const origin = await publicOrigin();
  const saved = await openState(req.cookies.get(CONNECT_COOKIE)?.value);
  const next = saved?.next ?? "/profile";
  const back = (outcome: string) => {
    const via = provider ? `&via=${MAIL_SLUGS[provider]}` : "";
    const res = NextResponse.redirect(new URL(`${next}${next.includes("?") ? "&" : "?"}mailbox=${outcome}${via}`, origin));
    // Spent either way: a state is good for one round trip.
    res.cookies.set(CONNECT_COOKIE, "", { path: CONNECT_COOKIE_PATH, maxAge: 0 });
    res.headers.set("cache-control", "no-store");
    return res;
  };
  if (!provider) return back("failed");

  const query = req.nextUrl.searchParams;
  if (query.get("error")) return back(query.get("error") === "access_denied" ? "declined" : "failed");
  const code = query.get("code");
  const state = query.get("state");
  // One started before Gmail and Zoho has no provider in it, and was Outlook.
  const startedFor = saved?.provider ?? MAIL_SLUGS.MICROSOFT;
  if (!saved || !code || !state || state !== saved.state || startedFor !== MAIL_SLUGS[provider]) return back("expired");

  const user = await currentUser();
  if (!user || user.id !== saved.userId) return back("expired");
  if (await refuseWhileViewingAs()) return back("viewing-as");

  const done = await finishConnect(provider, {
    user: { id: user.id, email: user.email ?? "" },
    code,
    verifier: saved.verifier,
    redirectUri: `${origin}${mailCallbackPath(provider)}`,
    accountsServer: query.get("accounts-server"),
  });
  if (done.outcome === "connected" || done.outcome === "no-calendar") {
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "MailConnection",
      entityId: user.id,
      entityLabel: `${MAIL_NAMES[provider]} connected: ${done.mailbox}`,
    });
  }
  return back(done.outcome);
}
