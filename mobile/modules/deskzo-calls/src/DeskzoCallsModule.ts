import { NativeModule, requireNativeModule } from "expo";

/** The Deskzo app's native calling module (android/src/main/java/com/deskzo/calls). Android only. */

export type NativeSession = { baseUrl: string; token: string; host: string | null };

declare class DeskzoCallsModule extends NativeModule<Record<string, never>> {
  getSession(): NativeSession | null;
  /** Deskzo said this phone is no longer signed in, while the app was closed. */
  signedOut(): boolean;
  setSession(baseUrl: string, token: string, host: string | null): void;
  clearSession(): void;
  getCallSync(): { on: boolean; from: number; lastSyncAt: number };
  setCallSync(on: boolean): void;
  syncNow(): Promise<{ sent: number; logged: number; error: string | null }>;
  ignoresBatteryOptimizations(): boolean;
  openBatterySettings(): void;
}

export default requireNativeModule<DeskzoCallsModule>("DeskzoCalls");
