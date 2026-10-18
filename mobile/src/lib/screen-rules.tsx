import { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { useSegments } from "expo-router";
import { colors } from "@/components/ui";
import { api } from "@/lib/api";
import { screen } from "@/lib/native";
import { useSession } from "@/lib/session";

/**
 * The workspace's screen rules in the app (owner, 18 Oct 2026; src/lib/app/dlp.ts on the server), as on the website:
 *
 *   · Screenshots count against the person's daily allowance and the administrators are told of each. The phone says
 *     when one is taken (Android 14 and later); once the day's are used, the app blocks them — which, unlike the
 *     website, a phone can. An older Android can't say, so there the app blocks them while the allowance applies.
 *   · The watermark — the person's name and address — across the app's own screens. The Deskzo tab's pages draw
 *     their own.
 */

type Answer = { allowed: boolean; remaining: number | null; enforced: boolean; message: string };

/** The screens with customers' details on them, for a watermark kept to those (as src/lib/security/watermark-pages.ts). */
const CUSTOMER_SCREENS = new Set(["today", "chat", "conversation", "calls", "review", "tasks", "approvals"]);
/** Never watermarked: signing in, and the Deskzo tab, whose pages draw the website's own. */
const NEVER = new Set(["pair", "signed-in", "web"]);

export function ScreenRules() {
  const { me, paired, refreshMe } = useSession();
  const segments = useSegments();
  // The screen, as the security log shows it: "today" for the home tab, "tasks", "review/[id]"…
  const here = segments.filter((s) => !s.startsWith("(")).join("/") || "today";
  const screenName = here.split("/")[0]!;
  const rules = paired ? (me?.screen ?? null) : null;
  const shots = rules?.screenshots ?? null;
  const [left, setLeft] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const where = useRef(here);
  where.current = here;

  // How many are left today, as Deskzo last said.
  useEffect(() => setLeft(shots ? Math.max(0, shots.limit - shots.used) : null), [shots?.limit, shots?.used, shots]);

  const detectable = screen.detectable();
  const blocked = !!shots && (!detectable || (left ?? 0) <= 0);
  useEffect(() => screen.setBlocked(blocked), [blocked]);

  // Each screenshot, counted where the website's are.
  useEffect(() => {
    if (!shots || !detectable) return;
    return screen.onScreenshot(() => {
      api<Answer>("POST", "/api/app/screenshot", { screen: where.current }).then(
        (a) => {
          if (a.enforced) setLeft(a.remaining ?? 0);
          if (a.message) setNotice(a.message);
        },
        () => {},
      );
    });
  }, [shots, detectable]);

  // A new day brings a new allowance: asked again whenever the app comes back.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && paired) void refreshMe();
    });
    return () => sub.remove();
  }, [paired, refreshMe]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const mark = rules?.watermark ?? null;
  const showMark = !!mark && !NEVER.has(screenName) && (mark.scope === "EVERY_PAGE" || CUSTOMER_SCREENS.has(screenName));

  return (
    <>
      {showMark && <Watermark label={mark.label} opacity={mark.opacity} />}
      {notice && (
        <View pointerEvents="none" style={s.notice}>
          <Text style={s.noticeText}>{notice}</Text>
        </View>
      )}
    </>
  );
}

/** The person's name and address, with the time, faint and repeated across the screen — a photo of it names them. */
function Watermark({ label, opacity }: { label: string; opacity: number }) {
  const [stamp, setStamp] = useState(() => when());
  useEffect(() => {
    const t = setInterval(() => setStamp(when()), 60_000);
    return () => clearInterval(t);
  }, []);
  const text = `${label} · ${stamp}`;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, s.markBox, { opacity: Math.min(Math.max(opacity, 3), 25) / 100 }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={s.markGrid}>
        {Array.from({ length: 16 }, (_, row) => (
          <Text key={row} numberOfLines={1} style={s.markRow}>
            {`${text}      ${text}      ${text}`}
          </Text>
        ))}
      </View>
    </View>
  );
}

const when = () => {
  const now = new Date();
  return `${now.getDate()} ${now.toLocaleDateString(undefined, { month: "short" })}, ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
};

const s = StyleSheet.create({
  markBox: { overflow: "hidden", alignItems: "center", justifyContent: "center" },
  markGrid: { width: "260%", transform: [{ rotate: "-30deg" }], gap: 34 },
  markRow: { fontSize: 13, fontWeight: "600", color: colors.text, letterSpacing: 0.4 },
  notice: { position: "absolute", left: 16, right: 16, bottom: 96, backgroundColor: colors.text, borderRadius: 10, padding: 12 },
  noticeText: { color: "#fff", fontSize: 14, lineHeight: 19 },
});
