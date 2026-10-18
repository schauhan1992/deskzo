"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { QrCode, Smartphone } from "lucide-react";
import { phonePairingState, signOutPhone, startPhonePairing, type MyPhone } from "@/actions/app-devices";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { OutboundLink } from "@/components/ui/outbound-link";
import { useClock } from "@/components/time/clock-provider";

/**
 * Settings › Deskzo app (owner, 18 Oct 2026): a code to pair your phone — a QR for the app to scan, the
 * same ten characters to type — and the phones you've paired. The page watches the code until a phone
 * uses it, so you see it arrive.
 */

type Pairing = { id: string; code: string; qr: string; expiresAt: string };

const STATUS: Record<MyPhone["status"], { label: string; tone: "green" | "amber" | "red" | "default" }> = {
  APPROVED: { label: "Signed in", tone: "green" },
  PENDING: { label: "Waiting for approval", tone: "amber" },
  REJECTED: { label: "Turned down", tone: "red" },
  REVOKED: { label: "Signed out", tone: "default" },
};

export function PhonePairing({ phones, playUrl }: { phones: MyPhone[]; playUrl: string | null }) {
  const router = useRouter();
  const clock = useClock();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [paired, setPaired] = useState<{ phone: string; approved: boolean } | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Watching the code: every two seconds until a phone uses it or it runs out.
  useEffect(() => {
    if (!pairing) return;
    let live = true;
    const timer = setInterval(() => {
      void phonePairingState(pairing.id).then((s) => {
        if (!live) return;
        if (s.state === "PAIRED") {
          setPaired({ phone: s.phone, approved: s.approved });
          setPairing(null);
          router.refresh();
        } else if (s.state === "EXPIRED") {
          setExpired(true);
          setPairing(null);
        }
      });
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pairing, router]);

  function newCode() {
    setError(null);
    setPaired(null);
    setExpired(false);
    start(async () => {
      const r = await startPhonePairing();
      if (!r.ok) return setError(r.error);
      setPairing(r.data);
    });
  }

  function signOut(p: MyPhone) {
    if (!window.confirm(`Sign ${p.name} out of the Deskzo app? Its calls stop logging until you pair it again.`)) return;
    start(async () => {
      const r = await signOutPhone(p.id);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Pair a phone</CardHeader>
        <CardContent className="space-y-4 text-sm">
          {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-danger">{error}</p>}
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>
              Install the Deskzo app on your Android phone
              {playUrl ? (
                <>
                  {" "}
                  from{" "}
                  <OutboundLink href={playUrl} className="text-brand hover:underline">
                    Google Play
                  </OutboundLink>
                </>
              ) : null}
              .
            </li>
            <li>Open it and choose Pair with a code.</li>
            <li>Scan the code below, or type its ten characters. It works once, for ten minutes.</li>
          </ol>

          {pairing ? (
            <div className="flex flex-wrap items-center gap-6 rounded-base border border-line p-4">
              {/* The QR is an SVG made on the server from the code alone (src/actions/app-devices.ts). */}
              <div className="h-44 w-44 shrink-0 rounded-base bg-white p-2 [&>svg]:h-full [&>svg]:w-full" role="img" aria-label="QR code to pair your phone" dangerouslySetInnerHTML={{ __html: pairing.qr }} />
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wide text-muted">Or type</p>
                <p className="font-mono text-2xl font-semibold tracking-widest text-text">{pairing.code}</p>
                <p className="text-xs text-muted">Good until {clock.time(new Date(pairing.expiresAt))}. Waiting for your phone…</p>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPairing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" onClick={newCode} disabled={pending}>
              <QrCode className="h-4 w-4" /> {pending ? "Making a code…" : "Show a pairing code"}
            </Button>
          )}

          {paired && (
            <p className="rounded-md bg-success-bg px-3 py-2 text-success">
              {paired.approved ? `${paired.phone} is paired. Switch on call sync in the app to start logging calls.` : `${paired.phone} is paired and waiting for an administrator to approve it — your role only allows approved devices.`}
            </p>
          )}
          {expired && <p className="text-muted">That code ran out. Show a new one when your phone is ready.</p>}
          <p className="text-xs text-subtle">
            Only calls with numbers on customers and contacts you can see in Deskzo are sent — everything else stays on your phone. Your administrators see paired phones in Security › Devices and can sign one out.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Your phones</CardHeader>
        <CardContent className="text-sm">
          {phones.length === 0 ? (
            <p className="text-muted">No phone paired yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {phones.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
                  <Smartphone className="h-5 w-5 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-text">{p.name}</p>
                    <p className="text-xs text-muted">
                      Paired {clock.date(new Date(p.pairedAt))} · last seen {clock.dateTimeShort(new Date(p.lastSeenAt))}
                      {p.appVersion ? ` · app ${p.appVersion}` : ""}
                      {p.status === "APPROVED" ? (p.callSync ? " · call sync on" : " · call sync off") : ""}
                    </p>
                  </div>
                  <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                  {(p.status === "APPROVED" || p.status === "PENDING") && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => signOut(p)} disabled={pending}>
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
