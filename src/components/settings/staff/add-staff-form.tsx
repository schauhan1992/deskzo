"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheck } from "lucide-react";
import { createUser, updateUserAssignment } from "@/actions/user";
import { setUserBranch } from "@/actions/branch";
import { createUserSchema } from "@/lib/validation/user";
import { branchLabel } from "@/lib/branches/format";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { SetupLinkOnce } from "@/components/settings/setup-link-once";
import type { DepartmentChoice, RoleChoice, WorkBranch } from "@/components/settings/staff/types";

/**
 * Add staff: the reference's "Add a staff account" form, without its password.
 *
 * Nobody types a password for anybody here. The account is made with none (src/lib/no-password.ts) and
 * its person chooses their own from the setup email — or, when the email can't be sent, from the link
 * shown once to whoever added them (`SetupLinkOnce`), as the old New user dialog did.
 *
 * It is the same `createUser` action, with the optional job title, phone and status this form added
 * to it. The reporting manager and "works at" are not part of creating an account and never were;
 * they go through `updateUserAssignment` and `setUserBranch` just after, with their own rules — a
 * reporting line hands the reports' permissions to the manager, so it needs permission to manage
 * access — and a refusal of either is reported without undoing the account.
 */

const formSchema = createUserSchema.extend({
  status: z.enum(["active", "off"]),
  managerId: z.string().optional(),
  branchId: z.string().optional(),
});
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

/** What the done step shows. `setupUrl` is held only while it is on screen — never stored. */
type Done = {
  name: string;
  email: string;
  linking: boolean;
  emailed: boolean;
  setupUrl?: string;
  switchedOff: boolean;
  followUps: string[];
};

