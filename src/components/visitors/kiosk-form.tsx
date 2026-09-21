"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Camera, Check, ChevronLeft, Plus, Trash2, UserRound } from "lucide-react";
import type { VisitorPurpose } from "@prisma/client";
import { checkIn, checkInWithInvite, lookupInvite, searchVisitorCompanies } from "@/actions/visitor-public";
import { emailRequiredFor, isUsableCompany, looksLikeEmail } from "@/lib/visitors/company-name";

type Directory = {
  kioskName: string;
  departments: { id: string; name: string }[];
  people: { id: string; name: string; departmentId: string | null }[];
};

/**
 * The reception tablet.
 *
 * Built as one step at a time rather than a page of fields. Somebody standing at a desk with a bag
 * in one hand will not read a form — they will read one question. Everything is a large tap target
 * for the same reason, and the keyboard only appears for the three things that genuinely have to
 * be typed.
 *
 * It resets itself after a check-in. A kiosk still showing the last visitor's phone number to the
 * next person in the queue is the most obvious way this feature could leak something.
 */
type Step = "purpose" | "code" | "expected" | "who" | "details" | "photo" | "companions" | "done";

export function KioskForm({ token, directory }: { token: string; directory: Directory }) {
  const [step, setStep] = useState<Step>("purpose");
  const [purpose, setPurpose] = useState<VisitorPurpose>("MEETING");
  const [departmentId, setDepartmentId] = useState("");
  const [hostUserId, setHostUserId] = useState("");
  const [f, setF] = useState({ name: "", phone: "", company: "", email: "", note: "" });
  const [photo, setPhoto] = useState<string | null>(null);
  /** Set only when getUserMedia actually failed — never by anything the visitor can press. */
  const [cameraOut, setCameraOut] = useState(false);
  const [companions, setCompanions] = useState<string[]>([]);
  const [result, setResult] = useState<{ badgeNo: number; hostName: string | null } | null>(null);
  const [code, setCode] = useState("");
  const [expected, setExpected] = useState<{ name: string; hostName: string; expectedCompanions: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = (k: keyof typeof f, v: string) => setF((prev) => ({ ...prev, [k]: v }));

  function reset() {
    setStep("purpose");
    setPurpose("MEETING");
    setDepartmentId("");
    setHostUserId("");
    setF({ name: "", phone: "", company: "", email: "", note: "" });
    setPhoto(null);
    setCameraOut(false);
    setCompanions([]);
    setResult(null);
    setError(null);
    setCode("");
    setExpected(null);
  }

  /**
   * Register the service worker, which is what makes the tablet installable.
   *
   * Scoped to /kiosk/ by the header the route sets, so it can never intercept anything in the
   * signed-in app. Failure is ignored: the form works perfectly well in a browser tab, and a
   * reception desk should not see an error because an install hint did not take.
   */
  useEffect(() => {
    navigator.serviceWorker?.register("/kiosk/sw", { scope: "/kiosk/" }).catch(() => {});
  }, []);

  // Back to a blank form on its own, so the tablet is never left showing somebody's details.
  useEffect(() => {
    if (step !== "done") return;
    const timer = setTimeout(reset, 20_000);
    return () => clearTimeout(timer);
  }, [step]);

  const people = departmentId ? directory.people.filter((p) => p.departmentId === departmentId) : [];

  function verifyCode() {
    setError(null);
    startTransition(async () => {
      const found = await lookupInvite(token, code);
      if (!found.ok) {
        setError(found.error);
        return;
      }
      setExpected({ name: found.name, hostName: found.hostName, expectedCompanions: found.expectedCompanions });
      // Pre-seeded so the companion step opens with the right number of boxes rather than making
      // a party of four add themselves one at a time.
      setCompanions(Array.from({ length: found.expectedCompanions }, () => ""));
      setStep("expected");
    });
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      // Pre-registered visitors go through the invite action, which re-checks the code rather than
      // trusting the screen that found it — the lookup and this are two separate requests from a
      // device in a lobby, and only one of them writes.
      const outcome = expected
        ? await checkInWithInvite({
            token,
            code,
            photoDataUrl: photo ?? undefined,
            photoUnavailable: cameraOut,
            companions: companions.filter(Boolean).map((name) => ({ name })),
          })
        : await checkIn({
        token,
        purpose,
        hostUserId: hostUserId || undefined,
        departmentId: departmentId || undefined,
        name: f.name,
        phone: f.phone,
        company: f.company,
        email: f.email,
        note: f.note,
        photoDataUrl: photo ?? undefined,
        photoUnavailable: cameraOut,
        companions: companions.filter(Boolean).map((name) => ({ name })),
      });
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      setResult({ badgeNo: outcome.badgeNo, hostName: outcome.hostName });
      setStep("done");
    });
  }

  if (step === "done" && result) {
    return (
      <Shell title="">
        <div className="space-y-5 py-10 text-center">
          <Check className="mx-auto h-16 w-16 text-success" />
          <div>
            <p className="text-2xl font-semibold text-text">Thank you, {(expected?.name ?? f.name).split(" ")[0]}</p>
            <p className="mt-2 text-lg text-muted">
              {result.hostName ? `${result.hostName} has been told you're here.` : "The team has been told you're here."}
            </p>
          </div>
          <div className="mx-auto w-fit rounded-xl border-2 border-brand px-8 py-4">
            <p className="text-xs uppercase tracking-wide text-subtle">Visitor</p>
            <p className="text-4xl font-bold text-brand">#{result.badgeNo}</p>
          </div>
          <p className="text-sm text-subtle">Please take a seat. This screen will reset shortly.</p>
          <Tap onClick={reset} variant="ghost">
            Sign somebody else in
          </Tap>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={directory.kioskName} onBack={step === "purpose" ? undefined : () => setStep(previous(step, expected !== null))}>
      {step === "purpose" && (
        <Question title="Welcome. What brings you in?">
          {/* First, because somebody who was invited has the fastest route through and should not
              have to read past four options they do not need. */}
          <Tap onClick={() => setStep("code")} variant="primary">
            <span className="block text-lg font-medium">I have an invite code</span>
            <span className="mt-1 block text-sm font-normal opacity-75">Sent to you by the person you&apos;re seeing</span>
          </Tap>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {([
              ["MEETING", "A meeting", "I have an appointment or I'm here to see someone"],
              ["INTERVIEW", "An interview", "I've been invited for an interview"],
              ["DELIVERY", "A delivery", "I'm dropping something off"],
              ["VENDOR", "Vendor or service", "I'm here to do a job on site"],
            ] as const).map(([value, label, hint]) => (
              <Tap
                key={value}
                onClick={() => {
                  setPurpose(value);
                  setStep("who");
                }}
                variant={purpose === value ? "primary" : "outline"}
              >
                <span className="block text-lg font-medium">{label}</span>
                <span className="mt-1 block text-sm font-normal opacity-75">{hint}</span>
              </Tap>
            ))}
          </div>
        </Question>
      )}


      {step === "code" && (
        <Question title="Your invite code" hint="Eight characters, from the message you were sent.">
          {/* The step heading carries the wording on screen, but a heading is not a label — so the
              field is named directly rather than paired with one. */}
          <input
            value={code}
            autoFocus
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && verifyCode()}
            placeholder="ABCD2345"
            aria-label="Invite code"
            className="h-20 w-full rounded-xl border-2 border-line bg-surface text-center font-mono text-3xl tracking-[0.3em] text-text focus-visible:border-brand"
          />
          {error && <p className="text-center text-danger">{error}</p>}
          <Tap onClick={verifyCode} variant="primary" disabled={pending || code.trim().length < 8}>
            {pending ? "Checking…" : "Continue"}
          </Tap>
          <Tap onClick={() => { setError(null); setStep("purpose"); }} variant="ghost">
            I don&apos;t have a code
          </Tap>
        </Question>
      )}

      {step === "expected" && expected && (
        <Question title={`Welcome, ${expected.name.split(" ")[0]}`}>
          <div className="rounded-xl bg-surface-sunken p-5 text-center">
            <p className="text-lg text-text">{expected.name}</p>
            <p className="mt-1 text-muted">Here to see {expected.hostName}</p>
          </div>
          {/* Everything else was filled in when they were invited — the only things left are the
              two that can only happen at the desk. */}
          <Tap onClick={() => setStep("photo")} variant="primary">
            That&apos;s me — continue
          </Tap>
          <Tap onClick={() => { setExpected(null); setCode(""); setStep("purpose"); }} variant="ghost">
            That&apos;s not me
          </Tap>
        </Question>
      )}

      {step === "who" && (
        <Question
          title={purpose === "INTERVIEW" ? "Who are you here to see?" : "Who are you meeting?"}
          hint={departmentId ? "Now pick the person, or continue for anyone in the team." : "Choose the team first."}
        >
          {!departmentId ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {directory.departments.map((d) => (
                <Tap key={d.id} onClick={() => setDepartmentId(d.id)} variant="outline">
                  {d.name}
                </Tap>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {people.map((p) => (
                  <Tap
                    key={p.id}
                    onClick={() => {
                      setHostUserId(p.id);
                      setStep("details");
                    }}
                    variant={hostUserId === p.id ? "primary" : "outline"}
                  >
                    <UserRound className="mx-auto mb-1 h-5 w-5 opacity-60" />
                    {p.name}
                  </Tap>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Tap onClick={() => setDepartmentId("")} variant="ghost">
                  Different team
                </Tap>
                {/* A visitor who does not know the name should not be stuck. The department routes it. */}
                <Tap onClick={() => { setHostUserId(""); setStep("details"); }} variant="ghost">
                  I don&apos;t know the name
                </Tap>
              </div>
            </div>
          )}
        </Question>
      )}

      {step === "details" && (
        <Question title="And you are?">
          <div className="space-y-3">
            <Field label="Your name" value={f.name} onChange={(v) => set("name", v)} autoFocus />
            <Field label="Phone number" value={f.phone} onChange={(v) => set("phone", v)} type="tel" />
            <CompanyField token={token} value={f.company} onChange={(v) => set("company", v)} />
            <Field
              label={emailRequiredFor(purpose) ? "Email" : "Email (optional)"}
              value={f.email}
              onChange={(v) => set("email", v)}
              type="email"
            />
            <Field label="What's it about? (optional)" value={f.note} onChange={(v) => set("note", v)} />
          </div>
          <Tap
            onClick={() => setStep("photo")}
            variant="primary"
            disabled={
              f.name.trim().length < 2 ||
              f.phone.replace(/\D/g, "").length < 7 ||
              !isUsableCompany(f.company) ||
              // A courier need not give one, but a bad one is still a bad one.
              (emailRequiredFor(purpose) ? !looksLikeEmail(f.email) : f.email.trim() !== "" && !looksLikeEmail(f.email))
            }
          >
            Continue
          </Tap>
        </Question>
      )}

      {step === "photo" && (
        <Question
          title="A quick photo"
          hint="It goes on the visitor record so the person you're meeting knows who to look for."
        >
          <PhotoStep photo={photo} onCapture={setPhoto} onUnavailable={() => setCameraOut(true)} />
          <div className="flex flex-wrap gap-2">
            {/* No skip. The only way past without a picture is a camera that genuinely is not
                there, which PhotoStep reports and the entry records. */}
            <Tap onClick={() => setStep("companions")} variant="primary" disabled={!photo && !cameraOut}>
              {cameraOut && !photo ? "Continue without a photo" : "Continue"}
            </Tap>
          </div>
        </Question>
      )}

      {step === "companions" && (
        <Question title="Anyone with you?" hint="Add their names so they're on the record too.">
          <div className="space-y-2">
            {companions.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                {/* The name carries the row number, so several empty companion rows are told apart
                    when read out. The visitor is person 1, hence the offset the placeholder uses. */}
                <input
                  value={c}
                  onChange={(e) => setCompanions((prev) => prev.map((x, j) => (i === j ? e.target.value : x)))}
                  placeholder={`Person ${i + 2}`}
                  aria-label={`Person ${i + 2} name`}
                  className="h-14 flex-1 rounded-xl border border-line bg-surface px-4 text-lg text-text focus-visible:border-brand"
                />
                <button
                  onClick={() => setCompanions((prev) => prev.filter((_, j) => j !== i))}
                  className="rounded-xl border border-line p-4 text-danger"
                  aria-label="Remove"
                >
                  <Trash2 className="h-5 w-5" />
                </button>
              </div>
            ))}
            <Tap onClick={() => setCompanions((prev) => [...prev, ""])} variant="outline">
              <Plus className="mr-2 inline h-5 w-5" />
              {companions.length === 0 ? "Someone is with me" : "Add another"}
            </Tap>
          </div>

          {error && <p className="text-center text-danger">{error}</p>}

          <Tap onClick={submit} variant="primary" disabled={pending}>
            {pending ? "Signing you in…" : companions.length > 0 ? `Sign in — ${companions.length + 1} people` : "Sign me in"}
          </Tap>
        </Question>
      )}
    </Shell>
  );
}

/**
 * Where Back goes.
 *
 * Two routes through the form, and they diverge after the welcome screen: an invited visitor goes
 * purpose → code → expected → photo → companions, a walk-in goes purpose → who → details → photo →
 * companions. A single shared order would send somebody who arrived on a code back to the details
 * screen they never filled in, which is empty and refuses to continue.
 */
function previous(step: Step, invited: boolean): Step {
  const order: Step[] = invited
    ? ["purpose", "code", "expected", "photo", "companions"]
    : ["purpose", "who", "details", "photo", "companions"];
  const i = order.indexOf(step);
  return order[Math.max(0, i - 1)]!;
}

/**
 * The camera step.
 *
 * The stream is stopped the moment a picture is taken or the step is left. A reception tablet with
 * a live camera nobody switched off is a camera pointed at a lobby all day.
 */
function PhotoStep({
  photo,
  onCapture,
  onUnavailable,
}: {
  photo: string | null;
  onCapture: (v: string | null) => void;
  onUnavailable: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (photo) return;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "user", width: 640, height: 480 } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => {
        // Reported upward as well as shown, because the server refuses a photoless sign-in
        // unless it is told the camera was the problem.
        setFailed(true);
        onUnavailable();
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // onUnavailable is stable for the life of the form, so it is not a dependency worth churning
    // the camera stream over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo]);

  if (failed) {
    return (
      <p className="rounded-xl bg-surface-sunken p-6 text-center text-muted">
        No camera on this tablet, or it isn&apos;t allowed. You can carry on — the record will say the
        photo couldn&apos;t be taken. Please mention it at the desk.
      </p>
    );
  }

  if (photo) {
    return (
      <div className="space-y-3 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo} alt="" className="mx-auto h-64 w-auto rounded-xl object-cover" />
        <Tap onClick={() => onCapture(null)} variant="ghost">
          Take it again
        </Tap>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-center">
      <video ref={videoRef} autoPlay playsInline muted className="mx-auto h-64 w-auto rounded-xl bg-black object-cover" />
      <Tap
        variant="outline"
        onClick={() => {
          const video = videoRef.current;
          if (!video) return;
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext("2d")?.drawImage(video, 0, 0);
          // JPEG at 0.7 — a lanyard photo, not a portrait, and it has to fit the upload ceiling.
          onCapture(canvas.toDataURL("image/jpeg", 0.7));
          streamRef.current?.getTracks().forEach((t) => t.stop());
        }}
      >
        <Camera className="mr-2 inline h-5 w-5" />
        Take the photo
      </Tap>
    </div>
  );
}

// ── Kiosk-sized building blocks ─────────────────────────────────────────────────────────────────

function Shell({ title, onBack, children }: { title: string; onBack?: () => void; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6 py-8">
      <div className="flex min-h-10 items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="rounded-xl border border-line p-2 text-muted" aria-label="Back">
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {title && <span className="text-sm text-subtle">{title}</span>}
      </div>
      <div className="flex flex-1 flex-col justify-center">{children}</div>
    </div>
  );
}

function Question({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-text">{title}</h1>
        {hint && <p className="mt-2 text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Tap({
  children,
  onClick,
  variant = "outline",
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "primary" | "outline" | "ghost";
  disabled?: boolean;
}) {
  const styles = {
    primary: "bg-brand text-white",
    outline: "border-2 border-line bg-surface text-text active:border-brand",
    ghost: "text-muted",
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-xl px-6 py-5 text-center text-lg transition disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-muted">{label}</span>
      <input
        type={type}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        className="h-14 w-full rounded-xl border border-line bg-surface px-4 text-lg text-text focus-visible:border-brand"
      />
    </label>
  );
}

/**
 * The company field: type a couple of letters, pick the existing row if there is one.
 *
 * The search only ever returns names from the visitor-company list — vendors somebody brought
 * across and firms previous visitors have typed. It cannot reach the CRM's own company table, so a
 * tablet in a lobby is not a way to read the customer book.
 *
 * Choosing a suggestion and typing a new name both work. A name nobody has used before is created
 * on the server when the visit is saved, which is how the list grows.
 */
function CompanyField({
  token,
  value,
  onChange,
}: {
  token: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [matches, setMatches] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function search(next: string) {
    onChange(next);
    setOpen(true);
    // Debounced: a kiosk on office wifi does not need a request per keystroke, and the desk's rate
    // limiter is not something a visitor should be able to trip by typing quickly.
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setMatches(next.trim().length >= 2 ? await searchVisitorCompanies(token, next) : []);
    }, 250);
  }

  return (
    <div className="relative">
      <label className="block">
        <span className="mb-1 block text-sm text-muted">Company</span>
        <input
          value={value}
          onChange={(e) => search(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Start typing…"
          className="h-14 w-full rounded-xl border border-line bg-surface px-4 text-lg text-text focus-visible:border-brand"
        />
      </label>

      {open && matches.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
          {matches.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(m.name);
                  setMatches([]);
                  setOpen(false);
                }}
                className="w-full px-4 py-3 text-left text-base text-text active:bg-surface-sunken"
              >
                {m.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {value.trim().length >= 2 && matches.length === 0 && open && (
        <p className="mt-1 text-xs text-subtle">Not on the list — it&apos;ll be added.</p>
      )}
    </div>
  );
}
