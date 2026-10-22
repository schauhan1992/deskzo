import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import type { PendingCall } from "@/lib/after-call";
import { REMIND_AFTER_S } from "@/lib/after-call";
import { api } from "@/lib/api";
import { CALL_ACTION, routeFor, showWhileOpen, type PushRoute } from "@/lib/push-routing";
import type * as Shared from "./notifications";

/**
 * Notifications on an iPhone (owner, 22 Oct 2026). Deskzo pushes through Apple's push service (APNs, src/lib/app/
 * push.ts on the server) to the address this phone gives it (PATCH /api/app/device) — who and where, never what:
 *
 *   · "Ring my phone": "Call Ravi, Acme" with a Call button that dials.
 *   · A chat message: "New message from Priya" — a banner only while the app is closed; open, the app's own says so.
 *   · Something waiting for the person's decision: Approvals.
 *   · And the app's own, after a call started from it: "How did the call go?", in case they don't come straight back.
 *
 * Permission is asked when the person does something that needs it — turning on calls on this iPhone, or "Turn on
 * notifications" — never at launch.
 */

type Permission = Shared.PushPermission;

const REMINDER = "after-call";
let lastToken: string | null = null;

const KEPT: SecureStore.SecureStoreOptions = { keychainService: "deskzo", keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
let declined = (() => {
  try {
    return SecureStore.getItem("notifications-declined", KEPT) === "1";
  } catch {
    return false;
  }
})();

/** As Expo answers it: allowed, refused, or never asked. (The app never asks for iOS's quiet, provisional kind.) */
function statusOf(p: Notifications.NotificationPermissionsStatus): Permission {
  if (p.granted || p.status === "granted") return "granted";
  return p.status === "denied" || !p.canAskAgain ? "denied" : "undetermined";
}

/** What Deskzo put in the push (under `body`, as expo-notifications reads it), or a local one's own data. */
function dataOf(notification: Notifications.Notification): Record<string, unknown> | null {
  const data = notification.request.content.data;
  if (data && Object.keys(data).length > 0) return data;
  const trigger = notification.request.trigger as { type?: string; payload?: Record<string, unknown> } | null;
  return trigger?.type === "push" && trigger.payload ? ((trigger.payload.body as Record<string, unknown> | undefined) ?? null) : null;
}

async function sendToken(token: string) {
  if (token === lastToken) return;
  try {
    await api("PATCH", "/api/app/device", { push_token: token });
    lastToken = token;
  } catch {
    // Tried again the next time the app opens.
  }
}

async function register() {
  try {
    if (statusOf(await Notifications.getPermissionsAsync()) !== "granted") return;
    const token = await Notifications.getDevicePushTokenAsync();
    if (token.type === "ios" && typeof token.data === "string") await sendToken(token.data);
  } catch {
    // No push address on a simulator without Apple's service, or no network: the app still asks Deskzo as it opens.
  }
}

export const notifications: typeof Shared.notifications = {
  available: true,

  start: (open: (route: PushRoute) => void) => {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const show = showWhileOpen(dataOf(notification));
        return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
      },
    });
    void Notifications.setNotificationCategoryAsync("deskzo-call", [{ identifier: CALL_ACTION, buttonTitle: "Call", options: { opensAppToForeground: true } }]).catch(() => {});

    const handled = new Set<string>();
    const respond = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      // The same tap can arrive as the last response and through the listener: acted on once.
      const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
      if (handled.has(key)) return;
      handled.add(key);
      open(routeFor(dataOf(response.notification), response.actionIdentifier));
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    };
    // The tap that opened the app, and every one after.
    respond(Notifications.getLastNotificationResponse());
    const tapped = Notifications.addNotificationResponseReceivedListener(respond);
    // Apple can change the address: Deskzo is given the new one.
    const token = Notifications.addPushTokenListener((t) => {
      if (t.type === "ios" && typeof t.data === "string") void sendToken(t.data);
    });
    return () => {
      tapped.remove();
      token.remove();
    };
  },

  permission: async () => {
    try {
      return statusOf(await Notifications.getPermissionsAsync());
    } catch {
      return "undetermined";
    }
  },

  turnOn: async () => {
    try {
      let status = statusOf(await Notifications.getPermissionsAsync());
      if (status === "undetermined") status = statusOf(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }));
      if (status === "granted") await register();
      return status;
    } catch {
      return "undetermined";
    }
  },

  register,

  remindAfterCall: async (call: PendingCall) => {
    try {
      if (statusOf(await Notifications.getPermissionsAsync()) !== "granted") return;
      await Notifications.cancelScheduledNotificationAsync(REMINDER).catch(() => {});
      await Notifications.scheduleNotificationAsync({
        identifier: REMINDER,
        content: {
          title: call.label ? `How did the call with ${call.label} go?` : "How did the call go?",
          body: "Tap to say, add a note or a callback.",
          data: { type: "after-call", number: call.number, label: call.label ?? "", at: call.startedAt },
          sound: false,
          // Into Notification Centre without lighting up a call still going on; it is there when it ends.
          interruptionLevel: "passive",
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: REMIND_AFTER_S },
      });
    } catch {
      // The sheet still opens when the app comes back.
    }
  },

  cancelAfterCallReminder: async () => {
    await Notifications.cancelScheduledNotificationAsync(REMINDER).catch(() => {});
    await Notifications.dismissNotificationAsync(REMINDER).catch(() => {});
  },

  clear: async () => {
    lastToken = null;
    await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
    await Notifications.dismissAllNotificationsAsync().catch(() => {});
  },

  offerDeclined: () => declined,
  declineOffer: () => {
    declined = true;
    SecureStore.setItem("notifications-declined", "1", KEPT);
  },
};
