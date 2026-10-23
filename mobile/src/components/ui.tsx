import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

/** Deskzo's colours: Deskzo blue, the official logo's (owner, 23 Oct 2026; --deskzo-blue in src/app/globals.css). */
export const colors = {
  brand: "#0249FE",
  brandSoft: "#E8EFFF",
  text: "#0F172A",
  muted: "#64748B",
  line: "#E2E8F0",
  surface: "#FFFFFF",
  sunken: "#F8FAFC",
  danger: "#DC2626",
  success: "#16A34A",
  warning: "#B45309",
};

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
  content: { padding: 16, gap: 12 },
  button: { minHeight: 46, borderRadius: 10, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  primary: { backgroundColor: colors.brand },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  danger: { backgroundColor: colors.danger },
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
  chipOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { fontSize: 14, color: colors.text },
  chipTextOn: { color: "#fff", fontWeight: "600" },
  notice: { fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
});
