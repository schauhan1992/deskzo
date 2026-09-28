"use client";

import { useState } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import type { Role } from "@/lib/roles";
import { createUser } from "@/actions/user";
import { createUserSchema, type CreateUserInput } from "@/lib/validation/user";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { SetupLinkOnce } from "@/components/settings/setup-link-once";

type FormValues = z.input<typeof createUserSchema>;

/**
 * What the done step shows: where the setup email went and whether it was the one-step invite — or, when it
 * couldn't be sent, the setup link to pass on, held only while the step is on screen.
 */
export type CreatedUser = { email: string; linking: boolean; emailed: boolean; setupUrl?: string };

type Choices = {
  roles: readonly Role[];
  departments: { id: string; name: string }[];
  /** Linked sign-in is available here (a control-plane workspace, not paused): offer the one-step invite. */
  offerLinking?: boolean;
};

/** Adding somebody: the admin chooses who and what they do; the person chooses their own password, from the setup email. */
export function NewUserDialog({ roles, departments, offerLinking = false }: Choices) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreatedUser | null>(null);
  // A fresh form every time the dialog opens.
  const [attempt, setAttempt] = useState(0);

  function openDialog() {
    setCreated(null);
    setAttempt((n) => n + 1);
    setOpen(true);
  }

  // Closing forgets the done step, and with it any setup link it was showing.
  function close() {
    setOpen(false);
    setCreated(null);
  }

  return (
    <>
      <Button type="button" size="sm" onClick={openDialog}>
        + New user
      </Button>

      <Dialog open={open} onClose={close} title="New user">
        {created ? (
          <NewUserCreated created={created} onDone={close} />
        ) : (
          <NewUserForm
            key={attempt}
            roles={roles}
            departments={departments}
            offerLinking={offerLinking}
            onCancel={close}
            onCreated={(made) => {
              setCreated(made);
              router.refresh();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

/** The dialog's form. No password field: the setup email is how the person gets in. */
export function NewUserForm({
  roles,
  departments,
  offerLinking = false,
  onCreated,
  onCancel,
}: Choices & { onCreated: (created: CreatedUser) => void; onCancel: () => void }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { name: "", email: "", role: "SALES", departmentId: "", usesAnotherWorkspace: false },
  });

  async function onSubmit(values: CreateUserInput) {
    setServerError(null);
    const result = await createUser(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    const made = result.data;
    onCreated({
      email: values.email.trim(),
      linking: values.usesAnotherWorkspace === true,
      emailed: made.emailed,
      ...(!made.emailed && made.setupUrl ? { setupUrl: made.setupUrl } : {}),
    });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      {serverError && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="nu-name">Name *</Label>
        <Input id="nu-name" {...register("name")} />
        {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="nu-email">Email *</Label>
        <Input id="nu-email" type="email" aria-describedby="nu-setup-help" {...register("email")} />
        {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
        <p id="nu-setup-help" className="text-xs text-subtle">
          We&apos;ll email them a link to choose their own password. It works once, for three days.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="nu-role">Role</Label>
          <Select id="nu-role" {...register("role")}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nu-department">Department</Label>
          <Select id="nu-department" {...register("departmentId")}>
            <option value="">No department</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {offerLinking && (
        <div className="space-y-1">
          <label className="flex items-start gap-2.5 text-sm text-text">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
              aria-describedby="nu-links-help"
              {...register("usesAnotherWorkspace")}
            />
            <span>This person already uses another workspace on this platform</span>
          </label>
          <p id="nu-links-help" className="pl-6.5 text-xs text-muted">
            Their setup email will also offer to link their account here to that workspace, so they can switch
            between the two. You won&apos;t see which workspace it is.
          </p>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Creating…" : "Create and send setup email"}
        </Button>
      </div>
    </form>
  );
}

/** The done step: the email went, or the link to pass on (shown once), or — neither — how to try again. */
export function NewUserCreated({ created, onDone }: { created: CreatedUser; onDone: () => void }) {
  if (!created.emailed && created.setupUrl) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Account created.
          {created.linking && " They can link their other workspace from their profile once they've signed in."}
        </p>
        <SetupLinkOnce email={created.email} setupUrl={created.setupUrl} onDone={onDone} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {created.emailed ? (
        <p role="status" className="text-sm text-muted">
          Account created. We&apos;ve emailed {created.email} a link to{" "}
          {created.linking
            ? "set up their account and link it to the workspace they already use"
            : "choose their own password"}{" "}
          — it works once, for three days. Until they do, they show as Invitation pending, and you can resend it from
          the list.
        </p>
      ) : (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          Account created, but the setup email couldn&apos;t be sent. Try Resend setup email in the list.
        </p>
      )}
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
