"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Cake, CalendarHeart, Eye, EyeOff, Plus, Trash2, Upload, X } from "lucide-react";
import type { CelebrationAudience, CelebrationKind } from "@prisma/client";
import type { listCelebrations, upcomingOccasions } from "@/actions/celebration";
import { deleteCelebration, saveCelebration, setCelebrationActive } from "@/actions/celebration";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";
import { toKey } from "@/lib/hr/calendar";

type Celebration = Awaited<ReturnType<typeof listCelebrations>>[number];
type Upcoming = Awaited<ReturnType<typeof upcomingOccasions>>[number];

const KINDS: { value: CelebrationKind; label: string; hint: string }[] = [
  { value: "ACHIEVEMENT", label: "Achievement", hint: "Something a person or team pulled off." },
  { value: "FESTIVAL", label: "Festival greeting", hint: "Diwali, Holi, Eid, Christmas — a greeting in your own words." },
  { value: "MILESTONE", label: "Company milestone", hint: "A target hit, a birthday for the company itself." },
  { value: "WELCOME", label: "Welcome", hint: "Somebody has joined." },
  { value: "ANNOUNCEMENT", label: "Announcement", hint: "Anything else worth everyone's screen." },
];

const AUDIENCES: { value: CelebrationAudience; label: string; hint: string }[] = [
  { value: "EVERYONE", label: "Everyone", hint: "The whole company sees it." },
  { value: "DEPARTMENT", label: "One team", hint: "Only that team sees it." },
  { value: "PERSON", label: "One person", hint: "Only they see it — use this for something personal." },
];

const KIND_TONE: Record<CelebrationKind, "green" | "amber" | "blue" | "brand" | "default"> = {
  ACHIEVEMENT: "green",
  FESTIVAL: "amber",
  MILESTONE: "blue",
  WELCOME: "brand",
  ANNOUNCEMENT: "default",
};

const SWATCHES = ["#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ef4444", "#06b6d4"];

/**
 * What HR writes by hand, and what the app already knows.
 *
 * Birthdays and anniversaries are deliberately read-only here. They come off the employee record,
 * and giving HR a second place to enter them would guarantee the two drift — this page shows them
 * so somebody can plan, not so they can be retyped.
 */
