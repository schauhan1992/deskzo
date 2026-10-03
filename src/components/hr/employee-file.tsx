"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BadgeCheck, Building2, FileText, Plus, Trash2, Upload } from "lucide-react";
import type { EmployeeDocumentType, LetterType } from "@prisma/client";
import type { listEmployeeDocuments, listEmployeeLetters, listEmploymentHistory } from "@/actions/employee-docs";
import {
  deleteEmploymentHistory,
  deleteEmployeeDocument,
  draftLetter,
  saveEmploymentHistory,
  uploadEmployeeDocument,
  verifyEmploymentHistory,
} from "@/actions/employee-docs";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { formatCurrency } from "@/lib/utils";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";
import { letterGroups, letterTypeLabels } from "@/lib/hr/letters";

type Doc = Awaited<ReturnType<typeof listEmployeeDocuments>>[number];
type History = Awaited<ReturnType<typeof listEmploymentHistory>>[number];
type Letter = Awaited<ReturnType<typeof listEmployeeLetters>>[number];

const DOC_TYPES: { value: EmployeeDocumentType; label: string }[] = [
  { value: "CV", label: "CV / résumé" },
  { value: "PHOTO", label: "Photograph" },
  { value: "PAN_CARD", label: "PAN card" },
  { value: "AADHAAR", label: "Aadhaar" },
  { value: "EDUCATION", label: "Education certificate" },
  { value: "EXPERIENCE_CERTIFICATE", label: "Experience certificate" },
  { value: "RELIEVING_LETTER", label: "Relieving letter (previous employer)" },
  { value: "PAYSLIP_PREVIOUS", label: "Previous payslip" },
  { value: "BANK_PROOF", label: "Bank proof" },
  { value: "OFFER_LETTER", label: "Offer letter" },
  { value: "APPOINTMENT_LETTER", label: "Appointment letter" },
  { value: "CONTRACT", label: "Contract" },
  { value: "INTERNAL", label: "Internal note (not shown to the employee)" },
  { value: "OTHER", label: "Other" },
];

const DOC_LABEL = Object.fromEntries(DOC_TYPES.map((t) => [t.value, t.label])) as Record<EmployeeDocumentType, string>;

/**
 * The personnel file: documents, previous employment, and letters the company has issued.
 *
 * All three are HR's to write and the employee's to read, with one exception marked throughout —
 * an internal document is filed *about* somebody rather than *for* them, and never appears on their
 * own view of their file.
 */
export function EmployeeFile({
  userId,
  userName,
  documents,
  history,
  letters,
  canManage,
  letterOptions,
}: {
  userId: string;
  userName: string;
  documents: Doc[];
  history: History[];
  letters: Letter[];
  canManage: boolean;
  letterOptions: { type: LetterType; reason?: string }[];
}) {
  return (
    <div className="space-y-5">
      <DocumentsCard userId={userId} documents={documents} canManage={canManage} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <HistoryCard userId={userId} history={history} canManage={canManage} />
        <LettersCard userId={userId} userName={userName} letters={letters} canManage={canManage} options={letterOptions} />
      </div>
    </div>
  );
}

// ─── Documents ────────────────────────────────────────────────────────────────

