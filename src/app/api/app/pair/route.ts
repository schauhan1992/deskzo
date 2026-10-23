import { normaliseIp } from "@/lib/access/ip";
import { ApiError, readBody } from "@/lib/api/handler";
import { readLocation } from "@/lib/app/daily";
import { appAnswer, appErrorAnswer, appFailure, phoneLockKey } from "@/lib/app/handler";
import { pairPhone } from "@/lib/app/pairing";
import { clientIpFrom } from "@/lib/client-ip";
import { currentMaintenance } from "@/lib/maintenance";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";

/**
 * The Deskzo app pairing itself (owner, 18 Oct 2026): `{ code, platform, model?, app_version?, form_factor?,
 * verifier?, latitude?, longitude?, accuracy? }` — the code from somebody's Settings › Deskzo app page, or the one
 * their browser sign-in sent back with the secret behind its challenge (src/lib/app/pairing.ts) — for the phone's
 * token, once. Wrong codes count towards the same lockout as wrong tokens (src/lib/app/handler.ts).
 */

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const maintenance = await currentMaintenance();
    if (maintenance.phase === "on") return appFailure(503, "maintenance", maintenance.message, undefined, { "retry-after": "300" });
    const ip = normaliseIp(clientIpFrom(req.headers));
    const lockKeys = [await phoneLockKey(ip)].filter((key): key is string => !!key);
    const locked = lockoutState(lockKeys);
    if (locked.lockedOut) return appFailure(429, "too_many_failures", "Too many wrong codes from this address — wait and try again.", undefined, { "retry-after": String(Math.max(1, locked.retryInSeconds)) });

    const body = await readBody(req);
    try {
      const paired = await pairPhone(
        { code: body.code, platform: body.platform, model: body.model, appVersion: body.app_version, verifier: body.verifier, formFactor: body.form_factor, location: readLocation(body) },
        ip,
      );
      clearFailures(lockKeys);
      const tenant = await currentTenantOrNull();
      return appAnswer(201, {
        data: {
          token: paired.token,
          approved: paired.approved,
          person: paired.person,
          workspace: { name: tenant?.name ?? null },
        },
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "wrong_code") recordFailure(lockKeys);
      throw err;
    }
  } catch (err) {
    return appErrorAnswer(err);
  }
}
