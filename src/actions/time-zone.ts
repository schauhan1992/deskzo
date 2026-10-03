"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { controlDb } from "@/lib/platform/control-db";
import { currentTenant } from "@/lib/tenancy/resolve";
import { forgetRegistry } from "@/lib/tenancy/registry";
import { clockFor } from "@/lib/time/zone";
import { readTimeZone, zoneLabel, zoneOptions, type ZoneOption } from "@/lib/time/zones";
import type { ActionResult } from "@/actions/company";

/**
 * Settings → Profile → Time zone (owner, 2 Oct 2026): the workspace's clock — the zone every time in it
 * is shown and read in, for everybody. Kept on the workspace itself (`Tenant.timezone`, the control
 * plane's), where requests and background jobs both find it (src/lib/time/workspace.ts).
 * `settings.manage`, as the rest of the Profile is. India's statutory dates stay on India's clock
 * whatever it says (src/lib/india-time.ts).
 */

async function settingsAdmin() {
  const user = await requireUser();
  return (await hasEffectivePermission(user.id, "settings.manage")) ? user : null;
}

export type TimeZoneSetting = {
  zone: string;
  /** False for a workspace from the server's configuration: its zone is India's, set there. */
  changeable: boolean;
  options: ZoneOption[];
};

/** For the Profile page. Null without settings.manage. */
export async function getTimeZoneSetting(): Promise<TimeZoneSetting | null> {
  if (!(await settingsAdmin())) return null;
  const tenant = await currentTenant();
  return { zone: clockFor(tenant.timezone).zone, changeable: tenant.source === "control", options: zoneOptions() };
}

export async function setWorkspaceTimeZone(input: unknown): Promise<ActionResult<null>> {
  const admin = await settingsAdmin();
  if (!admin) return { ok: false, error: "You can't change organisation settings." };
  const zone = readTimeZone((input as { zone?: unknown } | null)?.zone);
  if (!zone) return { ok: false, error: "Choose a time zone from the list." };
  const tenant = await currentTenant();
  if (tenant.source !== "control") return { ok: false, error: "This workspace's time zone is set in its server's configuration." };
  const before = clockFor(tenant.timezone).zone;
  if (before === zone) return { ok: true, data: null };

  await controlDb().tenant.update({ where: { id: tenant.id }, data: { timezone: zone } });
  // This process at once; the others within the registry's half a minute.
  forgetRegistry();
  await recordAudit({
    userId: admin.id,
    action: "UPDATE",
    entityType: "OrganisationSettings",
    entityId: "timezone",
    entityLabel: `Time zone: ${zoneLabel(before)} → ${zoneLabel(zone)}`,
  });
  // Every page shows times.
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}
