"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { getPerson } from "@/actions/hr";
import { saveEmployeeProfile } from "@/actions/hr";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { AddressFields } from "@/components/ui/address-fields";
import { employmentTypeLabels, employmentTypeValues, genderValues } from "@/lib/validation/hr";
import { toKey } from "@/lib/hr/calendar";

type Person = NonNullable<Awaited<ReturnType<typeof getPerson>>>;

const GENDER_LABELS: Record<string, string> = {
  FEMALE: "Female",
  MALE: "Male",
  OTHER: "Other",
  UNDISCLOSED: "Prefer not to say",
};

/**
 * The employee record form.
 *
 * Employment terms are shown read-only to somebody editing their own record — people should be able
 * to keep their own address and emergency contact current without an HR ticket, but not award
 * themselves a designation. The server enforces the same split; this only stops the UI offering
 * fields that would be ignored.
 */
export function EmployeeForm({
  person,
  canManage,
  onDone,
}: {
  person: Person;
  canManage: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const p = person.employeeProfile;

  const [form, setForm] = useState({
    employeeCode: p?.employeeCode ?? "",
    designation: p?.designation ?? "",
    employmentType: p?.employmentType ?? "FULL_TIME",
    workLocation: p?.workLocation ?? "",
    // The day each @db.Date holds. String() of a Date is "Fri Oct 02 2026 …": the inputs showed nothing,
    // and saving untouched stored 2001.
    joinedOn: p?.joinedOn ? toKey(p.joinedOn) : "",
    probationEndsOn: p?.probationEndsOn ? toKey(p.probationEndsOn) : "",
    confirmedOn: p?.confirmedOn ? toKey(p.confirmedOn) : "",
    dateOfBirth: p?.dateOfBirth ? toKey(p.dateOfBirth) : "",
    gender: p?.gender ?? "",
    bloodGroup: p?.bloodGroup ?? "",
    maritalStatus: p?.maritalStatus ?? "",
    personalEmail: p?.personalEmail ?? "",
    personalPhone: p?.personalPhone ?? "",
    addressLine1: p?.addressLine1 ?? "",
    addressLine2: p?.addressLine2 ?? "",
    city: p?.city ?? "",
    state: p?.state ?? "",
    pincode: p?.pincode ?? "",
    emergencyContactName: p?.emergencyContactName ?? "",
    emergencyContactPhone: p?.emergencyContactPhone ?? "",
    emergencyContactRelation: p?.emergencyContactRelation ?? "",
    panNumber: p?.panNumber ?? "",
    aadhaarLast4: p?.aadhaarLast4 ?? "",
    uanNumber: p?.uanNumber ?? "",
    pfNumber: p?.pfNumber ?? "",
    esicNumber: p?.esicNumber ?? "",
    bankName: p?.bankName ?? "",
    bankAccountNumber: p?.bankAccountNumber ?? "",
    bankIfsc: p?.bankIfsc ?? "",
  });

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await saveEmployeeProfile({ userId: person.id, ...form });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {canManage && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Employment</CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Employee code">
              {(id) => <Input id={id} value={form.employeeCode} onChange={set("employeeCode")} placeholder="WRF-014" />}
            </Field>
            <Field label="Designation">
              {(id) => (
                <Input id={id} value={form.designation} onChange={set("designation")} placeholder="Senior Sales Executive" />
              )}
            </Field>
            <Field label="Employment type">
              {(id) => (
                <Select id={id} value={form.employmentType} onChange={set("employmentType")}>
                  {employmentTypeValues.map((t) => (
                    <option key={t} value={t}>
                      {employmentTypeLabels[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Work location">
              {(id) => <Input id={id} value={form.workLocation} onChange={set("workLocation")} placeholder="Noida" />}
            </Field>
            <Field label="Joined on">
              {(id) => <Input id={id} type="date" value={form.joinedOn} onChange={set("joinedOn")} />}
            </Field>
            <Field label="Probation ends">
              {(id) => <Input id={id} type="date" value={form.probationEndsOn} onChange={set("probationEndsOn")} />}
            </Field>
            <Field label="Confirmed on">
              {(id) => <Input id={id} type="date" value={form.confirmedOn} onChange={set("confirmedOn")} />}
            </Field>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">Personal</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Date of birth">
            {(id) => <Input id={id} type="date" value={form.dateOfBirth} onChange={set("dateOfBirth")} />}
          </Field>
          <Field label="Gender">
            {(id) => (
              <Select id={id} value={form.gender} onChange={set("gender")}>
                <option value="">—</option>
                {genderValues.map((g) => (
                  <option key={g} value={g}>
                    {GENDER_LABELS[g]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Blood group">
            {(id) => <Input id={id} value={form.bloodGroup} onChange={set("bloodGroup")} placeholder="O+" />}
          </Field>
          <Field label="Marital status">
            {(id) => <Input id={id} value={form.maritalStatus} onChange={set("maritalStatus")} placeholder="Single" />}
          </Field>
          <Field label="Personal email">
            {(id) => <Input id={id} type="email" value={form.personalEmail} onChange={set("personalEmail")} />}
          </Field>
          <Field label="Personal phone">
            {(id) => <Input id={id} value={form.personalPhone} onChange={set("personalPhone")} />}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Address</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Address line 1" className="sm:col-span-2">
            {(id) => <Input id={id} value={form.addressLine1} onChange={set("addressLine1")} />}
          </Field>
          <Field label="Address line 2">
            {(id) => <Input id={id} value={form.addressLine2} onChange={set("addressLine2")} />}
          </Field>
          {/**
            * The state is not a label here either — it sets the professional-tax slab on every
            * payslip, so a typed spelling is the wrong deduction rather than an untidy record.
            */}
          <div className="sm:col-span-2">
            <AddressFields
              columns={3}
              showCountry={false}
              country="India"
              state={form.state}
              city={form.city}
              pincode={form.pincode}
              onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">In an emergency</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Name">
            {(id) => <Input id={id} value={form.emergencyContactName} onChange={set("emergencyContactName")} />}
          </Field>
          <Field label="Phone">
            {(id) => <Input id={id} value={form.emergencyContactPhone} onChange={set("emergencyContactPhone")} />}
          </Field>
          <Field label="Relationship">
            {(id) => (
              <Input
                id={id}
                value={form.emergencyContactRelation}
                onChange={set("emergencyContactRelation")}
                placeholder="Spouse"
              />
            )}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Statutory &amp; bank</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="PAN">
            {(id) => (
              <Input
                id={id}
                value={form.panNumber}
                onChange={set("panNumber")}
                placeholder="ABCDE1234F"
                className="uppercase"
              />
            )}
          </Field>
          <Field label="Aadhaar — last 4 only" hint="The whole number is never stored here.">
            {(id) => (
              <Input id={id} value={form.aadhaarLast4} onChange={set("aadhaarLast4")} maxLength={4} placeholder="1234" />
            )}
          </Field>
          <Field label="UAN">
            {(id) => <Input id={id} value={form.uanNumber} onChange={set("uanNumber")} />}
          </Field>
          <Field label="PF number">
            {(id) => <Input id={id} value={form.pfNumber} onChange={set("pfNumber")} />}
          </Field>
          <Field label="ESIC number">
            {(id) => <Input id={id} value={form.esicNumber} onChange={set("esicNumber")} />}
          </Field>
          <Field label="Bank">
            {(id) => <Input id={id} value={form.bankName} onChange={set("bankName")} />}
          </Field>
          <Field label="Account number">
            {(id) => <Input id={id} value={form.bankAccountNumber} onChange={set("bankAccountNumber")} />}
          </Field>
          <Field label="IFSC">
            {(id) => (
              <Input
                id={id}
                value={form.bankIfsc}
                onChange={set("bankIfsc")}
                placeholder="HDFC0001234"
                className="uppercase"
              />
            )}
          </Field>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save record"}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * A field and the label that names it.
 *
 * `children` is a function taking the id rather than plain nodes, so the `<Label htmlFor>` and the
 * control it points at cannot drift apart — a caption sitting above an unnamed input looks exactly
 * like a real label and is announced as nothing at all. Forcing the id through the signature means
 * the next field added here is named whether or not anybody remembered to think about it.
 *
 * `useId` rather than a hand-written string because this form opens in a dialog and a second copy
 * of it on the same page would otherwise emit duplicate ids, pointing every label at the first.
 */
function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}
