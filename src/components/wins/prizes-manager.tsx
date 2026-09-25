"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Gift, ImagePlus, Megaphone, Trash2, X } from "lucide-react";
import type { PrizeRace } from "@prisma/client";
import { announcePrizesNow, deletePrize, savePrize, type PrizeRow } from "@/actions/prizes";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { shrinkImage } from "@/lib/shrink-image";
import { formatIstDateTime } from "@/lib/india-time";
import { cn } from "@/lib/utils";

type Notice = { tone: "success" | "error"; text: string } | null;

const MEDAL: Record<string, string> = { "1": "#f59e0b", "2": "#94a3b8", "3": "#b45309" };

/**
 * One race's prizes: the standing list, or the prizes planned for one month or fortnight, slot by
 * slot — and the button that tells everybody what is up for grabs right now.
 */
export function PrizesManager({
  race,
  title,
  blurb,
  slots,
  periods,
  prizes,
  isPublic,
  lastAnnounced,
}: {
  race: PrizeRace;
  title: string;
  blurb: string;
  slots: { slot: string; label: string }[];
  periods: { key: string; label: string }[];
  prizes: PrizeRow[];
  isPublic: boolean;
  lastAnnounced: Date | string | null;
}) {
  const router = useRouter();
  const [period, setPeriod] = useState("");
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const planned = new Set(prizes.filter((p) => p.period !== "").map((p) => p.period));
  const find = (p: string, slot: string) => prizes.find((x) => x.period === p && x.slot === slot) ?? null;
  const unit = race === "TOP_SELLERS" ? "month" : "fortnight";

  return (
    <Card>
      <CardHeader>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
          <Gift className="h-4 w-4" style={{ color: MEDAL["1"] }} aria-hidden /> {title}
        </h2>
        <p className="text-xs text-subtle">{blurb}</p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label={`Which ${unit}`} className="h-8 w-auto" value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">Standing — every {unit}</option>
            {periods.map((p, i) => (
              <option key={p.key} value={p.key}>
                {p.label}
                {i === 0 ? " (now)" : ""}
                {planned.has(p.key) ? " · planned" : ""}
              </option>
            ))}
          </Select>
          <span className="text-xs text-subtle">
            {period === "" ? `Given every ${unit} nothing is planned for.` : `Replaces the standing prize for this ${unit} only, place by place.`}
          </span>
        </div>

        <div className="mt-2">
          {slots.map((s) => (
            <SlotEditor
              key={`${period}:${s.slot}`}
              race={race}
              period={period}
              slot={s.slot}
              label={s.label}
              current={find(period, s.slot)}
              fallback={period ? find("", s.slot) : null}
            />
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
          <p className="max-w-xl text-xs text-subtle">
            {isPublic
              ? `Everybody is told automatically as each ${unit} opens, with a splash. Changed them mid-${unit}? Tell everybody again.`
              : race === "TOP_SELLERS"
                ? "The month's top performer is switched off above, so these prizes aren't announced or shown."
                : "The most-active awards are off or told to managers only, so these prizes aren't announced or shown."}
            {lastAnnounced ? ` Last announced ${formatIstDateTime(new Date(lastAnnounced))}.` : ""}
          </p>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending || !isPublic}
            onClick={() =>
              startTransition(async () => {
                const result = await announcePrizesNow(race);
                setNotice(result.ok ? { tone: "success", text: `Everybody has been told what's up for grabs in ${result.data.period}.` } : { tone: "error", text: result.error });
                if (result.ok) router.refresh();
              })
            }
          >
            <Megaphone className="h-3.5 w-3.5" />
            Announce now
          </Button>
        </div>
        {notice && <ActionNotice tone={notice.tone} className="mt-3">{notice.text}</ActionNotice>}
      </CardContent>
    </Card>
  );
}

function SlotEditor({
  race,
  period,
  slot,
  label,
  current,
  fallback,
}: {
  race: PrizeRace;
  period: string;
  slot: string;
  label: string;
  current: PrizeRow | null;
  fallback: PrizeRow | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(current?.name ?? "");
  const [note, setNote] = useState(current?.note ?? "");
  /** undefined: the picture is unchanged. null: remove it. A string: the new one. */
  const [image, setImage] = useState<string | null | undefined>(undefined);
  const [notice, setNotice] = useState<Notice>(null);
  const shown = image === undefined ? (current?.imageDataUrl ?? null) : image;
  const dirty = name.trim() !== (current?.name ?? "") || (note.trim() || null) !== (current?.note ?? null) || image !== undefined;

  return (
    <div className="grid gap-3 border-b border-line py-3 last:border-0 sm:grid-cols-[112px_1fr]">
      <div>
        <div className="relative grid aspect-[4/3] w-28 place-items-center overflow-hidden rounded-lg border border-line bg-surface-sunken">
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL; next/image has nothing to optimise
            <img src={shown} alt="" className="h-full w-full object-cover" />
          ) : (
            <Gift className="h-6 w-6 text-subtle" aria-hidden />
          )}
          {shown && (
            <button
              type="button"
              onClick={() => setImage(null)}
              aria-label={`Remove the picture for ${label}`}
              className="absolute right-1 top-1 rounded-full bg-surface/90 p-0.5 text-subtle shadow hover:text-danger"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              setImage(await shrinkImage(file));
              setNotice(null);
            } catch (err) {
              setNotice({ tone: "error", text: err instanceof Error ? err.message : "That picture couldn't be read." });
            }
          }}
        />
        <button type="button" onClick={() => fileRef.current?.click()} className="mt-1 inline-flex items-center gap-1 text-xs text-brand hover:underline">
          <ImagePlus className="h-3.5 w-3.5" aria-hidden /> {shown ? "Change picture" : "Add a picture"}
        </button>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className={cn("text-sm font-semibold", !MEDAL[slot] && "text-text")} style={MEDAL[slot] ? { color: MEDAL[slot] } : undefined}>
            {label}
          </span>
          {!current && fallback && <span className="text-xs text-subtle">Standing prize applies: {fallback.name}</span>}
        </div>
        <Input aria-label={`${label} — the prize`} placeholder={fallback?.name ?? "e.g. AirPods Pro"} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <Input aria-label={`${label} — a line about it`} placeholder="A line about it — optional" maxLength={160} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={pending || !dirty || !name.trim()}
            onClick={() =>
              startTransition(async () => {
                const result = await savePrize({ race, period, slot, name, note, image });
                setNotice(result.ok ? { tone: "success", text: "Saved." } : { tone: "error", text: result.error });
                if (result.ok) {
                  setImage(undefined);
                  router.refresh();
                }
              })
            }
          >
            Save
          </Button>
          {current && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await deletePrize({ race, period, slot });
                  setNotice(result.ok ? { tone: "success", text: period ? "Removed — the standing prize applies again." : "Removed." } : { tone: "error", text: result.error });
                  if (result.ok) {
                    setName("");
                    setNote("");
                    setImage(undefined);
                    router.refresh();
                  }
                })
              }
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          )}
          {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
        </div>
      </div>
    </div>
  );
}
