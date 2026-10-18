import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, styles } from "@/components/ui";
import { api, type Task } from "@/lib/api";
import { dayLabel, keyOf } from "@/lib/format";

/**
 * One task, ticked off with a tap (or opened again, from Done) — the web's own setTaskStatus, so a repeating task
 * makes its next one and a task with an unfinished checklist says so (src/app/api/app/tasks/[id]).
 */
export function TaskRow({ task, onChanged, onProblem }: { task: Task; onChanged: (task: Task) => void; onProblem: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const done = task.status === "DONE";
  const late = !done && !!task.due && task.due < keyOf(new Date());

  async function toggle() {
    setBusy(true);
    const status = done ? "TODO" : "DONE";
    try {
      await api("PATCH", `/api/app/tasks/${task.id}`, { status });
      onChanged({ ...task, status });
    } catch (e) {
      onProblem(e instanceof Error ? e.message : "Couldn't change the task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.row, { paddingVertical: 6 }]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done, disabled: !task.can_work || busy }}
        accessibilityLabel={done ? `Open "${task.title}" again` : `Mark "${task.title}" done`}
        onPress={task.can_work && !busy ? () => void toggle() : undefined}
        hitSlop={10}
      >
        {busy ? <ActivityIndicator color={colors.brand} style={{ width: 26 }} /> : <Ionicons name={done ? "checkmark-circle" : "ellipse-outline"} size={26} color={!task.can_work ? colors.line : done ? colors.success : colors.muted} />}
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={[styles.body, done && { color: colors.muted, textDecorationLine: "line-through" }]}>{task.title}</Text>
        {(task.due || task.company) && (
          <Text style={[styles.small, late && { color: colors.danger }]}>
            {task.due ? (late ? `Was due ${dayLabel(task.due)}` : `Due ${dayLabel(task.due)}`) : ""}
            {task.due && task.company ? " · " : ""}
            {task.company ?? ""}
          </Text>
        )}
      </View>
    </View>
  );
}
