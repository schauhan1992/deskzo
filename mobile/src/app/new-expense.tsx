import { useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Heading, Notice, colors, styles } from "@/components/ui";
import { RangeCalendar } from "@/components/calendar";
import { Field, money } from "@/components/sales";
import { api, ApiError, upload } from "@/lib/api";
import { dayLabel, keyOf } from "@/lib/format";
import type { ExpenseOptions } from "@/lib/field-types";
import { shrinkReceipt, type Receipt } from "@/lib/receipt";

/**
 * A claim from the phone (owner, 22 Oct 2026 — field work): what it was for, how much, when and how it was paid —
 * against a visit when it's for one — and a photo of the receipt, made small enough to keep. Saved to finish later,
 * or submitted; over the amount an administrator sets (Settings › Expense approvals), a claim needs its receipt.
 * The web's own rules (POST /api/app/expenses, sent as a form: a receipt is bigger than a JSON body may be).
 */
export default function NewExpenseScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ visit?: string; name?: string }>();
  const [options, setOptions] = useState<ExpenseOptions | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(keyOf(new Date()));
  const [pickDay, setPickDay] = useState(false);
  const [description, setDescription] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [shrinking, setShrinking] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "submit">(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    void api<ExpenseOptions>("GET", "/api/app/expenses/options")
      .then((o) => {
        setOptions(o);
        setCategory(o.categories.find((c) => c.value === (params.visit ? "TRAVEL" : "OTHER"))?.value ?? o.categories[0]?.value ?? null);
        setMode(o.payment_modes[0]?.value ?? null);
      })
      .catch((e) => setProblem(e instanceof Error ? e.message : "Couldn't load the claim's choices."));
  }, [params.visit]);

  const value = Number(amount.replace(/[,\s₹]/g, ""));
  const above = options?.receipt_required_above ?? null;
  const needsReceipt = above !== null && Number.isFinite(value) && value > above;

  async function take(from: "camera" | "photos") {
    setProblem(null);
    let picked: ImagePicker.ImagePickerResult;
    if (from === "camera") {
      const allowed = await ImagePicker.requestCameraPermissionsAsync();
      if (!allowed.granted) return setProblem("The camera wasn't allowed. Pick the photo from the gallery instead, or allow the camera in the phone's settings.");
      picked = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
    } else {
      picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    }
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;
    setShrinking(true);
    try {
      const small = await shrinkReceipt(asset.uri, options?.receipt_max_bytes ?? 512 * 1024);
      if (small) setReceipt(small);
      else setProblem("That photo couldn't be made small enough to keep. Try another, closer to the receipt.");
    } catch {
      setProblem("Couldn't read that photo. Try another.");
    } finally {
      setShrinking(false);
    }
  }

  function addReceipt() {
    Alert.alert("The receipt", undefined, [
      { text: "Take a photo", onPress: () => void take("camera") },
      { text: "From the gallery", onPress: () => void take("photos") },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function save(submit: boolean) {
    setBusy(submit ? "submit" : "save");
    setProblem(null);
    setFields({});
    try {
      const form = new FormData();
      if (category) form.append("category", category);
      if (mode) form.append("payment_mode", mode);
      form.append("amount", amount.replace(/[,\s₹]/g, ""));
      form.append("spent_on", day);
      form.append("description", description.trim());
      if (params.visit) form.append("visit", params.visit);
      if (submit) form.append("submit", "true");
      // React Native's FormData takes a file as its uri, name and type.
      if (receipt) form.append("receipt", { uri: receipt.uri, name: "receipt.jpg", type: "image/jpeg" } as unknown as Blob);
      await upload<{ id: string; ref: string }>("/api/app/expenses", form);
      router.replace("/expenses");
    } catch (e) {
      if (e instanceof ApiError && e.fields) setFields(e.fields);
      setProblem(e instanceof Error ? e.message : "Couldn't save the claim.");
    } finally {
      setBusy(null);
    }
  }

  const ready = !!options && Number.isFinite(value) && value > 0 && description.trim().length > 0;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {params.visit ? (
        <Card>
          <Text style={styles.small}>For the visit to</Text>
          <Text style={[styles.body, { fontWeight: "700" }]}>{params.name || "a customer"}</Text>
        </Card>
      ) : null}

      {options && (
        <>
          <Heading>What for</Heading>
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
            {options.categories.map((c) => (
              <Chip key={c.value} label={c.label} selected={category === c.value} onPress={() => setCategory(c.value)} />
            ))}
          </View>
        </>
      )}

      <Field label="Amount (₹)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0" error={fields.amount} />
      <Field label="What it was" value={description} onChangeText={setDescription} placeholder="Cab to the customer and back" maxLength={500} error={fields.description} />

      <View style={{ gap: 6 }}>
        <Text style={[styles.small, { color: colors.text, fontWeight: "600" }]}>Spent on</Text>
        {pickDay ? (
          <RangeCalendar from={day} to={day} onChange={(d) => (d && setDay(d), setPickDay(false))} />
        ) : (
          <Button title={dayLabel(day)} kind="secondary" onPress={() => setPickDay(true)} />
        )}
      </View>

      {options && (
        <>
          <Heading>Paid by</Heading>
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
            {options.payment_modes.map((m) => (
              <Chip key={m.value} label={m.label} selected={mode === m.value} onPress={() => setMode(m.value)} />
            ))}
          </View>
        </>
      )}

      <Heading>Receipt</Heading>
      <Card>
        {receipt ? (
          <View style={{ gap: 8 }}>
            <Image source={{ uri: receipt.uri }} style={{ width: "100%", aspectRatio: receipt.width / Math.max(receipt.height, 1), borderRadius: 8 }} resizeMode="contain" accessibilityLabel="The receipt photo" />
            <View style={[styles.row, { justifyContent: "space-between" }]}>
              <Text style={styles.small}>{Math.round(receipt.size / 1024)} KB</Text>
              <Pressable accessibilityRole="button" onPress={() => setReceipt(null)} hitSlop={8}>
                <Text style={{ color: colors.danger, fontWeight: "600" }}>Remove</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Button title="Add a photo of the receipt" kind="secondary" busy={shrinking} onPress={addReceipt} />
        )}
        {above !== null && <Notice tone={needsReceipt && !receipt ? "warning" : "muted"}>A claim over {money(above)} needs its receipt to be submitted.</Notice>}
      </Card>

      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button title="Submit for approval" busy={busy === "submit"} disabled={!ready || busy !== null || shrinking || (needsReceipt && !receipt)} onPress={() => void save(true)} />
      <Button title="Save to finish later" kind="secondary" busy={busy === "save"} disabled={!ready || busy !== null || shrinking} onPress={() => void save(false)} />
    </ScrollView>
  );
}
