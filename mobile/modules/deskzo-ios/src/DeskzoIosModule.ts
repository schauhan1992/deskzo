import { NativeModule, requireNativeModule } from "expo";

/** The Deskzo app's iPhone module (ios/DeskzoIosModule.swift). iOS only — Android has modules/deskzo-calls. */

/** Why iOS didn't load the caller ID list, as CallKit says it. */
export type CallDirectoryError = "no_extension" | "interrupted" | "out_of_order" | "duplicates" | "too_many" | "disabled" | "busy" | "incremental" | "unknown";

declare class DeskzoIosModule extends NativeModule<{ onScreenshot: () => void }> {
  /** True only the first time it is asked after the app is installed. */
  takeFreshInstall(): boolean;
  /** The in-app pages' cookies and stored data, all of them. */
  clearWebData(): Promise<void>;
  /** A file a page offered for download, fetched with the pages' own sign-in and handed to the share sheet. */
  saveDownload(url: string): Promise<boolean>;
  /** A file a page made itself (an export), its bytes in base64, handed to the share sheet. */
  shareFile(name: string, base64: string): Promise<boolean>;
  /** The caller ID list for the extension — E.164 digits, ascending, each once. How many were written. */
  setCallerIds(entries: { number: string; label: string }[]): Promise<number>;
  reloadCallDirectory(): Promise<CallDirectoryError | null>;
  callDirectoryStatus(): Promise<"enabled" | "disabled" | "unknown">;
  openCallDirectorySettings(): Promise<boolean>;
}

export default requireNativeModule<DeskzoIosModule>("DeskzoIos");
