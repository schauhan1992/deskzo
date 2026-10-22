import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { colors } from "@/components/ui";
import { fileSize } from "@/lib/chat-format";
import { MAX_FILES_BYTES, type ChatMessageView } from "@/lib/chat-types";

/**
 * Writing a message, as WhatsApp's bar: what it answers (or that it edits) above, files to go with it, a field that
 * grows to six lines, @names offered in a group, the attach button and the round send button.
 */

export type Picked = { uri: string; name: string; type: string; size: number };

export function Composer({
  members,
  reply,
  editing,
  closed,
  onCancel,
  onSend,
  onEdit,
  onTyping,
}: {
  /** A group's other members, for @mentions; nothing in a chat of two. */
  members: { userId: string; name: string }[];
  reply: ChatMessageView | null;
  editing: ChatMessageView | null;
  /** Why nothing can be sent here, if nothing can. */
  closed: string | null;
  onCancel: () => void;
  onSend: (text: string, files: Picked[]) => void;
  onEdit: (text: string) => Promise<boolean>;
  onTyping: () => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Picked[]>([]);
  const [saving, setSaving] = useState(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);

  useEffect(() => {
    if (editing) {
      setText(editing.body);
      input.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (reply) input.current?.focus();
  }, [reply]);

  const mention = /(^|\s)@([^\s@]*)$/.exec(text);
  const suggestions = mention ? members.filter((m) => m.name.toLowerCase().startsWith(mention[2]!.toLowerCase())).slice(0, 5) : [];

  function add(more: Picked[]) {
    const next = [...files, ...more].slice(0, 5);
    if (next.reduce((n, f) => n + f.size, 0) > MAX_FILES_BYTES) {
      Alert.alert("Too big", "Files can come to 5 MB at most on one message.");
      return;
    }
    setFiles(next);
  }

  async function camera() {
    const allowed = await ImagePicker.requestCameraPermissionsAsync();
    if (!allowed.granted) return;
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.6 });
    if (!r.canceled) add(r.assets.map((a, i) => ({ uri: a.uri, name: a.fileName ?? `photo-${Date.now()}-${i}.jpg`, type: a.mimeType ?? "image/jpeg", size: a.fileSize ?? 0 })));
  }

  async function photos() {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.6, allowsMultipleSelection: true, selectionLimit: 5 });
    if (!r.canceled) add(r.assets.map((a, i) => ({ uri: a.uri, name: a.fileName ?? `photo-${Date.now()}-${i}.jpg`, type: a.mimeType ?? "image/jpeg", size: a.fileSize ?? 0 })));
  }

  async function document() {
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (!r.canceled) add(r.assets.map((a) => ({ uri: a.uri, name: a.name, type: a.mimeType ?? "application/octet-stream", size: a.size ?? 0 })));
  }

  function attach() {
    Alert.alert("Send", undefined, [
      { text: "Camera", onPress: () => void camera() },
      { text: "Photos", onPress: () => void photos() },
      { text: "Document", onPress: () => void document() },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function send() {
    const body = text.trim();
    if (editing) {
      if (!body || body === editing.body) return onCancel();
      setSaving(true);
      const done = await onEdit(body);
      setSaving(false);
      if (done) setText("");
      return;
    }
    if (!body && files.length === 0) return;
    onSend(body, files);
    setText("");
    setFiles([]);
  }

  if (closed) {
    return (
      <View style={s.closed}>
        <Text style={s.closedText}>{closed}</Text>
      </View>
    );
  }

  const canSend = !!text.trim() || files.length > 0;
  return (
    <View style={s.wrap}>
      {suggestions.length > 0 && (
        <View style={s.suggestions}>
          {suggestions.map((m) => (
            <Pressable
              key={m.userId}
              style={s.suggestion}
              onPress={() => setText((t) => t.replace(/@([^\s@]*)$/, `@${m.name} `))}
              accessibilityRole="button"
              accessibilityLabel={`Mention ${m.name}`}
            >
              <Text style={s.suggestionText}>{m.name}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={s.bar}>
        <View style={s.field}>
          {(reply || editing) && (
            <View style={s.context}>
              <View style={{ flex: 1 }}>
                <Text style={s.contextTitle}>{editing ? "Edit message" : (reply!.senderName ?? "Former colleague")}</Text>
                <Text style={s.contextBody} numberOfLines={1}>
                  {(editing ?? reply)!.body || "📎 Attachment"}
                </Text>
              </View>
              <Pressable accessibilityLabel="Cancel" onPress={() => (onCancel(), editing && setText(""))} hitSlop={10}>
                <Ionicons name="close" size={20} color={colors.muted} />
              </Pressable>
            </View>
          )}
          {files.length > 0 && (
            <ScrollView horizontal style={s.files} contentContainerStyle={{ gap: 8, padding: 6 }}>
              {files.map((f, i) => (
                <View key={`${f.uri}-${i}`} style={s.fileChip}>
                  {f.type.startsWith("image/") ? <Image source={{ uri: f.uri }} style={s.thumb} /> : <Ionicons name="document-text" size={26} color={colors.brand} />}
                  <View style={{ maxWidth: 110 }}>
                    <Text style={s.fileName} numberOfLines={1}>
                      {f.name}
                    </Text>
                    <Text style={s.fileSize}>{fileSize(f.size)}</Text>
                  </View>
                  <Pressable accessibilityLabel={`Remove ${f.name}`} onPress={() => setFiles((now) => now.filter((_, j) => j !== i))} hitSlop={8}>
                    <Ionicons name="close-circle" size={18} color={colors.muted} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
          <View style={s.row}>
            <TextInput
              ref={input}
              style={s.input}
              value={text}
              onChangeText={(t) => {
                setText(t);
                if (t.length > text.length) onTyping();
              }}
              placeholder="Message"
              placeholderTextColor={colors.muted}
              multiline
              maxLength={4000}
              accessibilityLabel="Message"
            />
            {!editing && (
              <Pressable accessibilityRole="button" accessibilityLabel="Attach" onPress={attach} hitSlop={8} style={s.attach}>
                <Ionicons name="attach" size={24} color={colors.muted} style={{ transform: [{ rotate: "-45deg" }] }} />
              </Pressable>
            )}
          </View>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={editing ? "Save" : "Send"} onPress={() => void send()} disabled={!canSend || saving} style={[s.send, !canSend && { opacity: 0.5 }]}>
          {saving ? <ActivityIndicator color="#fff" /> : <Ionicons name={editing ? "checkmark" : "send"} size={20} color="#fff" style={editing ? undefined : { marginLeft: 3 }} />}
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 6, paddingTop: 4, paddingBottom: 6 },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  field: { flex: 1, backgroundColor: colors.surface, borderRadius: 24, overflow: "hidden", elevation: 1 },
  row: { flexDirection: "row", alignItems: "flex-end" },
  input: { flex: 1, minHeight: 46, maxHeight: 140, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12, fontSize: 16, color: colors.text },
  attach: { padding: 11 },
  send: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.brandFill, alignItems: "center", justifyContent: "center" },
  context: { flexDirection: "row", alignItems: "center", gap: 8, margin: 6, marginBottom: 0, padding: 8, borderRadius: 10, backgroundColor: colors.sunken, borderLeftWidth: 4, borderLeftColor: colors.brand },
  contextTitle: { fontSize: 13, fontWeight: "700", color: colors.brand },
  contextBody: { fontSize: 13, color: colors.muted },
  files: { maxHeight: 64 },
  fileChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.sunken, borderRadius: 10, padding: 6 },
  thumb: { width: 40, height: 40, borderRadius: 6 },
  fileName: { fontSize: 12, fontWeight: "600", color: colors.text },
  fileSize: { fontSize: 11, color: colors.muted },
  suggestions: { backgroundColor: colors.surface, borderRadius: 12, marginBottom: 6, elevation: 2, overflow: "hidden" },
  suggestion: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  suggestionText: { fontSize: 15, color: colors.text },
  closed: { padding: 14, backgroundColor: colors.surface, alignItems: "center" },
  closedText: { color: colors.muted, fontSize: 14, textAlign: "center" },
});
