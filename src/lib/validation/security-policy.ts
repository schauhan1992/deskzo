import { z } from "zod";

const ROLES = ["ADMIN", "PROFILE", "CALLING", "SALES", "SUPPORT", "MANAGEMENT", "ACCOUNTS", "PURCHASE"] as const;

export const updateSecurityPolicySchema = z.object({
  blockCopy: z.boolean(),
  blockCut: z.boolean(),
  blockPaste: z.boolean(),
  blockContextMenu: z.boolean(),
  blockTextSelection: z.boolean(),
  blockPrint: z.boolean(),
  blockDevTools: z.boolean(),
  blurOnBlur: z.boolean(),

  /** -1 unlimited, 0 none. Capped at 50 because a "limit" of 500 is not a limit. */
  screenshotLimitPerDay: z.number().int().min(-1).max(50),
  screenshotNotifyAdmins: z.boolean(),

  watermarkEnabled: z.boolean(),
  /**
   * Percent. Floored at 3 rather than 0: a watermark nobody can see is not a deterrent, it is a
   * setting that makes an admin believe they have one. Capped at 25 because past that the table
   * underneath stops being readable and somebody turns the whole thing off.
   */
  watermarkOpacity: z.number().int().min(3).max(25),
  /** Where it goes: the pages with customers' details, or every page. */
  watermarkScope: z.enum(["CUSTOMER_DATA", "EVERY_PAGE"]),

  /** 0 disables the cap. */
  exportRowLimit: z.number().int().min(0).max(1_000_000),
  exportRequiresReason: z.boolean(),

  bulkReadThreshold: z.number().int().min(0).max(100_000),
  bulkReadWindowMinutes: z.number().int().min(1).max(1440),

  blockBots: z.boolean(),
  blockAiCrawlers: z.boolean(),
  botMode: z.enum(["BLOCK", "LOG"]),

  logPageViews: z.boolean(),
  /**
   * Floored at 30 days. A retention short enough to lose last month's incident is not a retention
   * policy, and India's DPDP Act expects you to be able to show what happened to personal data.
   */
  retentionDays: z.number().int().min(30).max(3650),

  exemptRoles: z.array(z.enum(ROLES)),
});

export type UpdateSecurityPolicyInput = z.infer<typeof updateSecurityPolicySchema>;
