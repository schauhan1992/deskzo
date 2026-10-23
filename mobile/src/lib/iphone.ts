import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useRouter } from "expo-router";
import { api } from "@/lib/api";
import { calling } from "@/lib/calling";
import { calls, phone } from "@/lib/native";
import { notifications } from "@/lib/notifications";
import { useSession } from "@/lib/session";

/** Caller ID is loaded again when the app opens, and when it comes back after this long. */
const CALLER_IDS_EVERY_MS = 6 * 3_600_000;

/**
 * What an iPhone does from the root of the app (owner, 22 Oct 2026; src/app/_layout.tsx). Nothing on Android, whose
 * calling module does its own (modules/deskzo-calls):
 *
 *   · A tapped notification goes where it says (src/lib/push-routing.ts) — "Call" on a ring dials at once.
 *   · Back from a call started in the app: the after-call sheet (src/lib/calling.ios.ts).
 *   · Signed in: Deskzo is given the phone's push address if notifications are allowed (never asked here), and the
 *     caller ID list is loaded again.
 */
export function useIphone() {
  const router = useRouter();
  const { paired, me } = useSession();
  const lastLoad = useRef(0);

  useEffect(() => {
    if (!notifications.available) return;
    return notifications.start((route) => {
      if (!route || !calls.getSession()) return;
      if (route.kind === "dial") {
        calling.dial(route.number, { label: route.label, via: "ring", request: route.request });
        // Taken: the call dialog shows the phone has it, and Calls doesn't offer it again.
        void api("GET", "/api/app/calls/requests").catch(() => {});
        return;
      }
      router.push(route.params ? { pathname: route.pathname, params: route.params } : route.pathname);
    });
  }, [router]);

  useEffect(() => {
    if (!phone.available) return;
    return calling.watch((call) =>
      router.push({
        pathname: "/after-call",
        params: { number: call.number, at: String(call.startedAt), via: call.via, ...(call.label ? { label: call.label } : {}), ...(call.request ? { request: call.request } : {}) },
      }),
    );
  }, [router]);

  const signedIn = paired && !!me;
  useEffect(() => {
    if (!signedIn || !phone.available) return;
    const load = () => {
      lastLoad.current = Date.now();
      void notifications.register();
      void calling.refreshCallerIds();
    };
    load();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && Date.now() - lastLoad.current > CALLER_IDS_EVERY_MS) load();
    });
    return () => sub.remove();
  }, [signedIn]);
}
