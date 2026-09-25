import { NextResponse, type NextRequest } from "next/server";
import { currentUser, refuseWhileViewingAs } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { CALLBACK_PATH, exchangeCode, fetchMe, mailboxFor, microsoftApp, saveConnection } from "@/lib/mail/microsoft";
import { CONNECT_COOKIE, CONNECT_COOKIE_PATH, openState, publicOrigin } from "@/lib/mail/connect-state";

/**
 * Step two: Microsoft sends the browser back with a code. Every check happens before anything is
 * stored — the state matches, the person is the one who started, the code is good, and the mailbox
 * is theirs.
 */
export async function GET(req: NextRequest) {
  const origin = await publicOrigin();
  const saved = openState(req.cookies.get(CONNECT_COOKIE)?.value);
  const next = saved?.next ?? "/profile";
  const back = (outcome: string) => {
    const res = NextResponse.redirect(new URL(`${next}${next.includes("?") ? "&" : "?"}outlook=${outcome}`, origin));
    // Spent either way: a state is good for one round trip.
    res.cookies.set(CONNECT_COOKIE, "", { path: CONNECT_COOKIE_PATH, maxAge: 0 });
    res.headers.set("cache-control", "no-store");
    return res;
  };

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return back(params.get("error") === "access_denied" ? "declined" : "failed");
  const code = params.get("code");
  const state = params.get("state");
  if (!saved || !code || !state || state !== saved.state) return back("expired");

  const user = await currentUser();
  if (!user || user.id !== saved.userId) return back("expired");
  if (await refuseWhileViewingAs()) return back("viewing-as");

  const app = await microsoftApp();
  if (!app) return back("not-configured");

  const exchanged = await exchangeCode(app, { code, verifier: saved.verifier, redirectUri: `${origin}${CALLBACK_PATH}` });
  if (!exchanged.ok || !exchanged.tokens.refreshToken) return back("failed");
  if (!/\bMail\.Send\b/i.test(exchanged.tokens.scope)) return back("no-permission");

  const me = await fetchMe(exchanged.tokens.accessToken);
  if (!me) return back("failed");
  const mailbox = mailboxFor(user.email ?? "", me);
  // Somebody else's mailbox, or a personal account signed in to the same browser.
  if (!mailbox) return back("mismatch");

  await saveConnection(user.id, mailbox, me.displayName, { ...exchanged.tokens, refreshToken: exchanged.tokens.refreshToken });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "MailConnection", entityId: user.id, entityLabel: `Outlook connected: ${mailbox}` });
  return back("connected");
}
