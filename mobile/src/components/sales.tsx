import type { ReactNode } from "react";
import { Linking, Modal, Pressable, ScrollView, Text, TextInput, View, type TextInputProps } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, styles } from "@/components/ui";
import { when } from "@/lib/format";
import type { Activity } from "@/lib/sales-types";

/** The sales screens' own parts (owner, 22 Oct 2026 — the app made native, sales first). */

/** A row of a list: what it is, a line under it, something on the right, and where a tap goes. */
export function ListRow({ title, subtitle, right, onPress }: { title: string; subtitle?: string | null; right?: ReactNode; onPress?: () => void }) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      onPress={onPress}
      style={({ pressed }) => [{ paddingVertical: 12, paddingHorizontal: 16, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.line, flexDirection: "row", alignItems: "center", gap: 10 }, pressed && onPress ? { backgroundColor: colors.sunken } : null]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.body, { fontWeight: "600" }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.small} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {onPress ? <Ionicons name="chevron-forward" size={18} color={colors.muted} /> : null}
    </Pressable>
  );
}

/** A lead's stage, coloured by what it means: won green, lost red, everything else the brand's. */
export function StagePill({ name, status }: { name: string; status?: string | null }) {
  const won = status === "WON";
  const lost = status === "LOST" || status === "DISQUALIFIED";
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: won ? "#DCFCE7" : lost ? "#FEE2E2" : colors.brandSoft }}>
      <Text style={{ fontSize: 12, fontWeight: "600", color: won ? colors.success : lost ? colors.danger : colors.brand }} numberOfLines={1}>
        {name}
      </Text>
    </View>
  );
}

/** Digits a phone can dial; a ten-digit number is taken as India's. */
export function dialable(phone: string): string {
  const plus = phone.trim().startsWith("+");
  const digits = phone.replace(/\D/g, "");
  return plus ? `+${digits}` : digits;
}

export function whatsappLink(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `https://wa.me/${digits.length === 10 ? `91${digits}` : digits.replace(/^0+/, "")}`;
}

function RoundButton({ icon, label, onPress, tone = colors.brand }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; tone?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6} style={({ pressed }) => [{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: colors.brandSoft }, pressed && { opacity: 0.7 }]}>
      <Ionicons name={icon} size={20} color={tone} />
    </Pressable>
  );
}

/**
 * Ring, WhatsApp or email somebody — the phone's own apps. A call placed here is logged by call sync (Calls) as any
 * other; a number or address the workspace hides from the person comes masked, and isn't offered.
 */
export function ContactButtons({ phone, email }: { phone?: string | null; email?: string | null }) {
  const canRing = !!phone && /\d{6,}/.test(phone.replace(/\D/g, "")) && !/[*•]/.test(phone);
  const canMail = !!email && email.includes("@") && !/[*•]/.test(email);
  if (!canRing && !canMail) return null;
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {canRing && <RoundButton icon="call" label={`Call ${phone}`} onPress={() => void Linking.openURL(`tel:${dialable(phone!)}`)} />}
      {canRing && <RoundButton icon="logo-whatsapp" label={`WhatsApp ${phone}`} tone="#16A34A" onPress={() => void Linking.openURL(whatsappLink(phone!)).catch(() => {})} />}
      {canMail && <RoundButton icon="mail" label={`Email ${email}`} onPress={() => void Linking.openURL(`mailto:${email}`)} />}
    </View>
  );
}

/** A labelled text box. */
export function Field({ label, hint, error, ...input }: { label: string; hint?: string; error?: string | null } & TextInputProps) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.small, { color: colors.text, fontWeight: "600" }]}>{label}</Text>
      <TextInput style={[styles.input, error ? { borderColor: colors.danger } : null]} placeholderTextColor={colors.muted} accessibilityLabel={label} {...input} />
      {error ? <Text style={[styles.small, { color: colors.danger }]}>{error}</Text> : hint ? <Text style={styles.small}>{hint}</Text> : null}
    </View>
  );
}

/** A sheet up from the bottom, over the screen; closed by its button, a tap outside, or Back. */
export function Sheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.35)" }} />
      <SafeAreaView edges={["bottom"]} style={{ backgroundColor: colors.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "80%" }}>
        <View style={[styles.row, { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 }]}>
          <Text style={[styles.body, { fontWeight: "700", flex: 1 }]} accessibilityRole="header">
            {title}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={22} color={colors.muted} />
          </Pressable>
        </View>
        {/* Sized to what it holds, up to the sheet's height — a ScrollView left to grow collapses to nothing here. */}
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 16, paddingTop: 4, gap: 12 }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/** Two to four views of one place — Leads, Companies, Contacts. */
export function Segments<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", backgroundColor: colors.sunken, borderRadius: 10, padding: 3, borderWidth: 1, borderColor: colors.line }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(o.value)} style={{ flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center", backgroundColor: on ? colors.surface : "transparent" }}>
            <Text style={{ fontSize: 14, fontWeight: on ? "700" : "500", color: on ? colors.text : colors.muted }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SearchBox({ value, onChangeText, placeholder }: { value: string; onChangeText: (text: string) => void; placeholder: string }) {
  return (
    <View style={[styles.input, { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 0 }]}>
      <Ionicons name="search" size={18} color={colors.muted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        accessibilityLabel={placeholder}
        returnKeyType="search"
        autoCorrect={false}
        style={{ flex: 1, fontSize: 16, color: colors.text, paddingVertical: 10 }}
      />
      {value ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear" onPress={() => onChangeText("")} hitSlop={8}>
          <Ionicons name="close-circle" size={18} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** "₹12,50,000" — or, where the workspace hides an amount from the person, its masked text as sent. */
export function money(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && !/^-?\d+(\.\d+)?$/.test(value)) return value;
  return `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** A label: value line of a record's details. */
export function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <Text style={[styles.small, { width: 110 }]}>{label}</Text>
      <Text style={[styles.body, { flex: 1 }]}>{value}</Text>
    </View>
  );
}

/** The round button low on the right that adds something — as Chat's. */
export function Fab({ icon = "add", label, onPress }: { icon?: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        { position: "absolute", right: 18, bottom: 18, width: 58, height: 58, borderRadius: 18, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center", elevation: 6, shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
        pressed && { opacity: 0.85 },
      ]}
    >
      <Ionicons name={icon} size={28} color="#fff" />
    </Pressable>
  );
}

const ACTIVITY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  CALL: "call-outline",
  MEETING: "people-outline",
  EMAIL: "mail-outline",
  NOTE: "document-text-outline",
  STAGE_CHANGE: "swap-horizontal-outline",
};

/** One thing logged — a call, meeting, email, note or stage move — who did it and when; a company's names its lead. */
export function ActivityLine({ activity: a, showLead }: { activity: Activity; showLead?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 10, paddingVertical: 6 }}>
      <Ionicons name={ACTIVITY_ICONS[a.type] ?? "ellipse-outline"} size={18} color={colors.muted} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, gap: 2 }}>
        {a.notes ? <Text style={styles.body}>{a.notes}</Text> : null}
        <Text style={styles.small}>{[showLead ? a.lead?.title : null, a.by?.name, when(a.occurred_at)].filter(Boolean).join(" · ")}</Text>
      </View>
    </View>
  );
}
