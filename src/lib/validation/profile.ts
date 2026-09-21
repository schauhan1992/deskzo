import { z } from "zod";

/**
 * The work number that goes on a quote.
 *
 * Loosely validated on purpose: an international number, an extension and a landline with
 * spaces in it are all legitimate, and a regex tight enough to be useful here would reject
 * somebody's real number. Nothing is dialled from it automatically, so the cost of a typo is a
 * customer who has to ask rather than a failed call.
 */
export const updateOwnContactSchema = z.object({
  phone: z.string().trim().max(32, "That is too long for a phone number").optional().or(z.literal("")),
});

export type UpdateOwnContactInput = z.infer<typeof updateOwnContactSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z.string().min(8, "New password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Confirm your new password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "New password and confirmation don't match",
    path: ["confirmPassword"],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const confirmTwoFactorSchema = z.object({
  code: z.string().trim().min(6, "Enter the 6-digit code").max(6, "Enter the 6-digit code"),
});

export const disableTwoFactorSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
});

/**
 * Same shape as disabling, and deliberately so.
 *
 * Enrolling an authenticator and removing one are both credential changes; asking for the password
 * on one and not the other is what let a stolen session cookie swap the second factor.
 */
export const beginTwoFactorSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
});
