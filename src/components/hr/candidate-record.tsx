"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  Copy,
  FileText,
  Link2,
  Mail,
  Phone,
  Trash2,
  Upload,
  UserCheck,
  X,
} from "lucide-react";
import type { CandidateStatus, EmployeeDocumentType, LetterType } from "@prisma/client";
import type { getCandidate } from "@/actions/candidate";
import {
  convertCandidate,
  draftCandidateLetter,
  issueIntakeLink,
  revokeIntakeLink,
  setCandidateStatus,
  uploadCandidateDocument,
} from "@/actions/candidate";
import { deleteEmployeeDocument } from "@/actions/employee-docs";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";
import { CANDIDATE_LETTERS, candidateStatusLabels, candidateStatusTone } from "@/lib/hr/onboarding";
import { letterTypeLabels } from "@/lib/hr/letters";
import { employmentTypeLabels } from "@/lib/validation/hr";

type Candidate = NonNullable<Awaited<ReturnType<typeof getCandidate>>>;

const DOC_TYPES: { value: EmployeeDocumentType; label: string }[] = [
  { value: "CV", label: "CV / résumé" },
  { value: "PHOTO", label: "Photograph" },
  { value: "PAN_CARD", label: "PAN card" },
  { value: "AADHAAR", label: "Aadhaar" },
  { value: "EDUCATION", label: "Education certificate" },
  { value: "EXPERIENCE_CERTIFICATE", label: "Experience certificate (previous employer)" },
  { value: "RELIEVING_LETTER", label: "Relieving letter (previous employer)" },
  { value: "PAYSLIP_PREVIOUS", label: "Previous payslip" },
  { value: "BANK_PROOF", label: "Bank proof" },
  { value: "INTERNAL", label: "Interview note (internal)" },
  { value: "OTHER", label: "Other" },
];

/** What the candidate sent us, labelled the way HR reads it rather than the way it is stored. */
const INTAKE_FIELDS: { key: string; label: string }[] = [
  { key: "personalEmail", label: "Personal email" },
  { key: "personalPhone", label: "Mobile" },
  { key: "dateOfBirth", label: "Date of birth" },
  { key: "bloodGroup", label: "Blood group" },
  { key: "maritalStatus", label: "Marital status" },
  { key: "addressLine1", label: "Address" },
  { key: "addressLine2", label: "Address line 2" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "pincode", label: "PIN code" },
  { key: "emergencyContactName", label: "Emergency contact" },
  { key: "emergencyContactPhone", label: "Their phone" },
  { key: "emergencyContactRelation", label: "Relationship" },
  { key: "panNumber", label: "PAN" },
  { key: "aadhaarLast4", label: "Aadhaar (last 4)" },
  { key: "uanNumber", label: "UAN" },
  { key: "bankName", label: "Bank" },
  { key: "bankAccountNumber", label: "Account number" },
  { key: "bankIfsc", label: "IFSC" },
];

