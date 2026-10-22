import { Platform } from "react-native";
import type DeskzoCallsModule from "../../modules/deskzo-calls/src/DeskzoCallsModule";

/**
 * The native calling module — Android only. Elsewhere (iOS later) the app pairs and shows its lists, but
 * there is no call log to read: these answer as if call sync were off.
 */
type Native = typeof DeskzoCallsModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const native: Native | null = Platform.OS === "android" ? (require("../../modules/deskzo-calls/src/DeskzoCallsModule").default as Native) : null;

let memory: { baseUrl: string; token: string; host: string | null } | null = null;

export const calls = {
  available: native !== null,
  getSession: () => (native ? native.getSession() : memory),
  signedOut: () => native?.signedOut() ?? false,
  setSession: (baseUrl: string, token: string, host: string | null) => (native ? native.setSession(baseUrl, token, host) : void (memory = { baseUrl, token, host })),
  clearSession: () => (native ? native.clearSession() : void (memory = null)),
  getCallSync: () => native?.getCallSync() ?? { on: false, from: 0, lastSyncAt: 0 },
  setCallSync: (on: boolean) => native?.setCallSync(on),
  syncNow: async () => (native ? native.syncNow() : { sent: 0, logged: 0, error: null }),
  ignoresBatteryOptimizations: () => native?.ignoresBatteryOptimizations() ?? true,
  openBatterySettings: () => native?.openBatterySettings(),
};

/**
 * An iPhone's calling (src/lib/native.ios.ts): caller ID loaded ahead of time, calls logged from the after-call sheet.
 * Nothing on Android, where `calls` above reads the call log instead.
 */
export const phone = {
  available: false,
  /** The person said this iPhone is the phone they call customers on (Settings › Calls on this iPhone). */
  callsOn: () => false,
  setCallsOn: (_on: boolean) => {},
  setCallerIds: async (_entries: { number: string; label: string }[]) => 0,
  reloadCallerIds: async (): Promise<string | null> => null,
  callerIdStatus: async (): Promise<"enabled" | "disabled" | "unknown"> => "unknown",
  openCallerIdSettings: async () => false,
  /** A file a Deskzo page offers for download — Android's WebView hands those to its own download manager. */
  saveDownload: async (_url: string) => false,
  /** A file a Deskzo page made itself — an export — to the share sheet (src/lib/web-downloads.ts). */
  shareFile: async (_name: string, _base64: string) => false,
};

/** The workspace's screen rules on this phone (src/lib/screen-rules.tsx): told of screenshots, and blocking them. */
export const screen = {
  /** Android 14 and later tell the app when a screenshot is taken; elsewhere nothing can. */
  detectable: () => native?.screenshotsDetectable() ?? false,
  setBlocked: (blocked: boolean) => native?.setScreenshotsBlocked(blocked),
  onScreenshot: (listener: () => void): (() => void) => {
    const sub = native?.addListener("onScreenshot", listener);
    return () => sub?.remove();
  },
};
