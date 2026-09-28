import { createRequire } from "node:module";
import { classifyHost, normaliseHost } from "@/lib/tenancy/host";
import { tenancyState } from "@/lib/tenancy/state";

/**
 * Every log line says which workspace it is about: "[acme] …".
 *
 *   · Scripts, workers, scheduled fan-outs and the proxy run as a workspace explicitly
 *     (runAsTenant), and are labelled with it.
 *   · A page, an action or an API route is labelled from the address it was asked on, read from
 *     Next's request store — synchronously, because a log call cannot wait for `headers()`.
 *   · The platform's own addresses are labelled "platform"; anything else goes unlabelled.
 *
 * Only ever a label: nothing here is used to decide which workspace's data is read, so reading
 * Next's request store (an internal module, loaded carefully) can at worst leave a line unlabelled.
 */

type Labelled = { installed: boolean };
const KEY = Symbol.for("wroffy.log-labels");
const state = (): Labelled => ((globalThis as Record<symbol, Labelled>)[KEY] ??= { installed: false });

type RequestStoreLike = { type?: string; headers?: { get(name: string): string | null } };
let requestStore: { getStore(): RequestStoreLike | undefined } | null | undefined;

function nextRequestStore(): RequestStoreLike | undefined {
  if (requestStore === undefined) {
    try {
      const load = createRequire(`${process.cwd()}/package.json`);
      requestStore = (load("next/dist/server/app-render/work-unit-async-storage.external") as { workUnitAsyncStorage: typeof requestStore }).workUnitAsyncStorage ?? null;
    } catch {
      requestStore = null;
    }
  }
  try {
    return requestStore?.getStore();
  } catch {
    return undefined;
  }
}

/** The label for a host: the workspace's slug for its subdomain, the host itself for a custom one. */
export function labelForHost(rawHost: string | null | undefined): string | null {
  const host = normaliseHost(rawHost ?? null);
  if (!host) return null;
  const kind = classifyHost(host);
  if (kind.kind === "tenant") return kind.slug;
  if (kind.kind === "root" || kind.kind === "console" || kind.kind === "cms" || kind.kind === "partners") return "platform";
  return host;
}

/** What this moment's log lines are about, or null. */
export function currentLogLabel(): string | null {
  const explicit = tenancyState().als.getStore();
  if (explicit) return explicit.slug;
  const store = nextRequestStore();
  if (store?.headers) return labelForHost(store.headers.get("host"));
  return null;
}

/** Wraps console once per process, so every line carries its label. Idempotent. */
export function installLogLabels(): void {
  if (state().installed) return;
  state().installed = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      let label: string | null = null;
      try {
        label = currentLogLabel();
      } catch {
        label = null;
      }
      if (!label) return original(...args);
      // Already labelled by its writer (onRequestError in src/instrumentation.ts): once is enough.
      if (typeof args[0] === "string" && args[0].startsWith(`[${label}]`)) return original(...args);
      if (typeof args[0] === "string") return original(`[${label}] ${args[0]}`, ...args.slice(1));
      return original(`[${label}]`, ...args);
    };
  }
}
