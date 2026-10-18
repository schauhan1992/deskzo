import { ZodError } from "zod";
import { db } from "@/lib/db";
import { normaliseIp } from "@/lib/access/ip";
import { runAsApiActor, type ApiActor } from "@/lib/api/actor";
import { ApiError, personRefusal, readBody, zodFields, type PersonRefusal } from "@/lib/api/handler";
import { parsePhoneToken, secretMatches } from "@/lib/app/tokens";
import { clientIpFrom } from "@/lib/client-ip";
import { currentMaintenance } from "@/lib/maintenance";
import { moduleAccessFor } from "@/lib/modules-access";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { UnauthorizedError } from "@/lib/session";
import { tenantKey } from "@/lib/tenancy/cache";

/**
 * Every call from the Deskzo app (owner, 18 Oct 2026) — /api/app/* — goes through `appRoute`, in this order:
 *
 *   1. The workspace not under maintenance.
 *   2. The phone: `Authorization: Bearer dzp_<app device>.<secret>`, its secret matching the device row's
 *      digest, the device not revoked or turned down. Every way of being wrong answers the same 401, and
 *      too many from one address lock it out for a while. A phone still waiting for an administrator's
 *      approval is told so.
 *   3. Its person: active, a member, not locked, the company not locked, allowed in from this network —
 *      the API's check (src/lib/api/handler.ts `personRefusal`), with the phone as the approved device a
 *      role may ask for.
 *   4. The rate: so many calls a minute per phone, counted in the database.
 *   5. Calls, for a route that needs them: in the plan, switched on, and the person's to open.
 *   6. The call itself, as the phone's person (src/lib/api/actor.ts, channel "app") — through the app's own
 *      rules, so their permissions, reach and masking apply as on the screens.
 *
 * Answers are JSON: `{ data }`, or `{ error: { code, message, fields? } }`. Unlike the public API these
 * routes are the app's own, changed with it; nothing outside the app calls them.
 */

export const APP_RATE_PER_MINUTE = 300;

export type AppDeviceFacts = { id: string; userDeviceId: string; platform: string; model: string | null; callSync: boolean; createdAt: Date };

export type AppCall = {
  req: Request;
  url: URL;
  params: Record<string, string>;
  actor: ApiActor;
  device: AppDeviceFacts;
  body: () => Promise<Record<string, unknown>>;
};

