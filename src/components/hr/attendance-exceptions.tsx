"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  decideAttendanceException,
  grantAttendanceException,
  revokeAttendanceException,
  type ExceptionState,
  type ExceptionView,
} from "@/actions/attendance-exceptions";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";
import { useClock } from "@/components/time/clock-provider";
import { EXCEPTION_REASON_LABELS, EXCEPTION_SCOPE_LABELS, PROBLEM_SHORT } from "@/lib/hr/geofence";

const STATE: Record<ExceptionState, { label: string; tone: "default" | "green" | "blue" | "red" | "amber" | "brand" }> = {
  PENDING: { label: "Awaiting decision", tone: "amber" },
  LAPSED: { label: "Lapsed undecided", tone: "default" },
  APPROVED: { label: "Approved, unused", tone: "green" },
  PARTLY_USED: { label: "Approved, partly used", tone: "green" },
  USED: { label: "Used", tone: "blue" },
  EXPIRED: { label: "Expired unused", tone: "default" },
  REJECTED: { label: "Refused", tone: "red" },
  REVOKED: { label: "Revoked", tone: "red" },
};

export function ExceptionStateBadge({ state }: { state: ExceptionState }) {
  return <Badge tone={STATE[state].tone}>{STATE[state].label}</Badge>;
}

/** What the person was refused for when they asked — the server's sum, never coordinates. */
function attemptText(row: ExceptionView) {
  if (!row.attemptProblem) return null;
  const bits = [PROBLEM_SHORT[row.attemptProblem] ?? row.attemptProblem];
  if (row.attemptDistanceM !== null) bits.push(`${row.attemptDistanceM.toLocaleString("en-IN")} m from the office`);
  if (row.attemptAccuracyM !== null) bits.push(`±${row.attemptAccuracyM} m`);
  return bits.join(" · ");
}

