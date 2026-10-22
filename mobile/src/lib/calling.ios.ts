import { AppState, Linking } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as AfterCall from "@/lib/after-call";
import { api } from "@/lib/api";
import { phone } from "@/lib/native";
import { notifications } from "@/lib/notifications";
import { dialString, directoryEntries } from "@/lib/phone-numbers";
import type * as Shared from "./calling";

/**
 * Calling on an iPhone (owner, 22 Oct 2026) — the closest iOS allows to Android's call sync:
 *
 *   · A call started from the app (a ring, a callback, a number on a Deskzo page) is remembered; when the person is
 *     back from it, the after-call sheet asks how it went and logs it (src/lib/after-call.ts, src/app/after-call.tsx).
 *     If they don't come straight back, a quiet reminder waits in Notification Centre.
 *   · Caller ID: the numbers of the customers the person may see in Deskzo (/api/app/calls/directory), given to iOS
 *     ahead of time for the Call Directory extension — loaded again each time the app opens.
 *
 * Both only once the person has said this iPhone is the one they call customers on (src/components/iphone-setup.tsx).
 */

const OPTIONS: SecureStore.SecureStoreOptions = { keychainService: "deskzo", keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

function keep(key: string, value: unknown) {
  if (value === null) void SecureStore.deleteItemAsync(key, OPTIONS).catch(() => {});
  else SecureStore.setItem(key, JSON.stringify(value), OPTIONS);
}

function kept<T>(key: string): T | null {
  try {
    const text = SecureStore.getItem(key, OPTIONS);
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

// A call survives the app being closed while it goes on: the customer's number, in the Keychain like the token.
AfterCall.setStore({ load: () => kept<AfterCall.PendingCall>("pending-call"), save: (call) => keep("pending-call", call) });

let callerIds: Shared.CallerIdState | null = kept<Shared.CallerIdState>("caller-ids");
let loading: Promise<Shared.CallerIdState | null> | null = null;

async function loadCallerIds(): Promise<Shared.CallerIdState | null> {
  if (!phone.callsOn()) return null;
  try {
    const list = await api<{ entries: { number: string; label: string }[]; truncated: boolean }>("GET", "/api/app/calls/directory");
    const entries = directoryEntries(list.entries);
    const count = await phone.setCallerIds(entries);
    const error = await phone.reloadCallerIds();
    callerIds = { at: Date.now(), count, truncated: list.truncated, error };
  } catch (e) {
    callerIds = { at: Date.now(), count: callerIds?.count ?? 0, truncated: false, error: e instanceof Error ? e.message : "unknown" };
  }
  keep("caller-ids", callerIds);
  return callerIds;
}

export const calling: typeof Shared.calling = {
  dial: (number, about) => {
    const url = `tel:${dialString(number)}`;
    // Only a phone the person calls customers on asks how it went: elsewhere there is nothing to log it to.
    if (phone.callsOn() && about) {
      const call = AfterCall.started({ number, label: about.label, via: about.via, request: about.request });
      void notifications.remindAfterCall(call);
    }
    void Linking.openURL(url).catch(() => {
      AfterCall.forget();
      void notifications.cancelAfterCallReminder();
    });
  },

  watch: (due) => {
    const check = () => {
      const call = AfterCall.cameBack();
      if (call) {
        void notifications.cancelAfterCallReminder();
        due(call);
      }
    };
    // Opened again after iOS closed the app during the call.
    if (AppState.currentState === "active") check();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") AfterCall.wentAway();
      else if (state === "active") check();
    });
    return () => sub.remove();
  },

  refreshCallerIds: () => {
    // One at a time: a refresh asked for while one is on its way gets that one's answer.
    loading ??= loadCallerIds().finally(() => {
      loading = null;
    });
    return loading;
  },

  lastCallerIds: () => callerIds,

  forget: () => {
    AfterCall.forget();
    callerIds = null;
    keep("caller-ids", null);
  },
};
