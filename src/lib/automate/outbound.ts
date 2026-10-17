import { createHmac } from "node:crypto";
import { safeFetch, SafeFetchError, type SafeFetchOptions, type SafeResponse } from "@/lib/net/safe-fetch";
import { currentKeys } from "@/lib/tenancy/keys";
import { ActionError, type ActionContext, type FailureKind } from "@/lib/automate/action-types";

/**
 * Every call Deskzo Automate makes to the outside world (Phase 4) — a webhook, an HTTP API, Slack,
 * Teams, Google Sheets — goes through here, behind the outbound guard (src/lib/net/safe-fetch.ts):
 * https only; the name resolved first and a private, loopback, link-local or cloud-metadata address
 * refused, the connection pinned to the address checked; at most 3 redirects, each checked again; 15
 * seconds; 1 MB of answer.
 *
 * Each call carries the step's `Idempotency-Key` (the same on every try of the step), and — unless the
 * step says not to — the workspace's signature, so the receiver can tell it came from here:
 *
 *   X-Deskzo-Timestamp: <unix seconds>
 *   X-Deskzo-Signature: hex HMAC-SHA256 of "<timestamp>.<body>" with the workspace's signing secret
 *
 * The secret is the workspace's own, derived from its keys like the marketing webhook secret
 * (src/lib/marketing/webhook-secret.ts), and shown to its admins under Automate › Connections.
 */

export const OUTBOUND_LIMITS = { timeoutMs: 15_000, maxBytes: 1_000_000, maxRedirects: 3 } as const;

/** The workspace's secret for signing what Automate sends. */
export async function automateSigningSecret(): Promise<string> {
  const { digestKey } = await currentKeys();
  return createHmac("sha256", digestKey).update("deskzo/automate-outbound").digest("base64url").slice(0, 40);
}

export function signature(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

type TestOutbound = Partial<SafeFetchOptions> & {
  /** Where a real address goes instead — https://hooks.slack.com/… to the stand-in's /slack/…. */
  rewrite?: (url: string) => string;
};
let testOutbound: TestOutbound | null = null;
/** For check suites: reach a stand-in on this machine (http, 127.0.0.1, its port). Never set elsewhere. */
export function setTestOutbound(options: TestOutbound | null) {
  testOutbound = options;
}

export type OutboundRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Signed with the workspace's secret. */
  sign?: boolean;
};

/** One call, as a step makes it. Throws `SafeFetchError` for what never got as far as an answer. */
export async function outboundFetch(ctx: Pick<ActionContext, "key">, request: OutboundRequest): Promise<SafeResponse> {
  const body = request.method === "GET" ? undefined : (request.body ?? "");
  const headers: Record<string, string> = { "user-agent": "Deskzo-Automate/1", "idempotency-key": ctx.key, ...(request.headers ?? {}) };
  if (request.sign) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers["x-deskzo-timestamp"] = timestamp;
    headers["x-deskzo-signature"] = signature(await automateSigningSecret(), timestamp, body ?? "");
  }
  const { rewrite, ...testOptions } = testOutbound ?? {};
  return safeFetch(rewrite ? rewrite(request.url) : request.url, {
    method: request.method,
    body,
    headers,
    protocols: ["https:"],
    timeoutMs: OUTBOUND_LIMITS.timeoutMs,
    maxBytes: OUTBOUND_LIMITS.maxBytes,
    maxRedirects: OUTBOUND_LIMITS.maxRedirects,
    ...testOptions,
  });
}

/** How an answer's status should be treated: done, worth another try later, or refused for good. */
export function statusKind(status: number): "ok" | Exclude<FailureKind, "UNKNOWN"> {
  if (status >= 200 && status < 300) return "ok";
  return status === 408 || status === 425 || status === 429 || status >= 500 ? "TRANSIENT" : "PERMANENT";
}

/**
 * A guard's refusal or a call that never got an answer, as an action's failure. A refused address
 * never changes; a timeout or a dropped connection after the request went out leaves it unknown
 * whether the other end acted on it — for a call that changes something, a person decides (UNKNOWN).
 */
export function failureOf(err: unknown, changes: boolean): ActionError {
  if (err instanceof SafeFetchError) {
    if (err.code === "bad-url" || err.code === "bad-port" || err.code === "blocked-address" || err.code === "no-address" || err.code === "too-many-redirects") {
      return new ActionError(err.message, "PERMANENT");
    }
    return new ActionError(`${err.message} — it isn't known whether the other end acted on it.`, changes ? "UNKNOWN" : "TRANSIENT");
  }
  return new ActionError(err instanceof Error ? err.message : String(err), changes ? "UNKNOWN" : "TRANSIENT");
}

/** An answer's body as data a later step can read: parsed JSON, or the text (cut to 20,000 characters). */
export function answerBody(response: SafeResponse): unknown {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      return JSON.parse(response.body);
    } catch {
      /* not JSON after all: the text */
    }
  }
  return response.body.slice(0, 20_000);
}
