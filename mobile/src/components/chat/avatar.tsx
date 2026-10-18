import { Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

/**
 * A person's or a group's circle: their initials on a colour picked from the name, so the same person is always the
 * same colour; a group shows the group mark. A green dot while they are online.
 */
const COLOURS = ["#4F46E5", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316", "#6366F1"];

const colourOf = (key: string) => {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length]!;
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

export function Avatar({ name, group, size = 48, online }: { name: string; group?: boolean; size?: number; online?: boolean }) {
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colourOf(name), alignItems: "center", justifyContent: "center" }}>
        {group ? (
          <Ionicons name="people" size={size * 0.5} color="#fff" />
        ) : (
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: size * 0.36 }}>{initials(name)}</Text>
        )}
      </View>
      {online && (
        <View
          accessibilityLabel="online"
          style={{ position: "absolute", right: 0, bottom: 0, width: size * 0.28, height: size * 0.28, borderRadius: size, backgroundColor: "#22C55E", borderWidth: 2, borderColor: "#fff" }}
        />
      )}
    </View>
  );
}
