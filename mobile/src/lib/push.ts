import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { api } from "@/lib/api";
import { linkRoute, type LinkRoute } from "@/lib/push-routing";

/**
 * Deskzo's notifications on the phone (owner, 22 Oct 2026 — push in the native app's first phase): what the bell says
 * on the web — a lead given to you, something waiting for your decision, a task, a ticket's reply — and a "ring my
 * phone" from Deskzo's call dialog, and a chat message (who, never what), shown by the phone even with the app closed.
 *
 * They come through Firebase Cloud Messaging, straight from the workspace's Deskzo (src/lib/app/push.ts on the
 * server): the phone's push address is handed to Deskzo, never to anybody else. A notification carries only its title
 * and where it leads; tapping it opens that in the app, through /api/app as anywhere else, so the person's access
 * still decides what they see. A build without Deskzo's Firebase file (app.config.ts) asks for nothing.
 */

/** This build can be reached through Firebase at all. */
export const PUSH_BUILT_IN = Platform.OS === "android" && Constants.expoConfig?.extra?.firebase === true;

/** The channel Deskzo's notifications arrive on — the one the server names (`channel_id`). */
export const CHANNEL = "deskzo";

/** The data a notification came with — Deskzo's own fields, however the phone handed them over. */
function dataOfNotification(notification: Notifications.Notification): Record<string, unknown> | null {
  const request = notification.request;
  const content = request.content.data as Record<string, unknown> | null | undefined;
  if (content && Object.keys(content).length > 0) return content;
  const trigger = request.trigger as { remoteMessage?: { data?: Record<string, string> } } | null;
  return trigger?.remoteMessage?.data ?? null;
}

// One that comes while the app is open shows as a banner too — the person is looking at the phone, not the bell. A
// chat message is the exception: the app's own chat banner already says it (src/components/chat/banner.tsx).
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const show = dataOfNotification(notification)?.type !== "chat";
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
  },
});

export type PushState = "on" | "denied" | "unavailable" | "failed";

/**
 * Asks the person once whether Deskzo may notify them (Android 13 and later ask), then gives Deskzo this phone's push
 * address. Again on every start — an address can change — and it's the same answer the next time if they said no.
 */
export async function registerForPush(): Promise<PushState> {
  if (!PUSH_BUILT_IN) return "unavailable";
  try {
    // Before the token: on Android 13 the permission is asked only once a channel exists.
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: "Deskzo", importance: Notifications.AndroidImportance.HIGH });
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) return "denied";
    const token = await Notifications.getDevicePushTokenAsync();
    await api("PATCH", "/api/app/device", { push_token: String(token.data) });
    return "on";
  } catch {
    return "failed";
  }
}

/** A new address from Firebase, handed to Deskzo as it comes. */
export function onPushAddressChange(): () => void {
  if (!PUSH_BUILT_IN) return () => {};
  const sub = Notifications.addPushTokenListener((token) => {
    void api("PATCH", "/api/app/device", { push_token: String(token.data) }).catch(() => {});
  });
  return () => sub.remove();
}

/**
 * Where a tapped notification leads in the app: a lead or company to its own screen, tasks and chat to theirs, a ring
 * to Calls, anything else to its web page in the app — only ever a page of this workspace (src/lib/push-routing.ts,
 * where an iPhone's go too).
 */
export function routeFor(data: Record<string, unknown> | null | undefined): LinkRoute | null {
  if (!data) return null;
  if (data.type === "call") return "/calls";
  if (data.type === "chat" && typeof data.chat === "string" && data.chat) return { pathname: "/conversation/[id]", params: { id: data.chat } };
  return linkRoute(typeof data.link === "string" ? data.link : "");
}

/** The data a tapped notification came with. */
export const dataOf = (response: Notifications.NotificationResponse) => dataOfNotification(response.notification);
