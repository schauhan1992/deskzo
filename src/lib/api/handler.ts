import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { db } from "@/lib/db";
import { networkStanding } from "@/lib/access/decide";
import { activeIpRules, rolePolicy } from "@/lib/access/gate";
import { companyLock, companyLockActive, personalLockActive } from "@/lib/access/lock";
import { normaliseIp } from "@/lib/access/ip";
import { runAsApiActor, type ApiActor } from "@/lib/api/actor";
import { apiSecretMatches, parseBearer } from "@/lib/api/keys";
import { API_IDEMPOTENCY_HOURS, API_MAX_BODY_BYTES, API_RATE_PER_MINUTE, type ApiScope } from "@/lib/api/scopes";
import { clientIpFrom } from "@/lib/client-ip";
import { currentMaintenance } from "@/lib/maintenance";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { UnauthorizedError } from "@/lib/session";
import { tenantKey } from "@/lib/tenancy/cache";

/**
 * Every public API call (owner, 17 Oct 2026) — /api/v1/* — goes through `apiRoute`, in this order:
 *
 *   1. The workspace not under maintenance.
 *   2. The key: `Authorization: Bearer dzk_….dzs_…`, live, not expired, its secret matching. Every way
 *      of being wrong answers the same 401, and too many from one address lock it out for a while.
 *   3. Its person: active, a member, not locked, the company not locked, and allowed in from this
 *      network — the sign-in door check. A role that admits only approved devices, or asks for the
 *      location, admits no key: a key has neither.
 *   4. The scope the call needs, among the key's.
 *   5. The rate: so many calls a minute per key, counted in the database so every server agrees.
 *   6. A create or change sent with `Idempotency-Key` that was answered before: that answer again.
 *   7. The call itself, as the key's person (src/lib/api/actor.ts) — through the app's own actions,
 *      so their permissions, reach and masking apply as on the screens.
 *
 * Answers are JSON: `{ data }` (a list: `{ data, page }`), or `{ error: { code, message, fields? } }`.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `No ${what} by that reference reaches this key.`);

export type ApiPage = { page: number; page_size: number; total: number; has_more: boolean };
export type ApiAnswer = { status?: number; data: unknown; page?: ApiPage };

export type ApiCall = {
  req: Request;
  url: URL;
  params: Record<string, string>;
  actor: ApiActor;
  /** The request body, read and size-checked; `{}` when there is none. */
  body: () => Promise<Record<string, unknown>>;
};

type RouteOptions = { scope: ApiScope | null };
type RouteContext = { params?: Promise<Record<string, string | string[]>> };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function answer(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...headers } });
}

const failure = (status: number, code: string, message: string, fields?: Record<string, string>, headers: Record<string, string> = {}) =>
  answer(status, { error: { code, message, ...(fields ? { fields } : {}) } }, headers);

const UNAUTHORIZED = () => failure(401, "unauthorized", "The API key is missing, wrong, expired or revoked.", undefined, { "www-authenticate": 'Bearer realm="Deskzo API"' });

export type PersonRefusal = "switched_off" | "locked" | "workspace_locked" | "network" | "device" | "location";

/**
 * What a person's standing says about acting as them now, from `ip` — null when they may. Shared with the
 * Deskzo app (src/lib/app/handler.ts), whose phone is a device of its own: `approvedDevice` says it has
 * been approved, which answers a role that admits only approved devices. Nothing answers one that asks
 * for the location at every sign-in.
 */
export async function personRefusal(
  user: { id: string; role: string; isSuperAdmin: boolean; active: boolean; kind: string; lockedAt: Date | null; lockedUntil: Date | null },
  ip: string | null,
  approvedDevice = false,
): Promise<PersonRefusal | null> {
  if (!user.active || user.kind !== "MEMBER") return "switched_off";
  if (personalLockActive(user)) return "locked";
  if (user.isSuperAdmin) return null;
  if (companyLockActive(await companyLock())) return "workspace_locked";
  // The sign-in door check (src/lib/access/record.ts `doorCheck`), on this request's own address.
  const [rules, policy] = await Promise.all([activeIpRules(), rolePolicy(user.role)]);
  const network = networkStanding(ip, user.role, rules, new Date());
  if (network.standing === "BLOCKED" || (network.standing === "UNKNOWN" && policy.unknownNetwork === "BLOCK")) return "network";
  if (policy.requireDeviceApproval && !approvedDevice) return "device";
  if (policy.requireLocation) return "location";
  return null;
}

