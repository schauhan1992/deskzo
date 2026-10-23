import { useState } from "react";
import { ScrollView } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Heading, Notice, styles } from "@/components/ui";
import { Field } from "@/components/sales";
import { api, ApiError } from "@/lib/api";
import type { Company } from "@/lib/sales-types";

/**
 * A new company from the phone (owner, 22 Oct 2026 — the app made native): its name, where it is, and the first
 * person there — added as a client, by the web's own rules: a name already in Deskzo is refused, and the person who
 * adds it owns it (POST /api/app/companies). Everything else about it is on its web page.
 *
 * `?then=lead` came from a new lead: the lead goes on with it.
 */
export default function NewCompanyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ then?: string; name?: string }>();
  const [name, setName] = useState(params.name ?? "");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [pincode, setPincode] = useState("");
  const [person, setPerson] = useState("");
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
      const address = { city: city.trim(), state: state.trim(), pincode: pincode.trim() };
      const hasAddress = address.city || address.state || address.pincode;
      const made = await api<Company>("POST", "/api/app/companies", {
        name: name.trim(),
        relationship_type: "CLIENT",
        ...(hasAddress ? { address: { ...Object.fromEntries(Object.entries(address).filter(([, v]) => v)), country: "India" } } : {}),
        ...(person.trim() ? { contacts: [{ name: person.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}), is_primary: true }] } : {}),
      });
      if (params.then === "lead") router.replace({ pathname: "/new-lead", params: { company: made.ref, name: made.name } });
      else router.replace({ pathname: "/company/[ref]", params: { ref: made.ref } });
    } catch (e) {
      if (e instanceof ApiError && e.fields) setFields(e.fields);
      setProblem(e instanceof Error ? e.message : "Couldn't add the company.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Field label="Company name" value={name} onChangeText={setName} placeholder="As it's registered" maxLength={200} autoFocus={!params.name} error={fields.name} />
      <Field label="City" value={city} onChangeText={setCity} maxLength={120} />
      <Field label="State" value={state} onChangeText={setState} maxLength={120} />
      <Field label="PIN code" value={pincode} onChangeText={setPincode} keyboardType="number-pad" maxLength={6} />

      <Heading>The first person there</Heading>
      <Field label="Name" value={person} onChangeText={setPerson} maxLength={160} placeholder="Optional" />
      <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={40} />
      <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" maxLength={200} />

      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button title="Add company" busy={busy} disabled={name.trim().length < 2} onPress={() => void save()} />
    </ScrollView>
  );
}
