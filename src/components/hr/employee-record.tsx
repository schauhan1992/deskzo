"use client";

import { useState } from "react";
import Link from "next/link";
import { Pencil, Users } from "lucide-react";
import type { getPerson } from "@/actions/hr";
import type { BalanceRow } from "@/actions/leave";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { EmployeeForm } from "@/components/hr/employee-form";
import { ExitDialog } from "@/components/hr/exit-dialog";
import { employmentTypeLabels, exitTypeLabels } from "@/lib/validation/hr";

type Person = NonNullable<Awaited<ReturnType<typeof getPerson>>>;

/**
 * One person's HR record.
 *
 * Read mode by default, because this page is looked at far more often than it is edited, and a
 * screen of input boxes is a worse thing to read than a list of facts.
 */
export function EmployeeRecord({
  person,
  balances,
  canManage,
  canHandOver,
  isSelf,
}: {
  person: Person;
  balances: BalanceRow[];
  canManage: boolean;
  canHandOver: boolean;
  isSelf: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const p = person.employeeProfile;
  const canEdit = canManage || isSelf;

  if (editing) {
    return <EmployeeForm person={person} canManage={canManage} onDone={() => setEditing(false)} />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{person.name}</h1>
            {p?.exitedOn ? (
              <Badge tone="red">
                {p.exitType ? exitTypeLabels[p.exitType] : "Exited"} · {formatDate(p.exitedOn)}
              </Badge>
            ) : person.active ? (
              <Badge tone="green">Active</Badge>
            ) : (
              <Badge tone="default">Inactive</Badge>
            )}
            {p?.probationEndsOn && !p.confirmedOn && <Badge tone="amber">On probation</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {[p?.designation ?? person.role, person.department?.name, p?.workLocation].filter(Boolean).join(" · ")}
          </p>
          <p className="mt-0.5 text-xs text-subtle">
            {person.email}
            {p?.employeeCode && ` · ${p.employeeCode}`}
            {person.manager && ` · reports to ${person.manager.name}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit record
            </Button>
          )}
          {/* Offered whether or not they are leaving. The same job comes up for a long absence
              or a change of territory, and a handover reachable only through "record an exit" is
              one nobody runs until somebody resigns. */}
          {canHandOver && !isSelf && (
            <Link href={`/people/${person.id}/handover`}>
              <Button variant="secondary">
                <Users className="mr-1.5 h-3.5 w-3.5" />
                Hand over work
              </Button>
            </Link>
          )}
          {canManage && !p?.exitedOn && !isSelf && (
            <ExitDialog userId={person.id} name={person.name} />
          )}
        </div>
      </div>

      {!p && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          {isSelf
            ? "You have no employment record yet. Fill it in so leave, attendance and payroll have something to work from."
            : "This login has no employment record — no joining date, no statutory details, and payroll will skip them."}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Employment</CardHeader>
            <CardContent className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row label="Employee code" value={p?.employeeCode} />
              <Row label="Designation" value={p?.designation} />
              <Row label="Type" value={p ? employmentTypeLabels[p.employmentType] : null} />
              <Row label="Work location" value={p?.workLocation} />
              <Row label="Joined" value={p?.joinedOn ? formatDate(p.joinedOn) : null} />
              <Row label="Probation ends" value={p?.probationEndsOn ? formatDate(p.probationEndsOn) : null} />
              <Row label="Confirmed" value={p?.confirmedOn ? formatDate(p.confirmedOn) : null} />
              <Row label="Reports to" value={person.manager?.name} />
              {p?.exitedOn && (
                <>
                  <Row label="Last working day" value={formatDate(p.exitedOn)} />
                  <Row label="Reason" value={p.exitReason} />
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Personal</CardHeader>
            <CardContent className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row label="Date of birth" value={p?.dateOfBirth ? formatDate(p.dateOfBirth) : null} />
              <Row label="Gender" value={p?.gender ? p.gender.toLowerCase() : null} />
              <Row label="Blood group" value={p?.bloodGroup} />
              <Row label="Marital status" value={p?.maritalStatus} />
              <Row label="Personal email" value={p?.personalEmail} />
              <Row label="Personal phone" value={p?.personalPhone} />
              <Row
                label="Address"
                value={[p?.addressLine1, p?.addressLine2, p?.city, p?.state, p?.pincode].filter(Boolean).join(", ") || null}
                span
              />
              <Row
                label="Emergency contact"
                value={
                  p?.emergencyContactName
                    ? `${p.emergencyContactName}${p.emergencyContactRelation ? ` (${p.emergencyContactRelation})` : ""}${p.emergencyContactPhone ? ` · ${p.emergencyContactPhone}` : ""}`
                    : null
                }
                span
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Statutory &amp; bank</CardHeader>
            <CardContent className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Row label="PAN" value={p?.panNumber} mono />
              <Row label="Aadhaar" value={p?.aadhaarLast4 ? `•••• •••• ${p.aadhaarLast4}` : null} mono />
              <Row label="UAN" value={p?.uanNumber} mono />
              <Row label="PF number" value={p?.pfNumber} mono />
              <Row label="ESIC number" value={p?.esicNumber} mono />
              <Row label="Bank" value={p?.bankName} />
              <Row label="Account" value={p?.bankAccountNumber} mono />
              <Row label="IFSC" value={p?.bankIfsc} mono />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
              <span>Leave balance</span>
              <Link href="/people/leave" className="text-xs font-normal text-brand hover:underline">
                Open leave
              </Link>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {balances.length === 0 && <p className="text-subtle">No leave types set up yet.</p>}
              {balances.map((b) => (
                <div key={b.typeId} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">
                    {b.name}
                    {!b.paid && <span className="ml-1 text-xs text-subtle">unpaid</span>}
                  </span>
                  <span className="text-text">
                    <span className="font-medium">{b.available}</span>
                    <span className="text-xs text-subtle"> of {b.opening + b.credited + b.adjustment}</span>
                    {b.pending > 0 && <span className="ml-1 text-xs text-warning">· {b.pending} pending</span>}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          {person.directReports.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">
                Reports ({person.directReports.length})
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {person.directReports.map((r) => (
                  <Link key={r.id} href={`/people/${r.id}`} className="block text-text hover:underline">
                    {r.name}
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono, span }: { label: string; value?: string | null; mono?: boolean; span?: boolean }) {
  return (
    <div className={`flex flex-wrap items-baseline justify-between gap-x-3 ${span ? "sm:col-span-2" : ""}`}>
      <span className="text-muted">{label}</span>
      <span className={`text-right ${value ? "text-text" : "text-subtle"} ${mono && value ? "font-mono text-xs" : ""}`}>
        {value || "—"}
      </span>
    </div>
  );
}
