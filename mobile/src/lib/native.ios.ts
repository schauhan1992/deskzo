import * as SecureStore from "expo-secure-store";
import DeskzoIos from "../../modules/deskzo-ios/src/DeskzoIosModule";
import type * as Shared from "./native";

/**
 * The iPhone's side of src/lib/native.ts (owner, 22 Oct 2026) — the same `calls`, `screen` and `phone`, as iOS allows:
 *
 *   · The session — the workspace's address and the phone's token — in the iOS Keychain, never in plain storage:
 *     readable once the phone has been unlocked since it started, never synced to iCloud or restored to another
 *     phone (…_THIS_DEVICE_ONLY). A reinstalled app starts signed out, as on Android: the Keychain outlives an
 *     uninstall, so the first run after an install clears it.
 *   · No call log, so no call sync (`calls.available` is false): calls are logged from the after-call sheet, and
 *     caller ID is a list iOS is given ahead of time (`phone`, src/lib/calling.ios.ts).
 *   · Screenshots are reported, never blocked: iOS lets no app stop them.
 */

type Session = { baseUrl: string; token: string; host: string | null };

const OPTIONS: SecureStore.SecureStoreOptions = { keychainService: "deskzo", keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const SESSION = "session";
const CALLS = "calls-on";

function read<T>(key: string): T | null {
  try {
    const text = SecureStore.getItem(key, OPTIONS);
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  if (value === null) void SecureStore.deleteItemAsync(key, OPTIONS).catch(() => {});
  else SecureStore.setItem(key, JSON.stringify(value), OPTIONS);
}

if (DeskzoIos.takeFreshInstall()) {
  write(SESSION, null);
  write(CALLS, null);
}

// Read once; every screen asks synchronously, as Android's module answers.
let session: Session | null = read<Session>(SESSION);
let callsOn = read<boolean>(CALLS) === true;

export const calls: typeof Shared.calls = {
  available: false,
  getSession: () => session,
  // Deskzo saying the phone is signed out reaches the app as it asks (src/lib/api.ts): nothing runs while it's closed.
  signedOut: () => false,
  setSession: (baseUrl: string, token: string, host: string | null) => {
    session = { baseUrl, token, host };
    write(SESSION, session);
  },
  clearSession: () => {
    session = null;
    callsOn = false;
    write(SESSION, null);
    write(CALLS, null);
    // The in-app pages' sign-in and device cookie, and the caller ID list — nothing of Deskzo stays on the phone.
    void DeskzoIos.clearWebData().catch(() => {});
    void DeskzoIos.setCallerIds([])
      .then(() => DeskzoIos.reloadCallDirectory())
      .catch(() => {});
  },
  getCallSync: () => ({ on: false, from: 0, lastSyncAt: 0 }),
  setCallSync: () => {},
  syncNow: async () => ({ sent: 0, logged: 0, error: null }),
  ignoresBatteryOptimizations: () => true,
  openBatterySettings: () => {},
};

export const phone: typeof Shared.phone = {
  available: true,
  callsOn: () => callsOn,
  setCallsOn: (on: boolean) => {
    callsOn = on;
    write(CALLS, on ? true : null);
  },
  setCallerIds: (entries) => DeskzoIos.setCallerIds(entries),
  reloadCallerIds: () => DeskzoIos.reloadCallDirectory(),
  callerIdStatus: () => DeskzoIos.callDirectoryStatus().catch(() => "unknown" as const),
  openCallerIdSettings: () => DeskzoIos.openCallDirectorySettings().catch(() => false),
  saveDownload: (url: string) => DeskzoIos.saveDownload(url).catch(() => false),
  shareFile: (name: string, base64: string) => DeskzoIos.shareFile(name, base64).catch(() => false),
};

export const screen: typeof Shared.screen = {
  detectable: () => true,
  setBlocked: () => {},
  onScreenshot: (listener: () => void): (() => void) => {
    const sub = DeskzoIos.addListener("onScreenshot", listener);
    return () => sub.remove();
  },
};
