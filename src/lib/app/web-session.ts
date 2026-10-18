import { db } from "@/lib/db";
import { hashDeviceToken, newDeviceToken } from "@/lib/access/device-token";
import { ApiError } from "@/lib/api/handler";
import { createHandoffTicket } from "@/lib/platform/handoff";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";
import { safeAppPath } from "@/lib/app/paths";

export { safeAppPath };

/**
 * All of Deskzo inside the app (owner, 18 Oct 2026): the app shows the workspace's own pages, signed in by the
 * paired phone, and as that phone.
 *
 *   · The pages are the same device as the phone — the phone's own row in Security › Devices. Their device
 *     cookie is a fresh secret for that row, made each time they are opened here (and the row's tokenHash moved
 *     to it), so approving the phone, or revoking it, is the same for both, at once.
 *   · They are signed in with a one-time pass (src/lib/platform/handoff.ts, purpose "app") through the usual
 *     sign-in, door check and all — but never round two-factor: somebody with it signs in on the pages once, as
 *     on any new device.
 *   · The app's own secret (/api/app) is a different one, kept on AppDevice.secretDigest: neither stands in for
 *     the other.
 *
 * The opening is a form POST from the app to /api/app/web-open, which sets the cookie and sends the pages on.
 */

export async function openWebPages(phone: { userDeviceId: string }, userId: string, path: unknown) {
  const tenant = await currentTenantOrNull();
  if (!tenant) throw new ApiError(404, "not_found", "No such workspace.");
  const person = await db.user.findUnique({ where: { id: userId }, select: { email: true, twoFactorEnabledAt: true } });
  if (!person) throw new ApiError(401, "signed_out", "This phone isn't signed in to Deskzo any more.");
  const deviceToken = newDeviceToken();
  await db.$transaction(async (tx) => {
    // A phone paired before it had a secret of its own signs in with its device row's: that becomes its own
    // first, so moving the row's to the pages doesn't sign the phone out.
    const app = await tx.appDevice.findUnique({ where: { deviceId: phone.userDeviceId }, select: { id: true, secretDigest: true, device: { select: { tokenHash: true } } } });
    if (app && !app.secretDigest) await tx.appDevice.update({ where: { id: app.id }, data: { secretDigest: app.device.tokenHash } });
    await tx.userDevice.update({ where: { id: phone.userDeviceId }, data: { tokenHash: hashDeviceToken(deviceToken) } });
  });
  const ticket = person.twoFactorEnabledAt ? null : await createHandoffTicket(tenant.id, person.email, "app");
  return { deviceToken, ticket, next: safeAppPath(path) ?? "/dashboard" };
}
