import { db } from "@/lib/db";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { tenantById } from "@/lib/tenancy/registry";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Which workspace a biometric terminal belongs to, by its serial number.
 *
 * A terminal is set up on its keypad with a server address and port — often a bare IP on the office
 * network, which names no workspace. So when a terminal's request comes in on an address that
 * reaches no workspace (a bare IP, the platform's `devices.` host), its serial decides: the control
 * plane's BiometricDeviceRoute, written when HR registers the terminal in a workspace.
 *
 * A serial belongs to one workspace. Registering one another workspace already has is refused —
 * otherwise whoever registered a serial second would receive the first's punches.
 */

export function normaliseSerial(serial: string): string {
  return serial.trim().toUpperCase();
}

export async function tenantForDeviceSerial(serial: string): Promise<Tenant | null> {
  if (!controlConfigured()) return null;
  const route = await controlDb().biometricDeviceRoute.findUnique({ where: { serial: normaliseSerial(serial) }, select: { tenantId: true } });
  return route ? tenantById(route.tenantId) : null;
}

/** When the terminal was last heard from through its route — for the console, not for correctness. */
export async function touchDeviceRoute(serial: string): Promise<void> {
  if (!controlConfigured()) return;
  await controlDb()
    .biometricDeviceRoute.updateMany({ where: { serial: normaliseSerial(serial) }, data: { lastSeenAt: new Date() } })
    .catch(() => {});
}

/** Whether serials are routed at all: only for a workspace in the control plane. */
async function routed(): Promise<Tenant | null> {
  const tenant = await currentTenant();
  return controlConfigured() && tenant.source === "control" ? tenant : null;
}

/**
 * Claims a serial for the workspace in hand. Refused when another workspace has it. A workspace
 * outside the control plane (before adoption) routes by address only, and there is nothing to claim.
 *
 * Inserted if absent and then read back, rather than read and then inserted: two workspaces claiming
 * the same serial at the same moment both succeed at the insert-if-absent, and exactly one of them
 * reads itself back as the owner.
 */
export async function claimDeviceSerial(serial: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await routed();
  if (!tenant) return { ok: true };
  const wanted = normaliseSerial(serial);
  const control = controlDb();
  await control.biometricDeviceRoute.createMany({ data: [{ serial: wanted, tenantId: tenant.id }], skipDuplicates: true });
  const owner = await control.biometricDeviceRoute.findUnique({ where: { serial: wanted }, select: { tenantId: true } });
  if (owner?.tenantId === tenant.id) return { ok: true };
  return { ok: false, error: `Serial ${wanted} is registered to another workspace. If this terminal has moved to you, ask support to release it.` };
}

/**
 * Brings this workspace's routes in line with the terminals its database now holds — after a restore or a
 * reset replaced them wholesale (owner, 22 Oct 2026). A serial no terminal here has any more is let go; one
 * a terminal here has and no route names is claimed. One another workspace has claimed since is left with
 * it and reported, as registering it would be refused. Nothing outside the control plane.
 */
export async function resyncDeviceRoutes(): Promise<{ claimed: number; released: number; elsewhere: string[] }> {
  const result = { claimed: 0, released: 0, elsewhere: [] as string[] };
  const tenant = await routed();
  if (!tenant) return result;
  const control = controlDb();
  const devices = await db.biometricDevice.findMany({ select: { serialNumber: true } });
  const wanted = new Set(devices.map((d) => normaliseSerial(d.serialNumber)).filter(Boolean));
  const routes = await control.biometricDeviceRoute.findMany({ where: { tenantId: tenant.id }, select: { serial: true } });
  const stale = routes.map((r) => r.serial).filter((serial) => !wanted.has(serial));
  if (stale.length) result.released = (await control.biometricDeviceRoute.deleteMany({ where: { tenantId: tenant.id, serial: { in: stale } } })).count;
  const have = new Set(routes.map((r) => r.serial));
  for (const serial of wanted) {
    if (have.has(serial)) continue;
    const claim = await claimDeviceSerial(serial);
    if (claim.ok) result.claimed += 1;
    else result.elsewhere.push(serial);
  }
  return result;
}

/** Lets go of a serial this workspace no longer uses — after a terminal's serial was corrected. */
export async function releaseDeviceSerial(serial: string): Promise<void> {
  const tenant = await routed();
  if (!tenant) return;
  await controlDb().biometricDeviceRoute.deleteMany({ where: { serial: normaliseSerial(serial), tenantId: tenant.id } });
}
