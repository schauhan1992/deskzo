"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eraser, PenLine, Upload } from "lucide-react";
import { removeLetterSignature, saveLetterSignature, setLetterSignByDefault } from "@/actions/letter-templates";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { cn } from "@/lib/utils";

type Settings = { imageDataUrl: string | null; stampDataUrl: string | null; signByDefault: boolean; migrated: boolean };

/**
 * The signature HR's letters carry (owner, 21 Oct 2026): the signatory's, uploaded or drawn here, kept apart
 * from the invoice stamp. Printed above the signatory's name on every letter marked signed; a letter keeps
 * the image it was issued with, so changing it here never re-signs one somebody already holds.
 */
export function LetterSignaturePanel({ settings }: { settings: Settings }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [drawing, setDrawing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!settings.migrated) {
    return (
      <Card className="max-w-2xl p-5 text-sm text-muted">
        This workspace&apos;s database hasn&apos;t been brought up to date yet. Until it is, letters are signed with the stamp from Settings › Organisation.
      </Card>
    );
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setMessage({ ok: false, text: result.error ?? "That didn't work." });
        return;
      }
      setMessage({ ok: true, text: done });
      setDrawing(false);
      router.refresh();
    });
  }

  function upload(file: File) {
    const reader = new FileReader();
    reader.onload = () => run(() => saveLetterSignature(String(reader.result)), "Saved. Letters issued from now on carry it.");
    reader.readAsDataURL(file);
  }

  const shown = settings.imageDataUrl ?? settings.stampDataUrl;

  return (
    <div className="max-w-2xl space-y-4">
      <Card className="p-5">
        <h2 className="text-sm font-medium text-text">The signature on letters</h2>
        <div className="mt-3 flex min-h-[7rem] items-center justify-center rounded-base border border-dashed border-line-strong bg-white p-3">
          {drawing ? (
            <SignaturePad
              onCancel={() => setDrawing(false)}
              onSave={(dataUrl) => run(() => saveLetterSignature(dataUrl), "Saved. Letters issued from now on carry it.")}
              pending={pending}
            />
          ) : shown ? (
            /* eslint-disable-next-line @next/next/no-img-element -- a data URL, shown as stored */
            <img src={shown} alt="The letter signature" className="max-h-24 w-auto object-contain" />
          ) : (
            <span className="text-sm text-subtle">No signature yet.</span>
          )}
        </div>
        {!drawing && (
          <p className="mt-2 text-xs text-subtle">
            {settings.imageDataUrl
              ? "The signatory's signature, printed above their name on signed letters."
              : settings.stampDataUrl
                ? "None of its own yet, so signed letters carry the stamp from Settings › Organisation."
                : "Upload a scan of the signatory's signature on white, or sign here with a mouse or a finger."}
          </p>
        )}

        {!drawing && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={pending}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Upload an image
            </Button>
            <Button variant="secondary" onClick={() => setDrawing(true)} disabled={pending}>
              <PenLine className="mr-1.5 h-3.5 w-3.5" />
              Sign here
            </Button>
            {settings.imageDataUrl && (
              <Button variant="ghost" onClick={() => run(removeLetterSignature, "Removed.")} disabled={pending}>
                Remove
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              aria-label="Signature image"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload(file);
                e.target.value = "";
              }}
            />
          </div>
        )}
        {message && <p className={cn("mt-3 text-sm", message.ok ? "text-success" : "text-danger")}>{message.text}</p>}
      </Card>

      <Card className="p-5">
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            checked={settings.signByDefault}
            disabled={pending}
            onChange={() => run(() => setLetterSignByDefault(!settings.signByDefault), "Saved.")}
            aria-label="Sign new letters"
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium text-text">Sign new letters</span>
            <span className="block text-xs text-muted">
              Whether a letter starts out with the signature when it&apos;s drafted. Either way, each draft has its own &ldquo;Add digital signature&rdquo;
              switch.
            </span>
          </span>
        </label>
      </Card>

      <p className="text-xs text-subtle">
        This is a picture of the signature on the letter, as a stamp is — not an Aadhaar eSign or a DSC certificate, which a document needing a
        legally verifiable digital signature would need.
      </p>
    </div>
  );
}

/** A box to sign in with a mouse, a pen or a finger, saved as a PNG with a transparent background. */
function SignaturePad({ onSave, onCancel, pending }: { onSave: (dataUrl: string) => void; onCancel: () => void; pending: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Drawn at the screen's density, so the line isn't blurred on a phone.
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0b1f4d";
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = point(e);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext("2d");
    if (!last.current || !ctx) return;
    const next = point(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    last.current = next;
    setEmpty(false);
  }
  function up() {
    last.current = null;
  }
  function clear() {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setEmpty(true);
  }

  return (
    <div className="w-full space-y-2">
      <canvas
        ref={canvasRef}
        aria-label="Sign here"
        className="h-36 w-full touch-none rounded-md border border-line bg-white"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => canvasRef.current && onSave(canvasRef.current.toDataURL("image/png"))} disabled={empty || pending}>
          Save signature
        </Button>
        <Button size="sm" variant="secondary" onClick={clear} disabled={empty || pending}>
          <Eraser className="mr-1 h-3.5 w-3.5" />
          Clear
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
