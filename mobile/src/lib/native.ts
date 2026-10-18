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
