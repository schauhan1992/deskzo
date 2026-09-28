import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { platformBrandName } from "@/lib/platform/brand";
import { controlConfigured } from "@/lib/platform/control-db";
import { dlpApplies, hasAnyDeterrent } from "@/lib/security/policy";
import { getSecurityPolicy } from "@/lib/security/store";
import { currentUser, viewAsContext } from "@/lib/session";
import { cachedSupportConfig, getSupportSettings, type SupportConfig } from "@/lib/support/settings";
import type { RecordingBlockedReason } from "@/lib/support/types";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Who is asking for support, and whether they may — the one answer the launcher, the upload route and
 * the submit action all work from, so the three can never disagree.
 *
 * Anybody signed in to a workspace may ask, except:
 *
 *   · somebody viewing as another person — a request would go out in that person's name;
 *   · platform support staff inside a workspace on its grant (User.kind SUPPORT) — they are us;
 *   · anyone, while `support.enabled` is off, or where there is no control plane to keep requests in
 *     (a workspace read from the environment, before adoption, has no row to hang them on).
 *
 * The workspace is `currentTenant()` and the person is the session's — never anything the browser
 * sends. Recording is offered unless the console switched it off, or this workspace's copy/print
 * deterrents apply to this person (as the dashboard layout works that out for DlpGuard): an
 * organisation that stops its people copying text would not want videos of their screens leaving.
 */

export type Requester = {
  tenant: Tenant;
  user: { id: string; name: string; email: string; role: string; phone: string | null };
  config: SupportConfig;
  recording: { allowed: boolean; blockedReason: RecordingBlockedReason };
};

export type RequesterResult = { ok: true; requester: Requester } | { ok: false; status: number; error: string };

const refuse = (status: number, error: string): RequesterResult => ({ ok: false, status, error });

/**
 * `fresh`: read the settings from the database (sending, uploading) rather than the minute-long copy
 * the layout uses on every page. Throws only on a fault reading the workspace's own database; every
 * expected "no" is a result.
 */
export async function resolveRequester({ fresh }: { fresh: boolean }): Promise<RequesterResult> {
  const session = await auth();
  if (!session?.user?.id) return refuse(401, "Sign in first.");
  if (await viewAsContext()) return refuse(403, "You're viewing as someone else. Switch back to yourself to contact support.");
  // The access gate too (src/lib/session.ts): a person held there is nobody here.
  const user = await currentUser();
  if (!user || user.id !== session.user.id) return refuse(401, "Sign in first.");

  const account = await db.user.findUnique({ where: { id: user.id }, select: { kind: true, phone: true, active: true } });
  // Unknown or switched off fails closed, like a support account.
  if (!account || !account.active) return refuse(401, "Sign in first.");
  if (account.kind === "SUPPORT") return refuse(403, "Platform support can't raise a support request from inside a workspace.");

  const tenant = await currentTenant();
  if (tenant.source !== "control" || !controlConfigured()) return refuse(403, "Contact support isn't available here.");

  let config: SupportConfig | null;
  if (fresh) {
    try {
      const [settings, brandName] = await Promise.all([getSupportSettings(), platformBrandName()]);
      config = { ...settings, brandName };
    } catch {
      config = null;
    }
  } else {
    config = await cachedSupportConfig();
  }
  if (!config) return refuse(503, "Contact support can't be reached right now — please try again in a minute, or call the helpline.");
  if (!config.enabled) return refuse(403, "Contact support isn't available right now.");

  const policy = await getSecurityPolicy();
  // Recording is refused for the restrictions an admin chose (blocking copy, print and the like, or no
  // screenshots at all), not for the daily screenshot allowance every workspace starts with: counted,
  // that default would refuse recording to everyone but admins in a workspace nobody configured (the
  // owner's decision, option A).
  const chosen = hasAnyDeterrent({ ...policy, screenshotLimitPerDay: -1 }) || policy.screenshotLimitPerDay === 0;
  const dlp = dlpApplies(user.role, policy) && chosen;
  const blockedReason: RecordingBlockedReason = !config.recording ? "setting" : dlp ? "dlp" : null;

  return {
    ok: true,
    requester: {
      tenant,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: account.phone?.trim() || null },
      config,
      recording: { allowed: blockedReason === null, blockedReason },
    },
  };
}