/** People › Attendance exceptions: the requests waiting, granting one, and every one there has been. */
export function AttendanceExceptions({ queue, history, people }: { queue: ExceptionView[]; history: ExceptionView[]; people: PersonOption[] }) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-semibold text-text">Waiting for a decision</h2>
        {queue.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing waiting. A request appears here when somebody refused at clock-in asks to clock in anyway.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {queue.map((row) => (
              <PendingCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </section>
      <GrantForm people={people} />
      <History rows={history} />
    </div>
  );
}

function PendingCard({ row }: { row: ExceptionView }) {
  const router = useRouter();
  const clock = useClock();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function decide(approve: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await decideAttendanceException({ id: row.id, approve, note });
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  }

  const attempt = attemptText(row);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text">
            {row.user.name} — {EXCEPTION_SCOPE_LABELS[row.scope].toLowerCase()} away from the office
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Asked {clock.dateTimeShort(row.requestedAt)} · for today, until {clock.dateTimeShort(row.validUntil)}
          </p>
          <p className="mt-2 text-sm text-text">
            <span className="font-medium">{EXCEPTION_REASON_LABELS[row.reasonCode]}:</span> {row.reason}
          </p>
          {attempt && <p className="mt-1 text-xs text-muted">When refused: {attempt}</p>}
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-72">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to them (optional)" maxLength={300} aria-label={`Note to ${row.user.name}`} />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => decide(true)} disabled={pending}>
              Approve
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => decide(false)} disabled={pending}>
              Refuse
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function GrantForm({ people }: { people: PersonOption[] }) {
  const router = useRouter();
  const clock = useClock();
  const today = clock.today();
  const [personId, setPersonId] = useState("");
  const [scope, setScope] = useState<"IN" | "OUT" | "IN_AND_OUT">("IN_AND_OUT");
  const [reasonCode, setReasonCode] = useState<keyof typeof EXCEPTION_REASON_LABELS>("ALTERNATE_LOCATION");
  const [reason, setReason] = useState("");
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function grant() {
    setMessage(null);
    startTransition(async () => {
      const result = await grantAttendanceException({ userId: personId, scope, reasonCode, reason, fromDate, toDate });
      if (!result.ok) return setMessage({ ok: false, text: result.error });
      setMessage({ ok: true, text: "Granted. They've been told, and can clock in or out once each way within it." });
      setReason("");
      setPersonId("");
      router.refresh();
    });
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-text">Grant an exception</h2>
      <p className="mt-1 text-xs text-muted">
        For somebody you know won&apos;t be at their office — a client visit, a site, GPS that won&apos;t settle. One clock-in and one clock-out
        within the days you choose; never your own.
      </p>
      <Card className="mt-2 max-w-3xl p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="grant-person">Person</Label>
            <PersonCombobox id="grant-person" people={people} value={personId} onSelect={(p) => setPersonId(p?.id ?? "")} />
          </div>
          <div>
            <Label htmlFor="grant-scope">For</Label>
            <Select id="grant-scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              {(Object.keys(EXCEPTION_SCOPE_LABELS) as (keyof typeof EXCEPTION_SCOPE_LABELS)[]).map((k) => (
                <option key={k} value={k}>
                  {EXCEPTION_SCOPE_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="grant-reason-code">Reason</Label>
            <Select id="grant-reason-code" value={reasonCode} onChange={(e) => setReasonCode(e.target.value as typeof reasonCode)}>
              {(Object.keys(EXCEPTION_REASON_LABELS) as (keyof typeof EXCEPTION_REASON_LABELS)[]).map((k) => (
                <option key={k} value={k}>
                  {EXCEPTION_REASON_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="grant-from">From</Label>
            <Input id="grant-from" type="date" value={fromDate} min={today} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="grant-to">To</Label>
            <Input id="grant-to" type="date" value={toDate} min={fromDate || today} onChange={(e) => setToDate(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="grant-reason">Why</Label>
            <Textarea id="grant-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. At the Acme site for the installation" />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="button" onClick={grant} disabled={pending || !personId}>
            {pending ? "Granting…" : "Grant exception"}
          </Button>
          {message && (
            <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-muted" : "text-danger"}`}>
              {message.text}
            </p>
          )}
        </div>
      </Card>
    </section>
  );
}

function History({ rows }: { rows: ExceptionView[] }) {
  const clock = useClock();
  const [revoking, setRevoking] = useState<ExceptionView | null>(null);
  return (
    <section>
      <h2 className="text-sm font-semibold text-text">History</h2>
      <p className="mt-1 text-xs text-muted">Every exception, newest first — who asked or granted it, who decided, and the clockings it allowed.</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">None yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-base border border-line">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-surface-sunken text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Person</th>
                <th className="px-3 py-2 font-medium">Exception</th>
                <th className="px-3 py-2 font-medium">Window</th>
                <th className="px-3 py-2 font-medium">Decided</th>
                <th className="px-3 py-2 font-medium">Used</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const granted = row.requestedBy.id !== row.user.id;
                const attempt = attemptText(row);
                return (
                  <tr key={row.id} className="border-t border-line align-top">
                    <td className="px-3 py-2">
                      <span className="font-medium text-text">{row.user.name}</span>
                      <span className="mt-1 block">
                        <ExceptionStateBadge state={row.state} />
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-text">{EXCEPTION_SCOPE_LABELS[row.scope]}</span>
                      <span className="block text-xs text-muted">
                        {EXCEPTION_REASON_LABELS[row.reasonCode]}: {row.reason}
                      </span>
                      <span className="block text-xs text-subtle">
                        {granted ? `Granted by ${row.requestedBy.name}` : "Asked by them"} · {clock.dateTimeShort(row.requestedAt)}
                      </span>
                      {attempt && <span className="block text-xs text-subtle">When refused: {attempt}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {clock.dateTimeShort(row.validFrom)}
                      <br />
                      to {clock.dateTimeShort(row.validUntil)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {row.decidedBy ? (
                        <>
                          {row.status === "REJECTED" ? "Refused" : "Approved"} by {row.decidedBy.name}
                          {row.decidedAt && <span className="block">{clock.dateTimeShort(row.decidedAt)}</span>}
                          {row.decisionNote && !granted && <span className="block">“{row.decisionNote}”</span>}
                        </>
                      ) : (
                        "—"
                      )}
                      {row.revokedBy && (
                        <span className="mt-1 block text-danger">
                          {row.revokedBy.id === row.user.id ? "Withdrawn" : `Revoked by ${row.revokedBy.name}`}
                          {row.revokedAt && `, ${clock.dateTimeShort(row.revokedAt)}`}
                          {row.revokeReason && row.revokedBy.id !== row.user.id && <span className="block text-muted">“{row.revokeReason}”</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {row.usedInAt && <span className="block">In {clock.dateTimeShort(row.usedInAt)}</span>}
                      {row.usedOutAt && <span className="block">Out {clock.dateTimeShort(row.usedOutAt)}</span>}
                      {!row.usedInAt && !row.usedOutAt && "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {(row.state === "APPROVED" || row.state === "PARTLY_USED") && (
                        <Button type="button" size="sm" variant="ghost" onClick={() => setRevoking(row)}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {revoking && <RevokeDialog row={revoking} onClose={() => setRevoking(null)} />}
    </section>
  );
}

function RevokeDialog({ row, onClose }: { row: ExceptionView; onClose: () => void }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function revoke() {
    setError(null);
    startTransition(async () => {
      const result = await revokeAttendanceException({ id: row.id, reason });
      if (!result.ok) return setError(result.error);
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onClose={onClose} title={`Revoke ${row.user.name}'s exception`}>
      <p className="text-sm text-muted">
        They won&apos;t be able to use what is left of it. A clocking it already allowed stays as it was. They&apos;ll be told, with your reason.
      </p>
      <Label htmlFor="revoke-reason" className="mt-3 block">
        Reason
      </Label>
      <Textarea id="revoke-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="danger" onClick={revoke} disabled={pending}>
          {pending ? "Revoking…" : "Revoke"}
        </Button>
      </div>
    </Dialog>
  );
}
