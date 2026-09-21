"use client";

import { useState } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { createUser } from "@/actions/user";
import { createUserSchema, type CreateUserInput } from "@/lib/validation/user";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

type FormValues = z.input<typeof createUserSchema>;

function randomTemporaryPassword() {
  return `Wroffy-${Math.random().toString(36).slice(2, 8)}${Math.floor(Math.random() * 100)}`;
}

export function NewUserDialog({
  roles,
  departments,
}: {
  roles: readonly Role[];
  departments: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { role: "SALES", temporaryPassword: randomTemporaryPassword() },
  });

  function openDialog() {
    setServerError(null);
    setCreatedPassword(null);
    reset({ name: "", email: "", role: "SALES", departmentId: "", temporaryPassword: randomTemporaryPassword() });
    setOpen(true);
  }

  async function onSubmit(values: CreateUserInput) {
    setServerError(null);
    const result = await createUser(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    setCreatedPassword(values.temporaryPassword);
    router.refresh();
  }

  return (
    <>
      <Button type="button" size="sm" onClick={openDialog}>
        + New user
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="New user">
        {createdPassword ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Account created. Share this temporary password with them directly — it won&apos;t be shown again.
              They&apos;ll be asked to set their own password the first time they sign in.
            </p>
            <p className="rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm text-text">{createdPassword}</p>
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
            {serverError && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="nu-name">Name *</Label>
              <Input id="nu-name" {...register("name")} />
              {errors.name && <p className="text-xs text-danger">{errors.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nu-email">Email *</Label>
              <Input id="nu-email" type="email" {...register("email")} />
              {errors.email && <p className="text-xs text-danger">{errors.email.message}</p>}
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
            <div className="space-y-1.5">
              <Label htmlFor="nu-password">Temporary password</Label>
              <div className="flex gap-2">
                <Input id="nu-password" {...register("temporaryPassword")} />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setValue("temporaryPassword", randomTemporaryPassword())}
                >
                  Regenerate
                </Button>
              </div>
              {errors.temporaryPassword && <p className="text-xs text-danger">{errors.temporaryPassword.message}</p>}
              <p className="text-xs text-subtle">
                They&apos;ll be forced to change this the first time they sign in.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isSubmitting}>
                {isSubmitting ? "Creating…" : "Create user"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
