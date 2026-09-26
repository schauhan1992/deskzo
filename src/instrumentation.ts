/**
 * Runs once as the Next server starts, before it answers anything.
 *
 * Marks the process as the Next server, which is what switches the tenancy fallback off
 * (src/lib/tenancy/resolve.ts): scripts and check suites may act as the first workspace when
 * nothing says otherwise; a server answering real requests may not.
 *
 * And labels every log line with the workspace it is about (src/lib/tenancy/log-labels.ts).
 */
export async function register() {
  (globalThis as { __wroffyInNext?: boolean }).__wroffyInNext = true;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installLogLabels } = await import("@/lib/tenancy/log-labels");
    installLogLabels();
  }
}

/**
 * An error Next caught while answering: one line naming the workspace it happened in, the route and
 * the digest the user was shown — so a report of "something went wrong" can be found.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routePath: string; routeType: string },
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { labelForHost } = await import("@/lib/tenancy/log-labels");
  const host = request.headers.host;
  const label = labelForHost(Array.isArray(host) ? host[0] : host) ?? "unknown";
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : "";
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${label}] ${context.routeType} error on ${request.method} ${request.path} (${context.routePath})${digest ? ` digest=${digest}` : ""}: ${message.split("\n")[0]}`);
}