export function AddStaffForm({
  roles,
  departments,
  managers,
  branches,
  offerLinking = false,
}: {
  /** The roles a new account may start in — never Admin (see the page). */
  roles: RoleChoice[];
  departments: DepartmentChoice[];
  /** Who they could report to, or null when the viewer may not set a reporting line. */
  managers: { id: string; name: string }[] | null;
  /** "Works at" choices, or null for a single-branch company or a viewer who can't set it. */
  branches: WorkBranch[] | null;
  offerLinking?: boolean;
}) {
  const router = useRouter();
  const [done, setDone] = useState<Done | null>(null);
  const [attempt, setAttempt] = useState(0);

  if (done) {
    const backToStaff = () => router.push("/settings/access");
    return (
      <Card>
        <CardContent className="space-y-4">
          {done.followUps.map((message) => (
            <ActionNotice key={message} tone="error">
              {message}
            </ActionNotice>
          ))}
          {done.switchedOff ? (
            <p role="status" className="text-sm text-muted">
              {done.name}&apos;s account is made, switched off, and nobody has been emailed. Switch them on from the Staff
              list when they start, then send their setup email from the pencil on their row.
            </p>
          ) : done.setupUrl ? (
            // The email couldn't be sent: the link itself, once, to pass on (src/lib/account-setup.ts).
            <div className="space-y-3">
              <p className="text-sm text-muted">{done.name}&apos;s account is made.</p>
              <SetupLinkOnce email={done.email} setupUrl={done.setupUrl} />
            </div>
          ) : done.emailed ? (
            <p role="status" className="text-sm text-muted">
              {done.name}&apos;s account is made. We&apos;ve emailed {done.email} a link to{" "}
              {done.linking
                ? "set up their account and link it to the workspace they already use"
                : "choose their own password"}{" "}
              — it works once, for three days. Until they use it they show as Invited, and the pencil on their row can
              send it again.
            </p>
          ) : (
            <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {done.name}&apos;s account is made, but the setup email couldn&apos;t be sent. Send it again from the pencil
              on their row.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setDone(null);
                setAttempt((n) => n + 1);
              }}
            >
              Add another
            </Button>
            <Button type="button" size="sm" onClick={backToStaff}>
              Done
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <AddStaffFields
      key={attempt}
      roles={roles}
      departments={departments}
      managers={managers}
      branches={branches}
      offerLinking={offerLinking}
      onCreated={(made) => {
        setDone(made);
        router.refresh();
      }}
    />
  );
}

function AddStaffFields({
  roles,
  departments,
  managers,
  branches,
  offerLinking,
  onCreated,
}: {
  roles: RoleChoice[];
  departments: DepartmentChoice[];
  managers: { id: string; name: string }[] | null;
  branches: WorkBranch[] | null;
  offerLinking: boolean;
  onCreated: (done: Done) => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  const defaultRole = roles.some((r) => r.key === "SALES") ? "SALES" : (roles[0]?.key ?? "");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      email: "",
      jobTitle: "",
      phone: "",
      role: defaultRole,
      status: "active",
      departmentId: "",
      managerId: "",
      branchId: "",
      usesAnotherWorkspace: false,
    },
  });

  async function onSubmit(values: FormOutput) {
    setServerError(null);
    const result = await createUser({
      name: values.name,
      email: values.email,
      role: values.role,
      departmentId: values.departmentId,
      jobTitle: values.jobTitle,
      phone: values.phone,
      usesAnotherWorkspace: values.usesAnotherWorkspace,
      active: values.status === "active",
    });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    const made = result.data;

    // The account exists from here on; what follows can be refused without undoing it.
    const followUps: string[] = [];
    if (values.managerId) {
      const assigned = await updateUserAssignment({
        id: made.id,
        role: values.role,
        departmentId: values.departmentId || null,
        managerId: values.managerId,
      });
      if (!assigned.ok) followUps.push(`The account is made, but their reporting manager wasn't set: ${assigned.error}`);
    }
    if (values.branchId) {
      const placed = await setUserBranch(made.id, values.branchId);
      if (!placed.ok) followUps.push(`The account is made, but where they work wasn't set: ${placed.error}`);
    }

    onCreated({
      name: values.name.trim(),
      email: values.email.trim(),
      linking: values.usesAnotherWorkspace === true,
      emailed: made.emailed,
      ...(!made.emailed && made.setupUrl ? { setupUrl: made.setupUrl } : {}),
      switchedOff: made.startsSwitchedOff === true,
      followUps,
    });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <Card>
        <CardContent className="space-y-5">
          {serverError && <ActionNotice tone="error">{serverError}</ActionNotice>}

          <div className="grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
            <Field error={errors.name?.message}>
              <Label htmlFor="as-name">Full name<Required /></Label>
              <Input id="as-name" autoComplete="off" aria-invalid={Boolean(errors.name)} {...register("name")} />
            </Field>
            <Field error={errors.email?.message}>
              <Label htmlFor="as-email">Email address<Required /></Label>
              <Input id="as-email" type="email" autoComplete="off" aria-invalid={Boolean(errors.email)} {...register("email")} />
            </Field>
            <Field error={errors.jobTitle?.message} hint="Kept as their designation on the HR record.">
              <Label htmlFor="as-job-title">Job title</Label>
              <Input id="as-job-title" autoComplete="off" {...register("jobTitle")} />
            </Field>
            <Field error={errors.phone?.message} hint="A work number — the one printed on quotes they send.">
              <Label htmlFor="as-phone">Phone</Label>
              <Input id="as-phone" type="tel" autoComplete="off" {...register("phone")} />
            </Field>
            <Field error={errors.role?.message} hint="Decides what they can do.">
              <Label htmlFor="as-role">Role<Required /></Label>
              <Select id="as-role" {...register("role")}>
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field hint="Switched off takes no seat, and sends nothing until you switch them on.">
              <Label htmlFor="as-status">Status</Label>
              <Select id="as-status" {...register("status")}>
                <option value="active">Active — gets their setup email now</option>
                <option value="off">Switched off — can&apos;t sign in yet</option>
              </Select>
            </Field>
            <Field hint="Grouping only — a department carries no permissions.">
              <Label htmlFor="as-department">Department</Label>
              <Select id="as-department" {...register("departmentId")}>
                <option value="">No department</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            {managers && (
              <Field hint="Their manager also gets every permission they hold.">
                <Label htmlFor="as-manager">Reporting manager</Label>
                <Select id="as-manager" {...register("managerId")}>
                  <option value="">No manager</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {branches && (
              <Field hint="Their default branch on new documents.">
                <Label htmlFor="as-branch">Works at</Label>
                <Select id="as-branch" {...register("branchId")}>
                  <option value="">— none —</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {branchLabel(b)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          {offerLinking && (
            <div className="space-y-1">
              <label className="flex items-start gap-2.5 text-sm text-text">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
                  aria-describedby="as-links-help"
                  {...register("usesAnotherWorkspace")}
                />
                <span>This person already uses another workspace on this platform</span>
              </label>
              <p id="as-links-help" className="pl-6.5 text-xs text-muted">
                Their setup email will also offer to link their account here to that workspace, so they can switch
                between the two. You won&apos;t see which workspace it is.
              </p>
            </div>
          )}

          {/* Where the reference asks for a password. */}
          <p className="flex items-start gap-2.5 rounded-base border border-line bg-surface-sunken px-3 py-2.5 text-sm text-muted">
            <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
            <span>
              No password to set. They&apos;ll get an email with a link to choose their own — it works once, for three
              days. If the email can&apos;t be sent, the link is shown to you once, here, to pass on to them.
            </span>
          </p>
        </CardContent>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Link
            href="/settings/access"
            className="inline-flex h-8 items-center rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium text-text shadow-sm transition-colors hover:bg-surface-sunken"
          >
            Cancel
          </Link>
          <Button type="submit" size="sm" disabled={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create account"}
          </Button>
        </div>
      </Card>
    </form>
  );
}

/**
 * A label and its control (the children, written together at the call site so the label's `htmlFor`
 * sits beside the control's id), and a hint that gives way to the field's error.
 */
function Field({ hint, error, children }: { hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}

/** The reference's asterisk, which a screen reader hears as "required". */
function Required() {
  return (
    <>
      <span className="text-danger" aria-hidden>
        {" "}
        *
      </span>
      <span className="sr-only"> (required)</span>
    </>
  );
}
