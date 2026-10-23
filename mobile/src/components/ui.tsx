import type { ReactNode } from "react";
import { ActivityIndicator, DynamicColorIOS, Platform, Pressable, StyleSheet, Text, View, type NativeColorValue, type StyleProp, type ViewStyle } from "react-native";

/** Deskzo's colours: Deskzo blue, the official logo's (owner, 23 Oct 2026; --deskzo-blue in src/app/globals.css). */
const LIGHT = {
  brand: "#0249FE",
  /** The brand under white text — a button, a badge. The same blue as `brand`; only dark mode tells them apart. */
  brandFill: "#0249FE",
  brandSoft: "#E8EFFF",
  text: "#0F172A",
  muted: "#64748B",
  line: "#E2E8F0",
  surface: "#FFFFFF",
  sunken: "#F8FAFC",
  danger: "#DC2626",
  /** Red under white text — "Sign out", "Reject". As `brandFill` is to `brand`. */
  dangerFill: "#DC2626",
  success: "#16A34A",
  warning: "#B45309",
};

type Name = keyof typeof LIGHT;

/**
 * Dark mode, on iOS only (app.config.ts): the web's slate and Deskzo blue turned round, each pair at least 4.5:1 — text
 * on a fill keeps the light value, and text on the dark surfaces gets a lighter one. Android stays light, as it was.
 */
const DARK: Record<Name, string> = {
  brand: "#6E95FF",
  brandFill: "#0249FE",
  brandSoft: "#14286B",
  text: "#F1F5F9",
  muted: "#94A3B8",
  line: "#334155",
  surface: "#1E293B",
  sunken: "#0F172A",
  danger: "#F87171",
  dangerFill: "#DC2626",
  success: "#4ADE80",
  warning: "#FBBF24",
};

/** A colour: a hex string, or iOS's own colour that has a dark-mode value too. */
export type Colour = string | NativeColorValue;

/** A colour with its dark-mode counterpart: iOS swaps it as the phone's appearance changes, without a render. Android takes the light one. */
export const dynamic = (light: string, dark: string): Colour => (Platform.OS === "ios" ? (DynamicColorIOS({ light, dark }) as NativeColorValue) : light);

export const colors = Object.fromEntries((Object.keys(LIGHT) as Name[]).map((name) => [name, dynamic(LIGHT[name], DARK[name])])) as Record<Name, Colour>;

/**
 * How far text in a box of fixed size — a calendar day, an unread count, initials in a circle — may grow with the
 * iPhone's text size before it would spill out (Dynamic Type). Android's is left as it was.
 */
export const BOXED_TEXT_SCALE: number | undefined = Platform.OS === "ios" ? 1.4 : undefined;

/** The same colours as plain hex for the appearance in use — for what only takes a string, like navigation's tints. */
export const paletteFor = (scheme: "light" | "dark" | "unspecified" | null | undefined): Record<Name, string> => (Platform.OS === "ios" && scheme === "dark" ? DARK : LIGHT);

export function Button({
  title,
  onPress,
  kind = "primary",
  busy,
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [styles.button, kind === "primary" ? styles.primary : kind === "danger" ? styles.danger : styles.secondary, off && styles.off, pressed && !off && styles.pressed, style]}
    >
      {busy ? <ActivityIndicator color={kind === "secondary" ? colors.brand : "#fff"} /> : <Text style={[styles.buttonText, kind === "secondary" && { color: colors.text }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Heading({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <Text style={styles.heading} accessibilityRole="header">
      {children}
      {count ? <Text style={styles.count}> {count}</Text> : null}
    </Text>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress} style={[styles.chip, selected && styles.chipOn]}>
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "danger" | "success" | "warning"; children: ReactNode }) {
  const color = tone === "danger" ? colors.danger : tone === "success" ? colors.success : tone === "warning" ? colors.warning : colors.muted;
  return <Text style={[styles.notice, { color }]}>{children}</Text>;
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sunken },
  // An iPad keeps a phone's column, centred, rather than lines a whole screen wide.
  content: { padding: 16, gap: 12, ...(Platform.OS === "ios" && Platform.isPad ? { width: "100%", maxWidth: 720, alignSelf: "center" } : null) },
  button: { minHeight: 46, borderRadius: 10, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  primary: { backgroundColor: colors.brandFill },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  danger: { backgroundColor: colors.dangerFill },
  off: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  card: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.line, padding: 14, gap: 8 },
  heading: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8 },
  count: { color: colors.brand },
  title: { fontSize: 22, fontWeight: "700", color: colors.text },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
  small: { fontSize: 13, color: colors.muted },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: colors.text },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  chipOn: { backgroundColor: colors.brandFill, borderColor: colors.brandFill },
  chipText: { fontSize: 14, color: colors.text },
  chipTextOn: { color: "#fff", fontWeight: "600" },
  notice: { fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
});
