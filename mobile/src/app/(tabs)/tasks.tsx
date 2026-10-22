import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Button, Card, Chip, Notice, colors, styles } from "@/components/ui";
import { TaskRow } from "@/components/task-row";
import { api, type Task } from "@/lib/api";
import { keyOf } from "@/lib/format";

/**
 * The person's own tasks (owner, 18 Oct 2026): due today, overdue, everything open, done — ticked off with a tap,
 * and a quick one added for themselves. Everything else about a task is on its web page, under More.
 */

const VIEWS = [
  { value: "today", label: "Today" },
  { value: "overdue", label: "Overdue" },
  { value: "open", label: "All open" },
  { value: "done", label: "Complete" },
] as const;

type View_ = (typeof VIEWS)[number]["value"];

const EMPTY: Record<View_, string> = {
  today: "Nothing due today.",
  overdue: "Nothing overdue.",
  open: "No open tasks. Add one above.",
  done: "Nothing done yet.",
};

export default function TasksScreen() {
  const [view, setView] = useState<View_>("today");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (which: View_) => {
    setLoading(true);
    setProblem(null);
    try {
      setTasks(await api<Task[]>("GET", `/api/app/tasks?view=${which}`));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't load your tasks.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(view);
    }, [load, view]),
  );

  async function add() {
    const text = title.trim();
    if (!text) return;
    setAdding(true);
    setProblem(null);
    try {
      // Added from Today or Overdue, it's due today; otherwise, whenever.
      await api("POST", "/api/app/tasks", { title: text, due: view === "today" || view === "overdue" ? keyOf(new Date()) : undefined });
      setTitle("");
      if (view === "overdue" || view === "done") setView("today");
      else void load(view);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't add it.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load(view)} />}>
      <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
        {VIEWS.map((v) => (
          <Chip key={v.value} label={v.label} selected={view === v.value} onPress={() => setView(v.value)} />
        ))}
      </View>

      <View style={styles.row}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={title}
          onChangeText={setTitle}
          placeholder={view === "today" || view === "overdue" ? "A task for today" : "A new task"}
          placeholderTextColor={colors.muted}
          returnKeyType="done"
          onSubmitEditing={() => void add()}
          maxLength={200}
        />
        <Button title="Add" busy={adding} disabled={!title.trim()} onPress={() => void add()} />
      </View>

      {problem && <Notice tone="danger">{problem}</Notice>}

      {tasks && (
        <Card>
          {tasks.length === 0 ? (
            <Notice>{EMPTY[view]}</Notice>
          ) : (
            tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                onProblem={setProblem}
                onChanged={(changed) => setTasks((now) => (now ?? []).map((x) => (x.id === changed.id ? changed : x)))}
              />
            ))
          )}
        </Card>
      )}
    </ScrollView>
  );
}
