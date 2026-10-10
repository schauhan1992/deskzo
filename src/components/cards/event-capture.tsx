"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { Camera, Check, ScanLine, X } from "lucide-react";
import { captureEventContact, readScannedCode } from "@/actions/card";
import type { CardQuestion } from "@/lib/cards/fields";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

/** The browser's own QR reader — Chrome and Edge on Android and desktop have it; Safari doesn't yet. */
type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type DetectorClass = new (options: { formats: string[] }) => Detector;

const EMPTY = { name: "", email: "", phone: "", company: "", jobTitle: "", note: "" };
const noSubscription = () => () => {};

/**
 * Adding somebody met at an event: scan their card's QR — a Deskzo card, a vCard, a MECARD — to fill the
 * form in, or type it. Checked by the server, saved as yours, and — with the CRM — a lead in your name.
 */
export function EventCapture({ eventId, eventName, questions }: { eventId: string; eventName: string; questions: CardQuestion[] }) {
  const [values, setValues] = useState(EMPTY);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pasted, setPasted] = useState("");
  const [scanning, setScanning] = useState(false);
  // A fact about the browser, never about the server's render: unknown (null) until it hydrates.
  const canScan = useSyncExternalStore(
    noSubscription,
    () => "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia,
    () => null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; leadLink: string | null } | null>(null);
  const [pending, start] = useTransition();
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);

  // The camera is let go of when the page is left mid-scan.
  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);

  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));

  function stopCamera() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setScanning(false);
  }

  function read(raw: string) {
    setError(null);
    start(async () => {
      const result = await readScannedCode(eventId, raw);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const c = result.data;
      setValues((v) => ({
        name: c.name || v.name,
        email: c.email || v.email,
        phone: c.phone || v.phone,
        company: c.company || v.company,
        jobTitle: c.jobTitle || v.jobTitle,
        note: [v.note, c.note].filter(Boolean).join("\n"),
      }));
      setPasted("");
    });
  }

  async function scan() {
    setError(null);
    setSaved(null);
    try {
      const Detector = (window as unknown as { BarcodeDetector: DetectorClass }).BarcodeDetector;
      const detector = new Detector({ formats: ["qr_code"] });
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      setScanning(true);
      // The element renders on the next paint.
      await new Promise((r) => requestAnimationFrame(r));
      if (!video.current) throw new Error("no video");
      video.current.srcObject = stream.current;
      await video.current.play();
      const tick = async () => {
        if (!stream.current || !video.current) return;
        try {
          const found = await detector.detect(video.current);
          if (found[0]?.rawValue) {
            stopCamera();
            read(found[0].rawValue);
            return;
          }
        } catch {
          // A frame that couldn't be read; try the next.
        }
        window.setTimeout(tick, 250);
      };
      void tick();
    } catch {
      stopCamera();
      setError("The camera couldn't be opened. Allow it for this site, or paste the card's link below.");
    }
  }

  function save() {
    setError(null);
    start(async () => {
      const result = await captureEventContact({ eventId, ...values, answers });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved({ name: values.name, leadLink: result.data.leadLink });
      setValues(EMPTY);
      setAnswers({});
    });
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      {saved && (
        <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success-bg px-4 py-3 text-sm text-success">
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="flex-1">
            {saved.name} is saved against {eventName}.{" "}
            {saved.leadLink && (
              <Link href={saved.leadLink} className="underline">
                Open the lead
              </Link>
            )}
          </p>
        </div>
      )}

      <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
        {scanning ? (
          <div className="space-y-2">
            <video ref={video} className="aspect-square w-full rounded-lg bg-black object-cover" muted playsInline />
            <Button type="button" variant="secondary" className="w-full" onClick={stopCamera}>
              <X className="h-4 w-4" />
              Stop scanning
            </Button>
          </div>
        ) : canScan ? (
          <Button type="button" className="w-full" onClick={scan} disabled={pending}>
            <Camera className="h-4 w-4" />
            Scan their card&apos;s QR
          </Button>
        ) : (
          <p className="text-sm text-muted">
            This browser can&apos;t read QR codes itself. Scan with the phone&apos;s camera, copy the link it finds, and paste it below — or type their details.
          </p>
        )}
        <div className="flex gap-2">
          <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Or paste a card's link or contact text" aria-label="A card's link or contact text" />
          <Button type="button" variant="secondary" disabled={!pasted.trim() || pending} onClick={() => read(pasted)}>
            <ScanLine className="h-4 w-4" />
            Read
          </Button>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
        <div className="space-y-1.5">
          <Label htmlFor="cap-name">Name</Label>
          <Input id="cap-name" maxLength={120} value={values.name} onChange={set("name")} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cap-email">Email</Label>
            <Input id="cap-email" type="email" maxLength={200} value={values.email} onChange={set("email")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cap-phone">Phone</Label>
            <Input id="cap-phone" type="tel" maxLength={32} value={values.phone} onChange={set("phone")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cap-company">Company</Label>
            <Input id="cap-company" maxLength={160} value={values.company} onChange={set("company")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cap-title">Job title</Label>
            <Input id="cap-title" maxLength={80} value={values.jobTitle} onChange={set("jobTitle")} />
          </div>
        </div>
        {questions.map((q) => (
          <div key={q.id} className="space-y-1.5">
            <Label htmlFor={`cap-q-${q.id}`}>{q.label}</Label>
            <Input id={`cap-q-${q.id}`} maxLength={500} value={answers[q.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
          </div>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="cap-note">Your note</Label>
          <Textarea id="cap-note" rows={3} maxLength={1000} value={values.note} onChange={set("note")} placeholder="What you talked about, what to send them" />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="button" className="w-full" disabled={pending || !values.name.trim()} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </section>
    </div>
  );
}
