"use client";

import { useId, useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { submitIntake } from "@/actions/intake";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { AddressFields } from "@/components/ui/address-fields";

/**
 * What a new joiner fills in before their first day.
 *
 * Written for somebody who has never seen this system and may be on a phone: no jargon, every field
 * says why it is being asked, and the whole thing is one page rather than a wizard — people fill
 * this in once, in one sitting, usually while looking for their PAN card.
 */
export function IntakeForm({
  token,
  info,
}: {
  token: string;
  info: { name: string; email: string; designation: string | null; expectedJoining: string | null; companyName: string; alreadySubmitted: boolean };
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(info.alreadySubmitted);

  const [form, setForm] = useState({
    personalEmail: "",
    personalPhone: "",
    dateOfBirth: "",
    bloodGroup: "",
    maritalStatus: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    pincode: "",
    emergencyContactName: "",
    emergencyContactPhone: "",
    emergencyContactRelation: "",
    panNumber: "",
    aadhaarLast4: "",
    uanNumber: "",
    bankName: "",
    bankAccountNumber: "",
    bankIfsc: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await submitIntake({ token, ...form });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(true);
    });
  }

  if (done) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
        <h1 className="mt-3 text-lg font-semibold text-text">Thank you, {info.name.split(" ")[0]}.</h1>
        <p className="mt-2 text-sm text-muted">
          Your details have reached {info.companyName}. Nothing else is needed from you before your first day — HR will
          be in touch if anything is unclear.
        </p>
      </Card>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Welcome, {info.name.split(" ")[0]}</h1>
        <p className="mt-1 text-sm text-muted">
          A few details {info.companyName} needs before you start
          {info.designation && ` as ${info.designation}`}
          {info.expectedJoining && ` on ${new Date(info.expectedJoining).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`}.
          It takes about five minutes, and you will need your PAN and bank details to hand.
        </p>
      </div>

      <Card>
        <CardHeader className="text-sm font-medium text-text">About you</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Personal email" hint="Not your work address — somewhere we can reach you before day one.">
            {(id) => <Input id={id} type="email" value={form.personalEmail} onChange={set("personalEmail")} />}
          </Field>
          <Field label="Mobile number" required>
            {(id) => <Input id={id} value={form.personalPhone} onChange={set("personalPhone")} />}
          </Field>
          <Field label="Date of birth" required>
            {(id) => <Input id={id} type="date" value={form.dateOfBirth} onChange={set("dateOfBirth")} />}
          </Field>
          <Field label="Blood group" hint="Kept for emergencies only.">
            {(id) => <Input id={id} value={form.bloodGroup} onChange={set("bloodGroup")} placeholder="O+" />}
          </Field>
          <Field label="Marital status">
            {(id) => (
              <Select id={id} value={form.maritalStatus} onChange={set("maritalStatus")}>
                <option value="">Prefer not to say</option>
                <option value="Single">Single</option>
                <option value="Married">Married</option>
              </Select>
            )}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Where you live</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Address" required className="sm:col-span-2">
            {(id) => <Input id={id} value={form.addressLine1} onChange={set("addressLine1")} />}
          </Field>
          <Field label="Address line 2" className="sm:col-span-2">
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
          <Field label="Name" required>
            {(id) => <Input id={id} value={form.emergencyContactName} onChange={set("emergencyContactName")} />}
          </Field>
          <Field label="Phone" required>
            {(id) => <Input id={id} value={form.emergencyContactPhone} onChange={set("emergencyContactPhone")} />}
          </Field>
          <Field label="Relationship">
            {(id) => (
              <Input id={id} value={form.emergencyContactRelation} onChange={set("emergencyContactRelation")} placeholder="Spouse" />
            )}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">For payroll</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="PAN" hint="Needed for tax. Leave blank if you are applying for one.">
            {(id) => (
              <Input id={id} value={form.panNumber} onChange={set("panNumber")} className="uppercase" placeholder="ABCDE1234F" />
            )}
          </Field>
          {/* Four digits only, and the form says why — asking for a full Aadhaar would mean holding
              something we have no business holding. */}
          <Field label="Aadhaar — last 4 digits only" hint="We never store the full number.">
            {(id) => <Input id={id} value={form.aadhaarLast4} onChange={set("aadhaarLast4")} maxLength={4} placeholder="1234" />}
          </Field>
          <Field label="UAN" hint="Your provident fund number, if you have one from a previous job.">
            {(id) => <Input id={id} value={form.uanNumber} onChange={set("uanNumber")} />}
          </Field>
          <Field label="Bank">
            {(id) => <Input id={id} value={form.bankName} onChange={set("bankName")} placeholder="HDFC Bank" />}
          </Field>
          <Field label="Account number">
            {(id) => <Input id={id} value={form.bankAccountNumber} onChange={set("bankAccountNumber")} />}
          </Field>
          <Field label="IFSC">
            {(id) => (
              <Input id={id} value={form.bankIfsc} onChange={set("bankIfsc")} className="uppercase" placeholder="HDFC0001234" />
            )}
          </Field>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send my details"}
        </Button>
        <span className="text-xs text-subtle">You can only submit this once.</span>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  className?: string;
  /**
   * Handed the id its label points at, so the control is *named* by that label rather than merely
   * sitting under it — a `<Label>` with no `htmlFor` looks identical and reaches nobody. Taking the
   * id back from the field rather than each caller inventing one means the two can never drift, and
   * `useId()` keeps them unique even if this form is ever rendered twice on one screen.
   */
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </Label>
      {children(id)}
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}
