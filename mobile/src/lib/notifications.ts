import type { PendingCall } from "@/lib/after-call";
import type { PushRoute } from "@/lib/push-routing";

/**
 * The iPhone's notifications (src/lib/notifications.ios.ts): pushes from Deskzo through Apple's — "Ring my phone",
 * chat messages, approvals — and the app's own after-call reminder. On Android the calling module posts its own
 * (modules/deskzo-calls Alerts.kt) and nothing here runs.
 */

export type PushPermission = "granted" | "denied" | "undetermined";

export const notifications = {
  available: false,
  /** Once, at the root: how they show while the app is open, the "Call" button, and where a tap goes. */
  start: (_open: (route: PushRoute) => void): (() => void) => () => {},
  permission: async (): Promise<PushPermission> => "undetermined",
  /** Asks the person — only ever from a tap of theirs — then gives Deskzo the phone's push address. */
  turnOn: async (): Promise<PushPermission> => "undetermined",
  /** Gives Deskzo the phone's push address, if the person has already allowed notifications. Never asks. */
  register: async () => {},
  remindAfterCall: async (_call: PendingCall) => {},
  cancelAfterCallReminder: async () => {},
  /** Signing out: nothing scheduled, nothing left on the lock screen. */
  clear: async () => {},
  /** The person said "Not now" to Today's offer of notifications — it isn't made again (Settings still has it). */
  offerDeclined: () => true,
  declineOffer: () => {},
};
