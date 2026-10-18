/**
 * Whether the Deskzo app is out (owner, 18 Oct 2026): its Google Play address is set, or `DESKZO_APP=on`
 * for testing a build before it is. Until then nothing points anybody at an app they can't get — the
 * Settings › Deskzo app page is not there, and so no phone can be paired.
 */
export function deskzoAppReady(): boolean {
  return !!androidAppUrl() || process.env.DESKZO_APP?.trim() === "on";
}

/** The app on Google Play, when it is there. */
export function androidAppUrl(): string | null {
  const url = process.env.DESKZO_APP_ANDROID_URL?.trim();
  return url && /^https:\/\//.test(url) ? url : null;
}
