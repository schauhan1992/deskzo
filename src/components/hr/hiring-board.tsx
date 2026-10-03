"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, UserPlus } from "lucide-react";
import type { EmploymentType } from "@prisma/client";
import type { Role } from "@/lib/roles";
import type { listCandidates } from "@/actions/candidate";
import { saveCandidate } from "@/actions/candidate";
import { Badge, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { candidateStatusLabels, candidateStatusTone } from "@/lib/hr/onboarding";
import { employmentTypeLabels, employmentTypeValues } from "@/lib/validation/hr";

type Candidate = Awaited<ReturnType<typeof listCandidates>>[number];

const ROLES: Role[] = ["ADMIN", "PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"];

/**
 * Who is being hired.
 *
 * Nobody here has a login. That is the point of the model behind it — an offer can be made, a form
 * sent, and documents filed, all without an account existing for somebody who may yet decline.
 */
export function HiringBoard({
  candidates,
  departments,
  managers,
}: {
  candidates: Candidate[];
  departments: { id: string; name: string }[];
  managers: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <NewCandidateDialog departments={departments} managers={managers} />
      </div>

      <Card className="overflow-hidden p-0">
        <CardHeader className="text-sm font-medium text-text">Candidates</CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Team</th>
                <th className="px-4 py-2.5 text-right">Offered</th>
                <th className="px-4 py-2.5">Expected</th>
                <th className="px-4 py-2.5">Details</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5">
                    <Link href={`/people/hiring/${c.id}`} className="font-medium text-text hover:underline">
                      {c.name}
                    </Link>
                    <div className="text-xs text-subtle">{c.email}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {c.designation ?? "—"}
                    <div className="text-[11px] text-subtle">{employmentTypeLabels[c.employmentType]}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{c.department?.name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted">
                    {c.offeredCtc ? formatCurrency(Number(c.offeredCtc)) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {c.expectedJoining ? formatCalendarDay(c.expectedJoining) : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {/* The thing HR is actually chasing between offer and joining. */}
                    {c.intakeSubmittedAt ? (
                      <Badge tone="green">Received</Badge>
                    ) : c.intakeToken ? (
                      <Badge tone="amber">Link sent</Badge>
                    ) : (
                      <span className="text-xs text-subtle">Not asked</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={candidateStatusTone[c.status]}>{candidateStatusLabels[c.status]}</Badge>
                  </td>
                </tr>
              ))}
              {candidates.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-subtle">
                    Nobody in the pipeline. Add a candidate before drafting an offer — that way the letter has
                    somewhere to live, and no login exists until they actually join.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function NewCandidateDialog({
  departments,
  managers,
}: {
  departments: { id: string; name: string }[];
  managers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    designation: "",
    departmentId: "",
    employmentType: "FULL_TIME" as EmploymentType,
    workLocation: "",
    managerId: "",
    role: "SALES" as Role,
    source: "",
    offeredCtc: "",
    expectedJoining: "",
    notes: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveCandidate({
        ...form,
        offeredCtc: form.offeredCtc ? Number(form.offeredCtc) : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.push(`/people/hiring/${result.data.id}`);
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add candidate
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Add a candidate">
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cName">Name</Label>
              <Input id="cName" value={form.name} onChange={set("name")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cEmail">Email</Label>
              <Input id="cEmail" type="email" value={form.email} onChange={set("email")} />
              <p className="text-xs text-subtle">The intake link goes here, and becomes their login on joining.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cPhone">Phone</Label>
              <Input id="cPhone" value={form.phone} onChange={set("phone")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cDesignation">Designation</Label>
              <Input id="cDesignation" value={form.designation} onChange={set("designation")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cDept">Team</Label>
              <Select id="cDept" value={form.departmentId} onChange={set("departmentId")}>
                <option value="">—</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cType">Employment type</Label>
              <Select id="cType" value={form.employmentType} onChange={set("employmentType")}>
                {employmentTypeValues.map((t) => (
                  <option key={t} value={t}>
                    {employmentTypeLabels[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cManager">Reports to</Label>
              <Select id="cManager" value={form.managerId} onChange={set("managerId")}>
                <option value="">—</option>
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cRole">Access role on joining</Label>
              <Select id="cRole" value={form.role} onChange={set("role")}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cCtc">Offered CTC (annual)</Label>
              <Input id="cCtc" type="number" value={form.offeredCtc} onChange={set("offeredCtc")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cJoining">Expected joining</Label>
              <Input id="cJoining" type="date" value={form.expectedJoining} onChange={set("expectedJoining")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cLocation">Work location</Label>
              <Input id="cLocation" value={form.workLocation} onChange={set("workLocation")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cSource">Where they came from</Label>
              <Input id="cSource" value={form.source} onChange={set("source")} placeholder="Referral, Naukri, LinkedIn" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cNotes">Notes</Label>
            <Textarea id="cNotes" rows={2} value={form.notes} onChange={set("notes")} />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button disabled={pending || !form.name.trim() || !form.email.trim()} onClick={submit}>
              <UserPlus className="mr-1.5 h-3.5 w-3.5" />
              {pending ? "Saving…" : "Add"}
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