type RouteOptions = { calls?: boolean };
type RouteContext = { params?: Promise<Record<string, string | string[]>> };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export function appAnswer(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export const appFailure = (status: number, code: string, message: string, fields?: Record<string, string>, headers: Record<string, string> = {}) =>
  appAnswer(status, { error: { code, message, ...(fields ? { fields } : {}) } }, headers);

const SIGNED_OUT = () => appFailure(401, "signed_out", "This phone isn't signed in to Deskzo any more. Pair it again from Settings › Deskzo app.");

/** The person's standing, in words for the person holding the phone. */
export const PHONE_REFUSALS: Record<PersonRefusal, string> = {
  switched_off: "Your Deskzo account is switched off.",
  locked: "Your Deskzo account is locked for now.",
  workspace_locked: "Deskzo is locked for everybody here for now.",
  network: "You may not use Deskzo from this network.",
  device: "Your role only allows approved devices, and this phone isn't one yet.",
  location: "Your role asks for your location at every sign-in, which the Deskzo app can't share yet.",
};

/** A thrown error as the phone sees it — never a stack, never a database message. */
export function appErrorAnswer(err: unknown): Response {
  if (err instanceof ApiError) return appFailure(err.status, err.code, err.message, err.fields);
  if (err instanceof ZodError) return appFailure(400, "invalid_request", err.issues[0]?.message ?? "The request isn't valid.", zodFields(err));
  if (err instanceof UnauthorizedError) return appFailure(403, "forbidden", "You may not do that.");
  console.error("[app] call failed", err);
  return appFailure(500, "internal", "Something went wrong on our side. Try again in a moment.");
}

/** One more call in this phone's minute; how many it has made in it. One statement, so every server counts the same. */
async function countCall(appDeviceId: string): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    UPDATE "app_devices" SET
      "windowCount" = CASE WHEN "windowStart" > (timezone('utc', now()) - interval '60 seconds') THEN "windowCount" + 1 ELSE 1 END,
      "windowStart" = CASE WHEN "windowStart" > (timezone('utc', now()) - interval '60 seconds') THEN "windowStart" ELSE timezone('utc', now()) END
    WHERE "id" = ${appDeviceId}
    RETURNING "windowCount"::int AS n`;
  return Number(rows[0]?.n ?? 0);
}

/** The lockout bucket for wrong tokens and wrong pairing codes from one address. */
export async function phoneLockKey(ip: string | null): Promise<string> {
  return `${await tenantKey()}|app|${ip ?? "unknown"}`;
}

/** A /api/app route handler. The handler runs as the phone's person and returns `{ data }`, or throws an `ApiError`. */
export function appRoute(options: RouteOptions, handler: (call: AppCall) => Promise<{ status?: number; data: unknown }>) {
  return async (req: Request, context?: RouteContext): Promise<Response> => {
    try {
      const maintenance = await currentMaintenance();
      if (maintenance.phase === "on") return appFailure(503, "maintenance", maintenance.message, undefined, { "retry-after": "300" });

      const ip = normaliseIp(clientIpFrom(req.headers));
      const lockKey = await phoneLockKey(ip);
      const locked = lockoutState([lockKey]);
      if (locked.lockedOut) return appFailure(429, "too_many_failures", "Too many wrong sign-ins from this address — wait and try again.", undefined, { "retry-after": String(Math.max(1, locked.retryInSeconds)) });

      const token = parsePhoneToken(req.headers.get("authorization"));
      const phone = token
        ? await db.appDevice.findUnique({
            where: { id: token.appDeviceId },
            select: {
              id: true,
              platform: true,
              model: true,
              callSync: true,
              createdAt: true,
              device: { select: { id: true, tokenHash: true, status: true, lastSeenAt: true, lastIp: true } },
              user: { select: { id: true, name: true, email: true, role: true, isSuperAdmin: true, active: true, kind: true, lockedAt: true, lockedUntil: true } },
            },
          })
        : null;
      // A digest is always worked out, so a phone that doesn't exist takes as long as one that does.
      const matches = secretMatches(token?.secret ?? "x".repeat(43), phone?.device.tokenHash ?? "0".repeat(64));
      if (!token || !phone || !matches || phone.device.status === "REVOKED" || phone.device.status === "REJECTED") {
        recordFailure([lockKey]);
        return SIGNED_OUT();
      }
      clearFailures([lockKey]);
      if (phone.device.status === "PENDING") return appFailure(403, "device_pending", "This phone is waiting for an administrator to approve it. You'll be able to use it once they have.");

      const refusal = await personRefusal(phone.user, ip, true);
      if (refusal) return appFailure(403, "person_not_allowed", PHONE_REFUSALS[refusal]);

      const used = await countCall(phone.id);
      if (used > APP_RATE_PER_MINUTE) return appFailure(429, "rate_limited", "Too many requests from this phone — wait a moment.", undefined, { "retry-after": "60" });

      // Where it was last seen, as for any device — not on every call.
      const now = new Date();
      if (phone.device.lastIp !== ip || now.getTime() - phone.device.lastSeenAt.getTime() > 5 * 60_000) {
        await db.userDevice.update({ where: { id: phone.device.id }, data: { lastSeenAt: now, lastIp: ip } }).catch(() => {});
      }

      const url = new URL(req.url);
      const raw = (await context?.params) ?? {};
      const params = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.join("/") : String(v)]));
      const user = phone.user;
      const actor: ApiActor = { userId: user.id, name: user.name, email: user.email, role: user.role, keyId: phone.id, keyName: phone.model ?? phone.platform, scopes: [], channel: "app" };
      const device: AppDeviceFacts = { id: phone.id, userDeviceId: phone.device.id, platform: phone.platform, model: phone.model, callSync: phone.callSync, createdAt: phone.createdAt };

      try {
        const out = await runAsApiActor(actor, async () => {
          if (options.calls) {
            const access = await moduleAccessFor(user.id, "calls");
            if (access !== "available") throw new ApiError(403, "calls_unavailable", access === "no-permission" ? "You can't use Calls in Deskzo." : "Calls aren't switched on in this workspace.");
          }
          return handler({ req, url, params, actor, device, body: () => readBody(req) });
        });
        return appAnswer(out.status ?? 200, { data: out.data });
      } catch (err) {
        return appErrorAnswer(err);
      }
    } catch (err) {
      return appErrorAnswer(err);
    }
  };
}