export function CelebrationsManager({
  celebrations,
  upcoming,
  departments,
  people,
}: {
  celebrations: Celebration[];
  upcoming: Upcoming[];
  departments: { id: string; name: string }[];
  people: { id: string; name: string }[];
}) {
  const router = useRouter();
  const today = useClock().today();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Celebration | null>(null);
  const [creating, setCreating] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="overflow-hidden p-0">
            <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
              <span>Posted</span>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Post something
              </Button>
            </CardHeader>

            {celebrations.length === 0 ? (
              <CardContent className="py-10 text-center text-sm text-subtle">
                Nothing posted. Birthdays, anniversaries and holidays appear on their own — this is for the things the
                app can&apos;t know about, like a team hitting a target.
              </CardContent>
            ) : (
              <ul className="divide-y divide-line">
                {celebrations.map((c) => {
                  // Days, compared as days: its last day before the workspace's today. The browser's
                  // midnight called one finished on its last day west of UTC.
                  const over = toKey(c.endsOn) < today;
                  return (
                    <li key={c.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                      <span
                        className="mt-1 h-8 w-1 shrink-0 rounded-full"
                        style={{ backgroundColor: c.accent || "var(--color-line-strong, #94a3b8)" }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-text">{c.title}</span>
                          <Badge tone={KIND_TONE[c.kind]}>
                            {KINDS.find((k) => k.value === c.kind)?.label ?? c.kind}
                          </Badge>
                          {!c.active && <Badge tone="default">Hidden</Badge>}
                          {over && c.active && <Badge tone="default">Finished</Badge>}
                        </div>
                        {c.message && <p className="mt-0.5 text-sm text-muted">{c.message}</p>}
                        <p className="mt-0.5 text-xs text-subtle">
                          {formatCalendarDay(c.startsOn)}
                          {toKey(c.startsOn) !== toKey(c.endsOn) && ` – ${formatCalendarDay(c.endsOn)}`}
                          {" · "}
                          {c.audience === "EVERYONE"
                            ? "everyone"
                            : c.audience === "DEPARTMENT"
                              ? (c.department?.name ?? "a team")
                              : (c.subject?.name ?? "one person")}
                          {c.audience === "EVERYONE" && c.subject && ` · about ${c.subject.name}`}
                          {c.createdBy && ` · ${c.createdBy.name}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => setCelebrationActive(c.id, !c.active))}
                          className="rounded-base p-1.5 text-subtle transition-colors hover:bg-surface-sunken hover:text-text"
                          aria-label={c.active ? `Hide ${c.title}` : `Show ${c.title}`}
                          title={c.active ? "Hide it" : "Show it again"}
                        >
                          {c.active ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(c)}
                          className="rounded-base px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-sunken hover:text-text"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => deleteCelebration(c.id))}
                          className="rounded-base p-1.5 text-subtle transition-colors hover:text-danger"
                          aria-label={`Delete ${c.title}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <Card className="overflow-hidden p-0">
          <CardHeader className="text-sm font-medium text-text">Coming up</CardHeader>
          {upcoming.length === 0 ? (
            <CardContent className="py-8 text-center text-sm text-subtle">
              Nothing in the next month. Birthdays only appear for people with a date of birth on their record.
            </CardContent>
          ) : (
            <ul className="divide-y divide-line">
              {upcoming.map((u) => (
                <li key={`${u.userId}:${u.kind}`} className="flex items-center gap-2.5 px-4 py-2.5">
                  {u.kind === "BIRTHDAY" ? (
                    <Cake className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  ) : (
                    <CalendarHeart className="h-3.5 w-3.5 shrink-0 text-subtle" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text">{u.name}</span>
                    <span className="block text-xs text-subtle">
                      {u.kind === "BIRTHDAY" ? "Birthday" : `${u.years} years`} · {formatCalendarDay(u.on)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {u.inDays === 0 ? "today" : `${u.inDays}d`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {(creating || editing) && (
        <CelebrationDialog
          celebration={editing}
          departments={departments}
          people={people}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function CelebrationDialog({
  celebration,
  departments,
  people,
  onClose,
  onSaved,
}: {
  celebration: Celebration | null;
  departments: { id: string; name: string }[];
  people: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const today = useClock().today();

  const [form, setForm] = useState({
    kind: (celebration?.kind ?? "ACHIEVEMENT") as CelebrationKind,
    audience: (celebration?.audience ?? "EVERYONE") as CelebrationAudience,
    title: celebration?.title ?? "",
    message: celebration?.message ?? "",
    accent: celebration?.accent ?? "",
    subjectUserId: celebration?.subjectUserId ?? "",
    departmentId: celebration?.departmentId ?? "",
    // The days the columns hold. They arrive as Dates, and String() of one is "Fri Oct 02 …", not a date.
    startsOn: celebration ? toKey(celebration.startsOn) : today,
    endsOn: celebration ? toKey(celebration.endsOn) : today,
  });
  const [image, setImage] = useState<{ name: string; fileDataUrl: string; mimeType: string } | null | undefined>(
    undefined,
  );
  const preview = image === null ? null : (image?.fileDataUrl ?? celebration?.imageDataUrl ?? null);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveCelebration({
        ...(celebration ? { id: celebration.id } : {}),
        ...form,
        ...(image !== undefined ? { image } : {}),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved();
    });
  }

  const kindHint = KINDS.find((k) => k.value === form.kind)?.hint;
  const audienceHint = AUDIENCES.find((a) => a.value === form.audience)?.hint;

  return (
    <Dialog open onClose={onClose} title={celebration ? "Edit" : "Post a celebration"}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="kind">What kind</Label>
            <Select id="kind" value={form.kind} onChange={set("kind")}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
            {kindHint && <p className="text-xs text-subtle">{kindHint}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audience">Who sees it</Label>
            <Select id="audience" value={form.audience} onChange={set("audience")}>
              {AUDIENCES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
            {audienceHint && <p className="text-xs text-subtle">{audienceHint}</p>}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={form.title}
            onChange={set("title")}
            placeholder="Support cleared every ticket this week"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="message">Message</Label>
          <Textarea id="message" rows={2} value={form.message} onChange={set("message")} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {form.audience === "DEPARTMENT" && (
            <div className="space-y-1.5">
              <Label htmlFor="dept">Team</Label>
              <Select id="dept" value={form.departmentId} onChange={set("departmentId")}>
                <option value="">Choose…</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="subject">Who it&apos;s about</Label>
            <Select id="subject" value={form.subjectUserId} onChange={set("subjectUserId")}>
              <option value="">Nobody in particular</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle">Their name appears on the card.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="from">Shows from</Label>
            <Input id="from" type="date" value={form.startsOn} onChange={set("startsOn")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to">Until</Label>
            <Input id="to" type="date" value={form.endsOn} onChange={set("endsOn")} />
            <p className="text-xs text-subtle">Same day for a one-day occasion.</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Colour</Label>
          <div className="flex flex-wrap items-center gap-2">
            {SWATCHES.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => setForm((f) => ({ ...f, accent: hex }))}
                aria-label={`Use ${hex}`}
                className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 ${
                  form.accent === hex ? "border-text" : "border-transparent"
                }`}
                style={{ backgroundColor: hex }}
              />
            ))}
            {form.accent && (
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, accent: "" }))}
                className="text-xs text-subtle hover:text-text"
              >
                Default
              </button>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Image</Label>
          <div className="flex flex-wrap items-center gap-3">
            {preview && (
              <span className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URL held in state */}
                <img src={preview} alt="" className="h-16 w-auto rounded-base border border-line object-contain" />
                <button
                  type="button"
                  onClick={() => setImage(null)}
                  aria-label="Remove image"
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-surface p-0.5 text-subtle shadow hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () =>
                  setImage({ name: file.name, fileDataUrl: String(reader.result), mimeType: file.type });
                reader.readAsDataURL(file);
                e.target.value = "";
              }}
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {preview ? "Replace" : "Add an image"}
            </Button>
          </div>
          <p className="text-xs text-subtle">Optional, up to 4 MB. Shown instead of the icon.</p>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={pending || !form.title.trim()} onClick={submit}>
            {pending ? "Saving…" : celebration ? "Save" : "Post it"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
