import { useCallback, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { Button, Card, Heading, Notice, colors, styles } from "@/components/ui";
import { StagePill } from "@/components/sales";
import { api } from "@/lib/api";
import { clockTime, keyOf } from "@/lib/format";
import { whereAmI } from "@/lib/location";
import type { CalendarItem, VisitRow } from "@/lib/field-types";
import { useSession } from "@/lib/session";

/** The field-work screens' own parts (owner, 22 Oct 2026 — phase 2 of the native app). */

/**
 * Arrived: the visit checked in, with where the phone is if it will say — asked then, only then, and never waited on
 * for long (src/lib/location.ts whereAmI). The server keeps the place with the visit for whoever may open it.
 */
export async function checkIn(visitId: string): Promise<{ placeKept: boolean }> {
  const place = await whereAmI();
  const done = await api<{ place_kept: boolean }>("POST", `/api/app/visits/${encodeURIComponent(visitId)}/check-in`, place ? { latitude: place.latitude, longitude: place.longitude, accuracy: place.accuracy, mocked: place.mocked } : {});
  return { placeKept: done.place_kept };
}

/** Left, and what came of it — with where the phone is then, the same way. */
export async function checkOut(visitId: string, outcome: string, distanceKm: number | null): Promise<{ placeKept: boolean }> {
  const place = await whereAmI();
  const done = await api<{ place_kept: boolean }>("POST", `/api/app/visits/${encodeURIComponent(visitId)}/complete`, {
    outcome,
    ...(distanceKm !== null ? { distance_km: distanceKm } : {}),
    ...(place ? { latitude: place.latitude, longitude: place.longitude, accuracy: place.accuracy, mocked: place.mocked } : {}),
  });
  return { placeKept: done.place_kept };
}

/** Colour of a visit's status: done green, didn't happen red, under way the brand's. */
export const visitTone = (status: string) => (status === "COMPLETED" ? "WON" : status === "CANCELLED" || status === "NO_SHOW" ? "LOST" : null);

export function VisitLine({ visit, onPress, right }: { visit: VisitRow; onPress: () => void; right?: React.ReactNode }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 }, pressed && { opacity: 0.7 }]}>
      <View style={{ width: 78 }}>
        <Text style={[styles.body, { fontWeight: "700" }]}>{clockTime(visit.scheduled_for)}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.body, { fontWeight: "600" }]} numberOfLines={1}>
          {visit.company?.name ?? "A visit"}
        </Text>
        <Text style={styles.small} numberOfLines={1}>
          {[visit.purpose_label, visit.contact?.name].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {right ?? <StagePill name={visit.status_label} status={visitTone(visit.status)} />}
    </Pressable>
  );
}

/**
 * Today's field work on the home screen: the visits planned for today — checked in from here at the customer's door —
 * and the day's meetings, each with its link to join. Only what the person may open (/me).
 */
export function FieldToday({ reload }: { reload: number }) {
  const router = useRouter();
  const { me } = useSession();
  const [visits, setVisits] = useState<VisitRow[] | null>(null);
  const [meetings, setMeetings] = useState<CalendarItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const canVisits = me?.can.visits === true;
  const canCalendar = me?.can.calendar === true;

  const load = useCallback(async () => {
    const today = keyOf(new Date());
    try {
      if (canVisits) setVisits(await api<VisitRow[]>("GET", "/api/app/visits?view=today"));
      if (canCalendar) setMeetings((await api<CalendarItem[]>("GET", `/api/app/meetings?from=${today}&to=${today}`)).filter((m) => m.kind === "meeting" && m.status !== "CANCELLED"));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't load today's visits.");
    }
  }, [canVisits, canCalendar]);

  useFocusEffect(
    useCallback(() => {
      void load();
      // `reload` is the home screen's pull-to-refresh.
    }, [load, reload]), // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (!canVisits && !canCalendar) return null;

  async function arrive(v: VisitRow) {
    setBusy(v.id);
    setProblem(null);
    try {
      const { placeKept } = await checkIn(v.id);
      if (!placeKept) setProblem("Checked in. The phone didn't say where it is, so no place was kept with the visit.");
      await load();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't check in.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {canVisits && (
        <>
          <Heading count={visits?.length}>Visits today</Heading>
          <Card>
            {visits && visits.length === 0 ? <Notice>No visits planned for today.</Notice> : null}
            {visits?.map((v) => (
              <VisitLine
                key={v.id}
                visit={v}
                onPress={() => router.push({ pathname: "/visit/[id]", params: { id: v.id } })}
                right={v.status === "PLANNED" ? <Button title="Check in" busy={busy === v.id} onPress={() => void arrive(v)} style={{ minHeight: 36, paddingHorizontal: 12 }} /> : undefined}
              />
            ))}
            {problem && <Notice tone="warning">{problem}</Notice>}
            <View style={[styles.row, { gap: 8 }]}>
              <Button title="Plan a visit" kind="secondary" onPress={() => router.push("/new-visit")} style={{ flex: 1 }} />
              <Button title="All visits" kind="secondary" onPress={() => router.push("/visits")} style={{ flex: 1 }} />
            </View>
          </Card>
        </>
      )}
      {canCalendar && meetings && meetings.length > 0 && (
        <>
          <Heading count={meetings.length}>Meetings today</Heading>
          <Card>
            {meetings.map((m) => (
              <View key={m.id} style={[styles.row, { paddingVertical: 6 }]}>
                <Text style={[styles.body, { fontWeight: "700", width: 78 }]}>{m.all_day ? "All day" : clockTime(m.starts_at)}</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.body, { fontWeight: "600" }]} numberOfLines={1}>
                    {m.title}
                  </Text>
                  {m.location ? (
                    <Text style={styles.small} numberOfLines={1}>
                      {m.location}
                    </Text>
                  ) : null}
                </View>
                {m.join_url ? (
                  <Pressable accessibilityRole="link" accessibilityLabel={`Join ${m.title}`} onPress={() => void Linking.openURL(m.join_url!)} hitSlop={8}>
                    <Ionicons name="videocam" size={22} color={colors.brand} />
                  </Pressable>
                ) : null}
              </View>
            ))}
            <Button title="My calendar" kind="secondary" onPress={() => router.push("/meetings")} />
          </Card>
        </>
      )}
    </>
  );
}
