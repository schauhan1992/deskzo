import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Fingerprint, Globe, Laptop, Lock, RefreshCw } from "lucide-react";
import { lockNoticeFor, type LockNotice } from "@/lib/access/lock";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { auth } from "@/lib/auth";
import { evaluateAccess } from "@/lib/access/gate";
import { requestFacts } from "@/lib/access/request";
import { HOLD_MESSAGE } from "@/lib/access/decide";
import { DEVICE_KIND_LABEL, deviceLabel } from "@/lib/access/device";
import { lookupIp, placeText } from "@/lib/access/geo";
import { normaliseIp } from "@/lib/access/ip";
import { leaveAccessPage } from "@/actions/access-gate";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShareLocation } from "@/components/access/share-location";

export const metadata: Metadata = {
  title: "Signing in",
  robots: { index: false, follow: false },
};

/** Only somewhere inside this app — never an absolute address, never protocol-relative. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/access")) return "/dashboard";
  return next;
}

/**
 * Where the access gate sends somebody it holds — and the only signed-in page it never holds, or
 * they could not be told why.
 *
 * Reads the session directly rather than through `requireUser`, whose gate would refuse exactly the
 * people this page is for. If nothing is holding them any more — the device was approved while
 * they waited, the network was allowed — it sends them on to where they were going.
 */
export default async function AccessPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const { next } = await searchParams;
  const target = safeNext(next);

  const facts = await requestFacts();
  const verdict = await evaluateAccess({
    userId: session.user.id,
    sid: session.user.sid ?? null,
    ip: facts.ip,
    userAgent: facts.userAgent,
    mobileHint: facts.mobileHint,
    deviceToken: facts.deviceToken,
    path: "/access",
  });
  if (verdict.ok) redirect(target);
  if (verdict.reason === "LOCKED") {
    return <LockedSplash notice={await lockNoticeFor(session.user.id)} target={target} who={session.user.name ?? session.user.email ?? ""} clock={await workspaceClock()} />;
  }

  const message = HOLD_MESSAGE[verdict.reason];
  const ip = normaliseIp(facts.ip);
  const place = placeText(lookupIp(ip));
  const waiting = verdict.reason === "DEVICE_PENDING" || verdict.reason === "NETWORK_HELD";

  return (
    <div className="flex min-h-screen items-start justify-center bg-bg px-4 py-12">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 py-7">
          <div className="space-y-2">
            <Fingerprint className="h-7 w-7 text-brand" aria-hidden />
            <h1 className="text-lg font-semibold text-text">{message.title}</h1>
            <p className="text-sm text-muted">{message.body}</p>
          </div>

          <dl className="space-y-2 rounded-lg border border-line bg-surface-sunken px-3.5 py-3 text-sm">
            <div className="flex items-start gap-2">
              <Laptop className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
              <div>
                <dt className="sr-only">Device</dt>
                <dd className="text-text">
                  {deviceLabel(facts.userAgent)} · {DEVICE_KIND_LABEL[verdict.kind].toLowerCase()}
                </dd>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
              <div>
                <dt className="sr-only">Network</dt>
                <dd className="text-text">
                  {ip ?? "Address unknown"}
                  {place && <span className="text-muted"> · {place}</span>}
                </dd>
              </div>
            </div>
          </dl>

          {verdict.reason === "LOCATION_NEEDED" && <ShareLocation next={target} />}

          {waiting && (
            <Link href={{ pathname: "/access", query: { next: target } }} className="block">
              <Button variant="secondary" className="w-full">
                <RefreshCw className="h-4 w-4" />
                Check again
              </Button>
            </Link>
          )}

          <form action={leaveAccessPage}>
            <Button type="submit" variant={verdict.reason === "SESSION_ENDED" ? "primary" : "ghost"} className="w-full">
              {verdict.reason === "SESSION_ENDED" ? "Sign in again" : "Sign out"}
            </Button>
          </form>

          <p className="text-center text-xs text-subtle">
            Signed in as {session.user.name ?? session.user.email}. Every sign-in is recorded with its network and approximate
            location.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * What somebody an administrator has locked sees — all they see, whatever they open. It is a page
 * the server sends instead of the app, not a layer over it, so there is nothing underneath to reach.
 * Only two ways out: check again (for when the lock has been lifted), and sign out.
 */
function LockedSplash({ notice, target, who, clock }: { notice: LockNotice | null; target: string; who: string; clock: Clock }) {
  const company = notice?.scope === "company";
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-12">
      <Card className="w-full max-w-lg shadow-xl">
        <CardContent className="space-y-5 py-9 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-danger/10">
            <Lock className="h-8 w-8 text-danger" aria-hidden />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-semibold text-text">{company ? "The CRM is locked" : "Your access is locked"}</h1>
            <p className="whitespace-pre-line text-sm leading-relaxed text-text">{notice?.message ?? HOLD_MESSAGE.LOCKED.body}</p>
          </div>
          {notice?.until && (
            <p className="rounded-lg border border-line bg-surface-sunken px-3 py-2 text-sm text-text">
              Access returns on <span className="font-medium">{clock.dateTime(notice.until)}</span> ({clock.zone.replace(/_/g, " ")} time).
            </p>
          )}
          {notice?.lockedAt && (
            <p className="text-xs text-subtle">
              Locked {notice.lockedBy ? `by ${notice.lockedBy} ` : ""}on {clock.dateTime(notice.lockedAt)}.
            </p>
          )}
          <div className="space-y-2">
            <Link href={{ pathname: "/access", query: { next: target } }} className="block">
              <Button variant="secondary" className="w-full">
                <RefreshCw className="h-4 w-4" />
                Check again
              </Button>
            </Link>
            <form action={leaveAccessPage}>
              <Button type="submit" variant="ghost" className="w-full">
                Sign out
              </Button>
            </form>
          </div>
          <p className="text-xs text-subtle">Signed in as {who}.</p>
        </CardContent>
      </Card>
    </div>
  );
}
