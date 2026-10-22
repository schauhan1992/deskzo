import { Linking } from "react-native";
import type { CallVia, PendingCall } from "@/lib/after-call";
import { dialString } from "@/lib/phone-numbers";

/**
 * Starting a call, and what an iPhone does around it (src/lib/calling.ios.ts): the after-call sheet when the app comes
 * back, and the caller ID list. On Android a call is handed to the dialler and the calling module does the rest — the
 * call log, caller ID and the "How did it go?" notification (modules/deskzo-calls).
 */

export type CallerIdState = { at: number; count: number; truncated: boolean; error: string | null };

export type CallAbout = { label?: string | null; via: CallVia; request?: string | null };

export const calling = {
  /** Hands the number to the phone's dialler. */
  dial: (number: string, _about?: CallAbout) => void Linking.openURL(`tel:${dialString(number)}`),
  /** Told of a call started from the app that the person is back from. Gives back how to stop listening. */
  watch: (_due: (call: PendingCall) => void): (() => void) => () => {},
  /** Loads the caller ID list again from Deskzo; null where there is none to load. */
  refreshCallerIds: async (): Promise<CallerIdState | null> => null,
  lastCallerIds: (): CallerIdState | null => null,
  /** Signing out: the call it was waiting on, and what it knew of caller ID. */
  forget: () => {},
};
