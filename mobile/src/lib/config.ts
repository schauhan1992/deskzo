import Constants from "expo-constants";

/** A development build (DESKZO_APP_DEV=1, app.config.ts): may reach a Deskzo on this computer. */
export const DEV = Constants.expoConfig?.extra?.dev === true;

export const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";

/**
 * Where a workspace is, from its address as the pairing code carries it ("acme.deskzo.com"). A release build
 * only ever talks HTTPS. A development build reaches a `*.localhost` workspace on this computer from the
 * Android emulator, at 10.0.2.2, naming the workspace in the Host header.
 */
export function workspaceAddress(value: string): { baseUrl: string; host: string | null } | null {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{2,5})?$/.test(host)) return null;
  if (/\.localhost(:\d+)?$/.test(host)) {
    if (!DEV) return null;
    return { baseUrl: `http://10.0.2.2:${host.split(":")[1] ?? "80"}`, host };
  }
  return { baseUrl: `https://${host}`, host: null };
}

/**
 * Where the workspace's own pages are, for the app's page view. A development build's `*.localhost` workspace is
 * opened by its own name — the emulator's browser engine takes *.localhost to be the phone itself, reached on this
 * computer through `adb reverse tcp:3000 tcp:3000`.
 */
export function webOrigin(session: { baseUrl: string; host: string | null }): string {
  return session.host ? `http://${session.host}` : session.baseUrl;
}

/** `deskzo://pair?host=…&code=…`, as the QR on Settings › Deskzo app carries it. */
export function readPairingLink(text: string): { host: string; code: string } | null {
  const m = /^deskzo:\/\/pair\?(.+)$/i.exec(text.trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const part of m[1]!.split("&")) {
    const [k, v = ""] = part.split("=");
    if (k) params[k] = decodeURIComponent(v);
  }
  return params.host && params.code ? { host: params.host, code: params.code } : null;
}
