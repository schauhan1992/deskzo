import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, onSignedOut, type Me } from "@/lib/api";
import { calling } from "@/lib/calling";
import { calls } from "@/lib/native";
import { notifications } from "@/lib/notifications";

/**
 * Who this phone is signed in as. The token lives in the native module's private storage (so the
 * background sync can use it with the app closed); this holds what the screens need on top.
 */

type SessionState = {
  ready: boolean;
  paired: boolean;
  me: Me | null;
  /** Deskzo signed this phone out — revoked in Security › Devices, or signed out from Settings. */
  signedOut: boolean;
  refreshMe: () => Promise<Me | null>;
  paired_: (baseUrl: string, token: string, host: string | null) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [paired, setPaired] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const forget = useCallback(() => {
    calls.clearSession();
    // An iPhone's reminders, the call it was waiting on and its caller ID (src/lib/calling.ios.ts) — nothing on Android.
    calling.forget();
    void notifications.clear();
    setPaired(false);
    setMe(null);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const next = await api<Me>("GET", "/api/app/me");
      setMe(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const session = calls.getSession();
    if (calls.signedOut()) setSignedOut(true);
    setPaired(!!session);
    setReady(true);
    if (session) void refreshMe();
    return onSignedOut(() => {
      setSignedOut(true);
      forget();
    });
  }, [forget, refreshMe]);

  const value = useMemo<SessionState>(
    () => ({
      ready,
      paired,
      me,
      signedOut,
      refreshMe,
      paired_: async (baseUrl, token, host) => {
        calls.setSession(baseUrl, token, host);
        setSignedOut(false);
        setPaired(true);
        await refreshMe();
      },
      signOut: async () => {
        try {
          await api("DELETE", "/api/app/device");
        } catch {
          // Signed out here whatever Deskzo says; an administrator can revoke it there too.
        }
        forget();
      },
    }),
    [ready, paired, me, signedOut, refreshMe, forget],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
