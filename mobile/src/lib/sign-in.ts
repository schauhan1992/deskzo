import { Platform } from "react-native";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as WebBrowser from "expo-web-browser";
import { ApiError, request } from "@/lib/api";
import { APP_VERSION, webOrigin } from "@/lib/config";
import { whereAmI } from "@/lib/location";

/**
 * Signing the app in (owner, 18 Oct 2026): through the phone's browser, or with a pairing code from Settings ›
 * Deskzo app on a computer. Both end at /api/app/pair (src/lib/app/pairing.ts on the server).
 *
 * The browser way: the app opens /app-sign-in/<phone|tablet>/<challenge> on the workspace, the person signs in
 * there with every rule the web has, allows it, and the page sends a code back by deskzo://signed-in. The code
 * only works with the secret the challenge was made from (PKCE), which never leaves the app.
 */

type Where = { baseUrl: string; host: string | null };

export const formFactor = (): "phone" | "tablet" => (Device.deviceType === Device.DeviceType.TABLET ? "tablet" : "phone");

// base64url's alphabet: 64 characters, so a byte's low six bits pick one evenly.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const newVerifier = () => Array.from(Crypto.getRandomBytes(43), (b) => ALPHABET[b & 63]).join("");

async function challengeOf(verifier: string): Promise<string> {
  const b64 = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 });
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The sign-in the browser is out on: where, and the secret behind its challenge. Only in memory. */
let pending: { where: Where; verifier: string } | null = null;
const finishing = new Map<string, Promise<{ where: Where; token: string; approved: boolean }>>();

/** The code in a deskzo://signed-in link, or what went wrong. */
export function readSignedInLink(url: string): { code: string } | { error: string } | null {
  const m = /^deskzo:\/\/signed-in\?(.*)$/i.exec(url.trim());
  if (!m) return null;
  const code = /(?:^|&)code=([A-Za-z0-9]+)/.exec(m[1]!)?.[1];
  if (code) return { code };
  return { error: /(?:^|&)error=([a-z_]+)/.exec(m[1]!)?.[1] ?? "unknown" };
}

/** Opens the workspace's sign-in in the phone's browser; the code it sends back, or why there is none. */
export async function openBrowserSignIn(where: Where): Promise<{ code: string } | { error: string }> {
  const verifier = newVerifier();
  pending = { where, verifier };
  const url = `${webOrigin(where)}/app-sign-in/${formFactor()}/${await challengeOf(verifier)}`;
  const result = await WebBrowser.openAuthSessionAsync(url, "deskzo://signed-in");
  if (result.type !== "success") return { error: "cancelled" };
  return readSignedInLink(result.url) ?? { error: "unknown" };
}

/**
 * A code the browser sent back, spent once however many screens ask — the link reaches the app and the browser's
 * promise both.
 */
export function finishBrowserSignIn(code: string): Promise<{ where: Where; token: string; approved: boolean }> {
  const already = finishing.get(code);
  if (already) return already;
  const started = pending;
  const work = started
    ? pairWith(started.where, { code, verifier: started.verifier }).then((r) => ({ where: started.where, ...r }))
    : Promise.reject(new ApiError(0, "no_sign_in", "This sign-in was started before the app was closed. Start again."));
  finishing.set(code, work);
  return work;
}

/**
 * The phone's token for a code, as a phone or a tablet. A role that asks where you are when you sign in is
 * answered with the phone's location — asked only then.
 */
export async function pairWith(where: Where, body: Record<string, unknown>): Promise<{ token: string; approved: boolean }> {
  const base = { ...body, platform: Platform.OS, model: Device.modelName ?? Device.deviceName ?? null, app_version: APP_VERSION, form_factor: formFactor() };
  try {
    return await request<{ token: string; approved: boolean }>(where, "POST", "/api/app/pair", base);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "location_needed")) throw e;
    const place = await whereAmI();
    if (!place) throw new ApiError(403, "location_needed", "Your company asks where you are when you sign in, and the phone didn't share it. Turn location on for Deskzo and try again.");
    return request<{ token: string; approved: boolean }>(where, "POST", "/api/app/pair", { ...base, ...place });
  }
}
