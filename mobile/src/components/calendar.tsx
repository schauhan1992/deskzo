import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BOXED_TEXT_SCALE, colors } from "@/components/ui";
import { dayOf, keyOf } from "@/lib/format";

/**
 * A month to pick a span of days on, for leave (owner, 18 Oct 2026): the first tap is the first day, the second
 * the last; a tap before the first, or a third tap, starts again. Days are yyyy-mm-dd, as Deskzo takes them.
 */
export function RangeCalendar({ from, to, onChange }: { from: string | null; to: string | null; onChange: (from: string | null, to: string | null) => void }) {
  const [month, setMonth] = useState(() => {
    const d = from ? dayOf(from) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const today = keyOf(new Date());

  const first = month.getDay(); // Sunday = 0
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [...Array<null>(first).fill(null), ...Array.from({ length: count }, (_, i) => keyOf(new Date(month.getFullYear(), month.getMonth(), i + 1)))];
  while (cells.length % 7) cells.push(null);

  function tap(key: string) {
    if (!from || (from && to) || key < from) onChange(key, null);
    else onChange(from, key);
  }

  const move = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));

  return (
    <View style={s.box}>
      <View style={s.head}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => move(-1)} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </Pressable>
        <Text style={s.month}>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => move(1)} hitSlop={12}>
          <Ionicons name="chevron-forward" size={22} color={colors.text} />
        </Pressable>
      </View>
      <View style={s.week}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <Text key={i} style={s.weekday} maxFontSizeMultiplier={BOXED_TEXT_SCALE}>
            {d}
          </Text>
        ))}
      </View>
      <View style={s.grid}>
        {cells.map((key, i) => {
          if (!key) return <View key={`e${i}`} style={s.cell} />;
          const end = to ?? from;
          const picked = key === from || key === end;
          const inside = !!from && !!end && key > from && key < end;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityState={{ selected: picked }}
              accessibilityLabel={dayOf(key).toDateString()}
              onPress={() => tap(key)}
              style={[s.cell, inside && s.inside]}
            >
              <View style={[s.dot, picked && s.picked, key === today && !picked && s.today]}>
                <Text style={[s.num, picked && s.numPicked]} maxFontSizeMultiplier={BOXED_TEXT_SCALE}>
                  {Number(key.slice(8))}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  box: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.line, padding: 10 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4, paddingBottom: 8 },
  month: { fontSize: 16, fontWeight: "600", color: colors.text },
  week: { flexDirection: "row" },
  weekday: { flex: 1, textAlign: "center", fontSize: 12, color: colors.muted, paddingBottom: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, height: 40, alignItems: "center", justifyContent: "center" },
  inside: { backgroundColor: colors.brandSoft },
  dot: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  picked: { backgroundColor: colors.brandFill },
  today: { borderWidth: 1, borderColor: colors.brand },
  num: { fontSize: 15, color: colors.text },
  numPicked: { color: "#fff", fontWeight: "600" },
});
