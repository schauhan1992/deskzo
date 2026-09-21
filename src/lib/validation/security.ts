import { z } from "zod";

export const updateSecuritySettingsSchema = z.object({
  enforceTwoFactor: z.boolean(),
  ssoEnabled: z.boolean(),
  enforceSso: z.boolean(),
  microsoftTenantId: z.string().trim().optional().default(""),
  microsoftClientId: z.string().trim().optional().default(""),
  /** Blank means "keep the existing secret" on update. */
  microsoftClientSecret: z.string().trim().optional().or(z.literal("")),
});

export type UpdateSecuritySettingsInput = z.infer<typeof updateSecuritySettingsSchema>;
