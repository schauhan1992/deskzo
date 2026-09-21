"use client";

import { useState } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { changeOwnPassword } from "@/actions/profile";
import { changePasswordSchema, type ChangePasswordInput } from "@/lib/validation/profile";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

type FormValues = z.input<typeof changePasswordSchema>;

export function ChangePasswordForm({ onSuccess }: { onSuccess?: () => void }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) });

  async function onSubmit(values: ChangePasswordInput) {
    setServerError(null);
    setSuccess(false);
    const result = await changeOwnPassword(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    reset();
    setSuccess(true);
    onSuccess?.();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      {serverError && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</p>}
      {success && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">Password updated.</p>}
      <div className="space-y-1.5">
        <Label htmlFor="currentPassword">Current password</Label>
        <Input id="currentPassword" type="password" autoComplete="current-password" {...register("currentPassword")} />
        {errors.currentPassword && <p className="text-xs text-danger">{errors.currentPassword.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="newPassword">New password</Label>
        <Input id="newPassword" type="password" autoComplete="new-password" {...register("newPassword")} />
        {errors.newPassword && <p className="text-xs text-danger">{errors.newPassword.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input id="confirmPassword" type="password" autoComplete="new-password" {...register("confirmPassword")} />
        {errors.confirmPassword && <p className="text-xs text-danger">{errors.confirmPassword.message}</p>}
      </div>
      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Update password"}
      </Button>
    </form>
  );
}
