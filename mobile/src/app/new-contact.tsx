import { useState } from "react";
import { ScrollView, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Notice, styles } from "@/components/ui";
import { Field } from "@/components/sales";
import { api, ApiError } from "@/lib/api";

/** Somebody at a company, added from its screen (owner, 22 Oct 2026): name, role, phone, email (POST /api/app/contacts). */
export default function NewContactScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ company: string; name?: string }>();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function save() {
    setBusy(true);
    setProblem(null);
    setFields({});
    try {
      await api("POST", "/api/app/contacts", {
        company: params.company,
        name: name.trim(),
        ...(role.trim() ? { designation_name: role.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      router.back();
    } catch (e) {
      if (e instanceof ApiError && e.fields) setFields(e.fields);
      setProblem(e instanceof Error ? e.message : "Couldn't add them.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {params.name ? (
        <Card>
          <Text style={styles.small}>At</Text>
          <Text style={[styles.body, { fontWeight: "700" }]}>{params.name}</Text>
        </Card>
      ) : null}
      <Field label="Name" value={name} onChangeText={setName} maxLength={160} autoFocus error={fields.name} />
      <Field label="Role" value={role} onChangeText={setRole} placeholder="IT head, purchase manager…" maxLength={80} />
      <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={40} error={fields.phone} />
      <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" maxLength={200} error={fields.email} />
      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button title="Add contact" busy={busy} disabled={!name.trim()} onPress={() => void save()} />
    </ScrollView>
  );
}