const KEY_REFUSALS: Record<PersonRefusal, string> = {
  switched_off: "The key's person is switched off.",
  locked: "The key's person is locked out for now.",
  workspace_locked: "The workspace is locked for now.",
  network: "The key's person may not use Deskzo from this network.",
  device: "The key's person may only use Deskzo from an approved device — an API key can't be one.",
  location: "The key's person may only use Deskzo from an approved device — an API key can't be one.",
};

/** One more call in this key's minute; how many it has made in it. One statement, so every server counts the same. */
async function countCall(keyId: string, ip: string | null): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    UPDATE "api_keys" SET
      "windowCount" = CASE WHEN "windowStart" > (timezone('utc', now()) - interval '60 seconds') THEN "windowCount" + 1 ELSE 1 END,
      "windowStart" = CASE WHEN "windowStart" > (timezone('utc', now()) - interval '60 seconds') THEN "windowStart" ELSE timezone('utc', now()) END,
      "lastUsedAt" = timezone('utc', now()),
      "lastUsedIp" = ${ip},
      "useCount" = "useCount" + 1
    WHERE "id" = ${keyId}
    RETURNING "windowCount"::int AS n`;
  return Number(rows[0]?.n ?? 0);
}

/** The request's JSON object, size-checked; `{}` when there is none. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > API_MAX_BODY_BYTES) throw new ApiError(413, "too_large", `The body is over ${API_MAX_BODY_BYTES / 1024} KB.`);
  if (!text.trim()) return {};
  const type = req.headers.get("content-type") ?? "";
  if (!/application\/json/i.test(type)) throw new ApiError(415, "unsupported_media_type", "Send the body as application/json.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "The body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "invalid_body", "The body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

/** The fields a validation error names, by field — the first message for each. */
export function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) fields[issue.path.join(".") || "body"] ??= issue.message;
  return fields;
}

/** A thrown error as the caller sees it — never a stack, never a database message. */
function asFailure(err: unknown): Response {
  if (err instanceof ApiError) return failure(err.status, err.code, err.message, err.fields);
  if (err instanceof ZodError) return failure(400, "invalid_request", err.issues[0]?.message ?? "The request isn't valid.", zodFields(err));
  if (err instanceof UnauthorizedError) return failure(403, "forbidden", "The key's person may not do that.");
  console.error("[api] call failed", err);
  return failure(500, "internal", "Something went wrong on our side. Try again; if it keeps happening, write to support.");
}

const IDEMPOTENT = /^(POST|PATCH)$/;

/**
 * A /api/v1 route handler. `scope` is the one the call needs (null: any live key — /me). The handler
 * runs as the key's person and returns `{ data }` (a list adds `page`), or throws an `ApiError`.
 */
export function apiRoute(options: RouteOptions, handler: (call: ApiCall) => Promise<ApiAnswer>) {
  return async (req: Request, context?: RouteContext): Promise<Response> => {
    try {
      const maintenance = await currentMaintenance();
      if (maintenance.phase === "on") return failure(503, "maintenance", maintenance.message, undefined, { "retry-after": "300" });

      const ip = normaliseIp(clientIpFrom(req.headers));
      const lockKey = `${await tenantKey()}|api|${ip ?? "unknown"}`;
      const locked = lockoutState([lockKey]);
      if (locked.lockedOut) return failure(429, "too_many_failures", "Too many wrong keys from this address — wait and try again.", undefined, { "retry-after": String(Math.max(1, locked.retryInSeconds)) });

      // The key. A digest is always worked out, so a key ID that doesn't exist takes as long as one that does.
      const token = parseBearer(req.headers.get("authorization"));
      const key = token
        ? await db.apiKey.findUnique({
            where: { keyId: token.keyId },
            select: {
              id: true,
              name: true,
              keyId: true,
              secretDigest: true,
              scopes: true,
              expiresAt: true,
              revokedAt: true,
              user: { select: { id: true, name: true, email: true, role: true, isSuperAdmin: true, active: true, kind: true, lockedAt: true, lockedUntil: true } },
            },
          })
        : null;
      const matches = await apiSecretMatches(token?.secret ?? "dzs_none", key?.secretDigest ?? "x".repeat(44));
      const now = new Date();
      if (!token || !key || !matches || key.revokedAt || (key.expiresAt && key.expiresAt <= now)) {
        recordFailure([lockKey]);
        return UNAUTHORIZED();
      }
      clearFailures([lockKey]);

      const refusal = await personRefusal(key.user, ip);
      if (refusal) return failure(403, "person_not_allowed", KEY_REFUSALS[refusal]);
      if (options.scope && !key.scopes.includes(options.scope)) return failure(403, "insufficient_scope", `This key isn't allowed ${options.scope}. Give it that in Settings › Developers & API, or make a key that has it.`);

      const used = await countCall(key.id, ip);
      const rateHeaders = { "x-ratelimit-limit": String(API_RATE_PER_MINUTE), "x-ratelimit-remaining": String(Math.max(0, API_RATE_PER_MINUTE - used)) };
      if (used > API_RATE_PER_MINUTE) return failure(429, "rate_limited", `More than ${API_RATE_PER_MINUTE} calls a minute from this key — wait a moment.`, undefined, { ...rateHeaders, "retry-after": "60" });

      const url = new URL(req.url);
      const raw = (await context?.params) ?? {};
      const params = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.join("/") : String(v)]));

      // A retry of a create or change answered before gets that answer — and one still running, a 409.
      const idemKey = IDEMPOTENT.test(req.method) ? req.headers.get("idempotency-key")?.trim() : null;
      if (idemKey !== null && idemKey !== undefined && (idemKey.length < 8 || idemKey.length > 100)) return failure(400, "invalid_idempotency_key", "An Idempotency-Key is 8 to 100 characters.");
      let holding: string | null = null;
      if (idemKey) {
        await db.apiIdempotency.deleteMany({ where: { apiKeyId: key.id, createdAt: { lt: new Date(now.getTime() - API_IDEMPOTENCY_HOURS * 3_600_000) } } });
        try {
          holding = (await db.apiIdempotency.create({ data: { apiKeyId: key.id, key: idemKey, method: req.method, path: url.pathname, status: 0, body: {} }, select: { id: true } })).id;
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
          const before = await db.apiIdempotency.findUnique({ where: { apiKeyId_key: { apiKeyId: key.id, key: idemKey } } });
          if (!before) return failure(409, "conflict", "Try again in a moment.");
          if (before.method !== req.method || before.path !== url.pathname) return failure(422, "idempotency_key_reused", "That Idempotency-Key was used for a different request.");
          if (before.status === 0) return failure(409, "in_progress", "The same request is still being handled — try again in a moment.");
          return answer(before.status, before.body, { ...rateHeaders, "idempotent-replayed": "true" });
        }
      }

      const actor: ApiActor = { userId: key.user.id, name: key.user.name, email: key.user.email, role: key.user.role, keyId: key.keyId, keyName: key.name, scopes: key.scopes };
      let result: Response;
      try {
        const out = await runAsApiActor(actor, () => handler({ req, url, params, actor, body: () => readBody(req) }));
        const payload = out.page ? { data: out.data, page: out.page } : { data: out.data };
        result = answer(out.status ?? 200, payload, rateHeaders);
        if (holding) await db.apiIdempotency.update({ where: { id: holding }, data: { status: out.status ?? 200, body: payload as Prisma.InputJsonValue } });
      } catch (err) {
        // Not done: the same key may be tried again.
        if (holding) await db.apiIdempotency.delete({ where: { id: holding } }).catch(() => {});
        const failed = asFailure(err);
        failed.headers.set("x-ratelimit-limit", rateHeaders["x-ratelimit-limit"]);
        failed.headers.set("x-ratelimit-remaining", rateHeaders["x-ratelimit-remaining"]);
        return failed;
      }
      return result;
    } catch (err) {
      return asFailure(err);
    }
  };
}

/** `?page=` and `?page_size=` read and bounded. */
export function paging(url: URL, max: number, fallback: number): { page: number; pageSize: number } {
  const page = Math.max(1, Math.min(100_000, Math.floor(Number(url.searchParams.get("page") ?? 1)) || 1));
  const size = Math.floor(Number(url.searchParams.get("page_size") ?? fallback)) || fallback;
  return { page, pageSize: Math.max(1, Math.min(max, size)) };
}

export const pageOf = (page: number, pageSize: number, total: number): ApiPage => ({ page, page_size: pageSize, total, has_more: page * pageSize < total });

/** An action's `{ ok: false, error }` as a 422 — refused by the app's own rules, in its own words. */
export function refusedBy(result: { ok: false; error: string }): ApiError {
  return new ApiError(422, "refused", result.error);
}