export function CandidateRecord({ candidate, origin }: { candidate: Candidate; origin: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const intake = (candidate.intakeData ?? {}) as Record<string, string | undefined>;
  const joined = candidate.status === "JOINED";

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/people/hiring" className="text-sm text-muted hover:text-text">
          ← Hiring
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-text">{candidate.name}</h1>
          <Badge tone={candidateStatusTone[candidate.status]}>{candidateStatusLabels[candidate.status]}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          {candidate.designation ?? "Role not set"}
          {candidate.department && ` · ${candidate.department.name}`}
          {` · ${employmentTypeLabels[candidate.employmentType]}`}
          {candidate.source && ` · via ${candidate.source}`}
        </p>
      </div>

      {error && (
        <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>
      )}

      {joined && candidate.convertedUserId && (
        <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm text-muted">
            Joined on {candidate.convertedAt ? formatDate(candidate.convertedAt) : "—"}. Their documents and letters
            moved onto the employee record.
          </span>
          <Link
            href={`/people/${candidate.convertedUserId}`}
            className="text-sm font-medium text-brand hover:underline"
          >
            Open employee record →
          </Link>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="text-sm font-medium text-text">The offer</CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <Fact label="Offered CTC" value={candidate.offeredCtc ? formatCurrency(Number(candidate.offeredCtc)) : "—"} />
              <Fact label="Expected joining" value={candidate.expectedJoining ? formatDate(candidate.expectedJoining) : "—"} />
              <Fact label="Work location" value={candidate.workLocation ?? "—"} />
              <Fact label="Reports to" value={candidate.manager?.name ?? "—"} />
              <Fact label="Access role on joining" value={candidate.role} />
              <Fact label="Offer sent" value={candidate.offeredOn ? formatDate(candidate.offeredOn) : "—"} />
              <Fact label="Accepted" value={candidate.acceptedOn ? formatDate(candidate.acceptedOn) : "—"} />
              <Fact label="Owned by" value={candidate.owner?.name ?? "—"} />
              <Fact label="Added" value={formatDate(candidate.createdAt)} />
            </CardContent>
            {(candidate.notes || candidate.declinedReason) && (
              <CardContent className="border-t border-line pt-3 text-sm text-muted">
                {candidate.declinedReason && (
                  <p className="text-danger">Declined: {candidate.declinedReason}</p>
                )}
                {candidate.notes && <p className="whitespace-pre-wrap">{candidate.notes}</p>}
              </CardContent>
            )}
          </Card>

          <IntakePanel
            candidate={candidate}
            intake={intake}
            origin={origin}
            pending={pending}
            run={run}
          />

          <DocumentsPanel candidateId={candidate.id} documents={candidate.documents} pending={pending} run={run} />

          <LettersPanel candidate={candidate} pending={pending} run={run} />
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Contact</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <a
                href={`mailto:${candidate.email}`}
                className="flex items-center gap-2 text-muted hover:text-text"
              >
                <Mail className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{candidate.email}</span>
              </a>
              {candidate.phone && (
                <a href={`tel:${candidate.phone}`} className="flex items-center gap-2 text-muted hover:text-text">
                  <Phone className="h-3.5 w-3.5 shrink-0" />
                  {candidate.phone}
                </a>
              )}
            </CardContent>
          </Card>

          <StatusPanel candidate={candidate} pending={pending} run={run} />
          <ConvertPanel candidate={candidate} />
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-0.5 text-text">{value}</div>
    </div>
  );
}

// ─── Status ───────────────────────────────────────────────────────────────────

function StatusPanel({
  candidate,
  pending,
  run,
}: {
  candidate: Candidate;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  if (candidate.status === "JOINED") return null;

  const move = (status: CandidateStatus, why?: string) =>
    run(() => setCandidateStatus(candidate.id, status, why), () => setDeclining(false));

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Where they are</CardHeader>
      <CardContent className="space-y-2">
        {candidate.status === "PROSPECT" && (
          <Button className="w-full" disabled={pending} onClick={() => move("OFFERED")}>
            Mark offer sent
          </Button>
        )}
        {candidate.status === "OFFERED" && (
          <Button className="w-full" disabled={pending} onClick={() => move("ACCEPTED")}>
            <Check className="mr-1.5 h-3.5 w-3.5" />
            Offer accepted
          </Button>
        )}
        {candidate.status === "ACCEPTED" && (
          <p className="text-xs text-muted">
            They have said yes. Convert them below on their joining day — that is what creates the login.
          </p>
        )}

        {!declining ? (
          <Button variant="secondary" className="w-full" disabled={pending} onClick={() => setDeclining(true)}>
            <X className="mr-1.5 h-3.5 w-3.5" />
            They declined
          </Button>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="declineReason">Why? Worth recording.</Label>
            <Textarea
              id="declineReason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Counter-offer from current employer"
            />
            <div className="flex gap-2">
              <Button variant="danger" disabled={pending} onClick={() => move("DECLINED", reason)}>
                Record decline
              </Button>
              <Button variant="secondary" onClick={() => setDeclining(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {candidate.status !== "WITHDRAWN" && (
          <button
            type="button"
            disabled={pending}
            onClick={() => move("WITHDRAWN")}
            className="w-full text-xs text-subtle hover:text-text"
          >
            We withdrew the role
          </button>
        )}
      </CardContent>
    </Card>
  );
}

// ─── The intake link ──────────────────────────────────────────────────────────

function IntakePanel({
  candidate,
  intake,
  origin,
  pending,
  run,
}: {
  candidate: Candidate;
  intake: Record<string, string | undefined>;
  origin: string;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = candidate.intakeToken ? `${origin}/join/${candidate.intakeToken}` : null;
  const submitted = Boolean(candidate.intakeSubmittedAt);
  const filled = INTAKE_FIELDS.filter((f) => intake[f.key]);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Their details</span>
        {submitted ? (
          <Badge tone="green">Received {formatDate(candidate.intakeSubmittedAt!)}</Badge>
        ) : candidate.intakeToken ? (
          <Badge tone="amber">Link live</Badge>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-3">
        {!submitted && (
          <p className="text-xs text-muted">
            Send them a one-time link and they fill in their own address, PAN and bank details. What they send is held
            as a claim against this candidate — it does not touch any employee record until you convert them.
          </p>
        )}

        {url && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {/* Read-only, but still focusable and still read out — it is the link somebody copies. */}
              <Input
                aria-label="Interview link"
                readOnly
                value={url}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="secondary"
                onClick={() => {
                  navigator.clipboard.writeText(url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <p className="text-xs text-subtle">
              Valid until {candidate.intakeExpiresAt ? formatDate(candidate.intakeExpiresAt) : "—"}. Anyone holding
              this link can fill the form, so send it to them and nobody else.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={pending} onClick={() => run(() => issueIntakeLink(candidate.id))}>
            <Link2 className="mr-1.5 h-3.5 w-3.5" />
            {candidate.intakeToken ? "Issue a new link" : submitted ? "Ask again" : "Issue intake link"}
          </Button>
          {candidate.intakeToken && (
            <Button variant="secondary" disabled={pending} onClick={() => run(() => revokeIntakeLink(candidate.id))}>
              Revoke
            </Button>
          )}
        </div>

        {filled.length > 0 && (
          <div className="rounded-base border border-line">
            <div className="border-b border-line px-3 py-2 text-xs text-subtle">
              What they sent. Review it — it is applied to their record at conversion, exactly as typed.
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 px-3 py-3 text-sm sm:grid-cols-2">
              {filled.map((f) => (
                <div key={f.key} className="flex justify-between gap-3">
                  <dt className="text-muted">{f.label}</dt>
                  <dd className="text-right text-text">{intake[f.key]}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Documents ────────────────────────────────────────────────────────────────

function DocumentsPanel({
  candidateId,
  documents,
  pending,
  run,
}: {
  candidateId: string;
  documents: Candidate["documents"];
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<EmployeeDocumentType>("CV");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<{ dataUrl: string; mimeType: string } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0];
    if (!chosen) return;
    setLocalError(null);
    const reader = new FileReader();
    reader.onload = () => {
      setFile({ dataUrl: String(reader.result), mimeType: chosen.type });
      if (!name) setName(chosen.name);
    };
    reader.readAsDataURL(chosen);
  }

  function upload() {
    if (!file) {
      setLocalError("Choose a file first.");
      return;
    }
    run(
      () => uploadCandidateDocument({ candidateId, type, name, note, fileDataUrl: file.dataUrl, mimeType: file.mimeType }),
      () => {
        setOpen(false);
        setFile(null);
        setName("");
        setNote("");
        if (fileRef.current) fileRef.current.value = "";
      },
    );
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Documents</span>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          Upload
        </Button>
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <p className="text-sm text-subtle">
            Nothing filed yet. The CV you hired on belongs here — at conversion it moves onto their employee record
            rather than being copied, so the file reads as one history.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                <a
                  href={`/api/hr/documents/${d.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                  className="flex min-w-0 items-center gap-2 text-sm text-text hover:underline"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  <span className="truncate">{d.name}</span>
                </a>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-subtle">{Math.max(1, Math.round(d.sizeBytes / 1024))} KB</span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => deleteEmployeeDocument(d.id))}
                    className="text-subtle transition-colors hover:text-danger"
                    aria-label={`Delete ${d.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={open} onClose={() => setOpen(false)} title="File a document">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="docType">What is it</Label>
            <Select id="docType" value={type} onChange={(e) => setType(e.target.value as EmployeeDocumentType)}>
              {DOC_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="docName">Name</Label>
            <Input id="docName" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="docNote">Note</Label>
            <Input id="docNote" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="docFile">File</Label>
            <input
              id="docFile"
              ref={fileRef}
              type="file"
              onChange={pick}
              accept=".pdf,.doc,.docx,image/*"
              className="block w-full text-sm text-muted file:mr-3 file:rounded-base file:border-0 file:bg-surface-sunken file:px-3 file:py-1.5 file:text-sm file:text-text"
            />
            <p className="text-xs text-subtle">PDF, Word or an image, up to 4 MB.</p>
          </div>
          {localError && <p className="text-sm text-danger">{localError}</p>}
          <div className="flex gap-2">
            <Button disabled={pending} onClick={upload}>
              {pending ? "Uploading…" : "Upload"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

// ─── Letters ──────────────────────────────────────────────────────────────────

function LettersPanel({
  candidate,
  pending,
  run,
}: {
  candidate: Candidate;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => void;
}) {
  const router = useRouter();
  const noCtc = !candidate.offeredCtc;

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Letters</CardHeader>
      <CardContent className="space-y-3">
        {candidate.letters.length > 0 && (
          <ul className="divide-y divide-line">
            {candidate.letters.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-2">
                <Link href={`/people/letters/${l.id}`} className="min-w-0 text-sm text-text hover:underline">
                  <span className="block truncate">{l.subject}</span>
                  <span className="block text-xs text-subtle">
                    {l.letterNumber} · {formatDate(l.issuedOn)}
                  </span>
                </Link>
                <Badge tone={l.status === "ISSUED" ? "green" : l.status === "REVOKED" ? "red" : "default"}>
                  {l.status === "ISSUED" ? "Issued" : l.status === "REVOKED" ? "Revoked" : "Draft"}
                </Badge>
              </li>
            ))}
          </ul>
        )}

        {noCtc && (
          <p className="flex items-start gap-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Set the offered CTC before drafting — an offer letter that does not state the pay is not an offer.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {(CANDIDATE_LETTERS as LetterType[]).map((type) => (
            <Button
              key={type}
              variant="secondary"
              disabled={pending || noCtc}
              onClick={() =>
                run(async () => {
                  const result = await draftCandidateLetter(candidate.id, type);
                  if (result.ok) router.push(`/people/letters/${result.data.id}`);
                  return result;
                })
              }
            >
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              Draft {letterTypeLabels[type].toLowerCase()}
            </Button>
          ))}
        </div>
        <p className="text-xs text-subtle">
          Drafted against the candidate, not a login — the letter moves onto their employee record when they join.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Conversion ───────────────────────────────────────────────────────────────

function ConvertPanel({ candidate }: { candidate: Candidate }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [joinedOn, setJoinedOn] = useState(
    candidate.expectedJoining ? String(candidate.expectedJoining).slice(0, 10) : new Date().toISOString().slice(0, 10),
  );
  const [employeeCode, setEmployeeCode] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [probationMonths, setProbationMonths] = useState("6");

  if (candidate.status === "JOINED") return null;

  const ready = candidate.status === "ACCEPTED";

  function convert() {
    setError(null);
    startTransition(async () => {
      const result = await convertCandidate(candidate.id, {
        joinedOn,
        employeeCode: employeeCode.trim() || undefined,
        temporaryPassword,
        probationMonths: Number(probationMonths) || 6,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.push(`/people/${result.data.userId}`);
    });
  }

  return (
    <>
      <Card>
        <CardHeader className="text-sm font-medium text-text">Joining</CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted">
            Converting creates their login and employee record, moves their documents and letters across, and raises
            the onboarding tasks for IT, HR and their manager.
          </p>
          {!candidate.intakeSubmittedAt && (
            <p className="flex items-start gap-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Their intake form has not come back. You can still convert them — the record will just have gaps you
              will have to fill by hand.
            </p>
          )}
          <Button className="w-full" disabled={!ready} onClick={() => setOpen(true)}>
            <UserCheck className="mr-1.5 h-3.5 w-3.5" />
            Convert to employee
          </Button>
          {!ready && (
            <p className="text-xs text-subtle">
              Available once the offer is marked accepted — only somebody who has said yes should get an account.
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)} title={`Convert ${candidate.name}`}>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            This creates a login for <span className="text-text">{candidate.email}</span> with the{" "}
            <span className="text-text">{candidate.role}</span> role. It happens once, and it cannot be undone from
            here.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="joinedOn">Joining date</Label>
              <Input id="joinedOn" type="date" value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} />
              <p className="text-xs text-subtle">Probation, leave accrual and gratuity all measure from here.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="employeeCode">Employee code</Label>
              <Input id="employeeCode" value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="probation">Probation (months)</Label>
              <Input
                id="probation"
                type="number"
                value={probationMonths}
                onChange={(e) => setProbationMonths(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tempPassword">Temporary password</Label>
              <Input
                id="tempPassword"
                value={temporaryPassword}
                onChange={(e) => setTemporaryPassword(e.target.value)}
                autoComplete="off"
              />
              {/* Said plainly, because the alternative is HR inventing a password and never telling
                  them to change it. */}
              <p className="text-xs text-subtle">
                They must change it at first sign-in. Send it to them separately, not in the same message as the link.
              </p>
            </div>
          </div>

          <p className="text-xs text-muted">
            Set their salary structure straight afterwards — payroll skips anybody who has none, silently.
          </p>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button disabled={pending || temporaryPassword.length < 8 || !joinedOn} onClick={convert}>
              {pending ? "Converting…" : "Create their record"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