function DocumentsCard({ userId, documents, canManage }: { userId: string; documents: Doc[]; canManage: boolean }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>
          Documents
          {documents.length > 0 && <span className="ml-1.5 text-xs font-normal text-subtle">{documents.length}</span>}
        </span>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          Upload
        </Button>
      </CardHeader>

      <CardContent className="space-y-2">
        {documents.length === 0 && (
          <p className="text-sm text-subtle">Nothing on file yet — CV, ID proofs, certificates go here.</p>
        )}
        {documents.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 last:border-0 last:pb-0">
            <span className="flex min-w-0 items-center gap-2">
              <FileText className="h-3.5 w-3.5 shrink-0 text-subtle" />
              <span className="min-w-0">
                {d.letterId ? (
                  <Link href={`/letters/${d.letterId}/print`} target="_blank" className="block truncate text-sm text-brand hover:underline">
                    {d.name}
                  </Link>
                ) : (
                  <Link href={`/api/hr/documents/${d.id}`} target="_blank" className="block truncate text-sm text-brand hover:underline">
                    {d.name}
                  </Link>
                )}
                <span className="block text-[11px] text-subtle">
                  {DOC_LABEL[d.type]}
                  {d.sizeBytes > 0 && ` · ${(d.sizeBytes / 1024).toFixed(0)} KB`}
                  {` · ${clock.date(d.createdAt)}`}
                  {d.uploadedBy && ` · ${d.uploadedBy.name}`}
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {!d.visibleToEmployee && <Badge tone="amber">Internal</Badge>}
              {canManage && !d.letterId && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    // A personnel document is somebody's contract or ID proof, deleted for good.
                    if (!window.confirm(`Remove "${d.name}" permanently? This cannot be undone.`)) return;
                    startTransition(async () => {
                      const result = await deleteEmployeeDocument(d.id);
                      if (result && !result.ok) {
                        window.alert(result.error);
                        return;
                      }
                      router.refresh();
                    });
                  }}
                  className="text-subtle hover:text-danger"
                  aria-label={`Remove ${d.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          </div>
        ))}
      </CardContent>

      {open && <UploadDialog userId={userId} canManage={canManage} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function UploadDialog({ userId, canManage, onClose }: { userId: string; canManage: boolean; onClose: () => void }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<EmployeeDocumentType>("CV");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [visible, setVisible] = useState(true);
  const [file, setFile] = useState<{ dataUrl: string; mimeType: string; sizeKb: number } | null>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      setFile({ dataUrl: String(reader.result), mimeType: picked.type, sizeKb: Math.round(picked.size / 1024) });
      if (!name) setName(picked.name);
    };
    reader.readAsDataURL(picked);
  }

  function submit() {
    if (!file) return;
    setError(null);
    startTransition(async () => {
      const result = await uploadEmployeeDocument({
        userId,
        type,
        name,
        note,
        fileDataUrl: file.dataUrl,
        mimeType: file.mimeType,
        visibleToEmployee: visible,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onClose={onClose} title="Add a document">
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="docType">What is it?</Label>
          <Select id="docType" value={type} onChange={(e) => setType(e.target.value as EmployeeDocumentType)}>
            {DOC_TYPES.filter((t) => canManage || t.value !== "INTERNAL").map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="docFile">File</Label>
          <input
            ref={fileRef}
            id="docFile"
            type="file"
            accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp"
            onChange={onPick}
            className="w-full rounded-base border border-line-strong bg-surface px-3 py-2 text-sm text-text file:mr-3 file:rounded file:border-0 file:bg-surface-sunken file:px-2 file:py-1 file:text-xs file:text-text"
          />
          <p className="text-xs text-subtle">PDF, Word or an image, up to 4 MB.{file && ` Selected: ${file.sizeKb} KB.`}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="docName">Name</Label>
          <Input id="docName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Degree certificate" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="docNote">Note</Label>
          <Input id="docNote" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </div>

        {canManage && (
          <label className="flex items-start gap-2 rounded-base border border-line px-3 py-2">
            <Checkbox checked={visible} onChange={() => setVisible((v) => !v)} aria-label="Visible to the employee" />
            <span className="text-sm">
              <span className="block text-text">The employee can see this</span>
              <span className="block text-xs text-muted">
                Untick for something filed about them rather than for them — an interview note, a warning.
              </span>
            </span>
          </label>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={pending || !file || !name.trim()} onClick={submit}>
            {pending ? "Uploading…" : "Add to file"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Previous employment ──────────────────────────────────────────────────────

function HistoryCard({ userId, history, canManage }: { userId: string; history: History[]; canManage: boolean }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const totalYears = history.reduce((a, h) => {
    if (!h.fromDate || !h.toDate) return a;
    return a + (new Date(h.toDate).getTime() - new Date(h.fromDate).getTime()) / (365.25 * 86400000);
  }, 0);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>
          Previous employment
          {totalYears > 0 && <span className="ml-1.5 text-xs font-normal text-subtle">{totalYears.toFixed(1)} yrs</span>}
        </span>
        {canManage && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {history.length === 0 && <p className="text-sm text-subtle">Nothing recorded.</p>}
        {history.map((h) => (
          <div key={h.id} className="border-b border-line pb-3 last:border-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  <span className="font-medium text-text">{h.companyName}</span>
                  {h.verifiedAt ? (
                    <Badge tone="green">
                      <BadgeCheck className="mr-1 h-3 w-3" />
                      Verified
                    </Badge>
                  ) : (
                    <Badge tone="amber">As stated</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-muted">
                  {[h.designation, h.location].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-0.5 text-xs text-subtle">
                  {h.fromDate ? formatCalendarDay(h.fromDate) : "?"} – {h.toDate ? formatCalendarDay(h.toDate) : "?"}
                  {h.lastDrawnCtc && ` · last drawn ${formatCurrency(Number(h.lastDrawnCtc))}`}
                </p>
                {h.reasonForLeaving && <p className="mt-1 text-sm text-muted">Left: {h.reasonForLeaving}</p>}
                {canManage && h.referenceName && (
                  <p className="mt-0.5 text-xs text-subtle">
                    Reference: {h.referenceName}
                    {h.referenceContact && ` · ${h.referenceContact}`}
                  </p>
                )}
                {h.verifiedAt && h.verifiedBy && (
                  <p className="mt-0.5 text-[11px] text-subtle">
                    Checked by {h.verifiedBy.name} on {clock.date(h.verifiedAt)}
                  </p>
                )}
              </div>
              {canManage && (
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await verifyEmploymentHistory(h.id, !h.verifiedAt);
                        router.refresh();
                      })
                    }
                    className="text-xs text-brand hover:underline"
                  >
                    {h.verifiedAt ? "Unverify" : "Mark verified"}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await deleteEmploymentHistory(h.id);
                        router.refresh();
                      })
                    }
                    className="text-subtle hover:text-danger"
                    aria-label="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </CardContent>

      {open && <HistoryDialog userId={userId} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function HistoryDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    companyName: "",
    designation: "",
    location: "",
    fromDate: "",
    toDate: "",
    lastDrawnCtc: "",
    reasonForLeaving: "",
    referenceName: "",
    referenceContact: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveEmploymentHistory({
        userId,
        ...form,
        lastDrawnCtc: form.lastDrawnCtc ? Number(form.lastDrawnCtc) : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onClose={onClose} title="Add previous employment">
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="prevCompany">Company</Label>
            <Input id="prevCompany" value={form.companyName} onChange={set("companyName")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prevDesignation">Designation</Label>
            <Input id="prevDesignation" value={form.designation} onChange={set("designation")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prevLocation">Location</Label>
            <Input id="prevLocation" value={form.location} onChange={set("location")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prevFrom">From</Label>
            <Input id="prevFrom" type="date" value={form.fromDate} onChange={set("fromDate")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prevTo">To</Label>
            <Input id="prevTo" type="date" value={form.toDate} onChange={set("toDate")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prevCtc">Last drawn CTC (annual)</Label>
            <Input id="prevCtc" type="number" value={form.lastDrawnCtc} onChange={set("lastDrawnCtc")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prevReason">Reason for leaving</Label>
            <Input id="prevReason" value={form.reasonForLeaving} onChange={set("reasonForLeaving")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refName">Reference name</Label>
            <Input id="refName" value={form.referenceName} onChange={set("referenceName")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refContact">Reference contact</Label>
            <Input id="refContact" value={form.referenceContact} onChange={set("referenceContact")} />
          </div>
        </div>

        <p className="text-xs text-subtle">
          Recorded as stated by the candidate. Mark it verified only once somebody has actually checked.
        </p>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={pending || !form.companyName.trim()} onClick={submit}>
            {pending ? "Saving…" : "Add"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Letters ──────────────────────────────────────────────────────────────────

function LettersCard({
  userId,
  userName,
  letters,
  canManage,
  options,
}: {
  userId: string;
  userName: string;
  letters: Letter[];
  canManage: boolean;
  options: { type: LetterType; reason?: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<LetterType>("OFFER");

  const blocked = options.find((o) => o.type === type)?.reason;

  function create() {
    setError(null);
    startTransition(async () => {
      const result = await draftLetter(userId, type);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/people/letters/${result.data.id}`);
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Letters</CardHeader>
      <CardContent className="space-y-3">
        {canManage && (
          <div className="space-y-2 rounded-base border border-line bg-surface-sunken p-2.5">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor="letterType" className="text-xs">
                  Generate for {userName}
                </Label>
                {/* Grouped by lifecycle stage — twenty-three in one flat list is not a menu. An
                    option that does not apply stays visible but says why when picked, rather than
                    vanishing and leaving somebody hunting for it. */}
                <Select id="letterType" value={type} onChange={(e) => setType(e.target.value as LetterType)} className="h-9 text-sm">
                  {letterGroups.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.types.map((t) => {
                        const reason = options.find((o) => o.type === t)?.reason;
                        return (
                          <option key={t} value={t}>
                            {letterTypeLabels[t]}
                            {reason ? " — n/a" : ""}
                          </option>
                        );
                      })}
                    </optgroup>
                  ))}
                </Select>
              </div>
              <Button size="sm" disabled={pending || !!blocked} onClick={create}>
                {pending ? "Drafting…" : "Draft"}
              </Button>
            </div>
            {blocked && <p className="text-xs text-warning">{blocked}</p>}
            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
        )}

        {letters.length === 0 && <p className="text-sm text-subtle">No letters issued.</p>}
        {letters.map((l) => (
          <div key={l.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-line pb-2 last:border-0 last:pb-0">
            <div className="min-w-0">
              <Link
                href={l.status === "DRAFT" ? `/people/letters/${l.id}` : `/letters/${l.id}/print`}
                target={l.status === "DRAFT" ? undefined : "_blank"}
                className="block truncate text-sm text-brand hover:underline"
              >
                {l.subject}
              </Link>
              <span className="block font-mono text-[11px] text-subtle">
                {l.letterNumber} · {formatCalendarDay(l.issuedOn)}
                {l.issuedBy && ` · ${l.issuedBy.name}`}
              </span>
            </div>
            <Badge tone={l.status === "ISSUED" ? "green" : l.status === "REVOKED" ? "red" : "amber"}>{l.status}</Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
