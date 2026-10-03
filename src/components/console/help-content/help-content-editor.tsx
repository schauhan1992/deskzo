"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, BookOpen, Check, LoaderCircle, Pin, PlayCircle, Plus } from "lucide-react";
import { consoleHelpReach, consoleSaveHelpLink, consoleSaveHelpPost } from "@/actions/platform/console-help";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { InsetBlock, Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { useClock } from "@/components/time/clock-provider";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { plural } from "@/lib/console-shared/format";
import type { Caps } from "@/lib/console-shared/roles";
import { COUNTRIES } from "@/lib/geo/countries";
import { checkLink, youtubeId } from "@/lib/help/links";
import type { PublicationState } from "@/lib/platform/help-content";
import type { Clock } from "@/lib/time/zone";
import { cn } from "@/lib/utils";
import {
  KIND_TITLE,
  KIND_WORD,
  TARGET_MODULES,
  TARGET_PRODUCTS,
  isEverywhere,
  linkText,
  productChosen,
  tabOf,
  targetingText,
  type HelpEditorChoices,
  type HelpEditorItem,
  type HelpItemKind,
  type TargetModule,
  type TargetProduct,
} from "./shared";
import { useReportUnsaved } from "./help-verb-dialog";

/**
 * The editor for one of Deskzo's help articles, walkthrough videos or What's new posts
 * (`/help-content/new`, `/help-content/[id]`): the form on the left; on the right how a workspace
 * shows it under "From Deskzo", how many open workspaces it reaches, and when.
 *
 * Who sees it is chosen as products — each stands for its own modules — or single modules, and
 * countries; nothing chosen is every workspace. Reach is asked of the server (`consoleHelpReach`,
 * the very rule a workspace reads by) 400 ms after the choice last changed, from the change handlers,
 * and a late answer for a choice since changed is dropped.
 *
 * Saving a draft just saves. Anything that will show — published now, scheduled, or kept live — is a
 * T2 confirmation saying what goes where and when; one that shows in every workspace also needs
 * "publish" typed unless an owner saves it, which the server checks again. The checks here mirror
 * the save's (src/actions/platform/console-help.ts) only to point at the field early; the save's
 * refusal is what is shown. Times are `datetime-local` values on the console's clock (Settings › Time
 * zone), as the server reads them.
 */

type Mode = "create" | "edit";
type Publish = "keep" | "draft" | "now" | "at";
type Field = "title" | "url" | "description" | "body" | "targets" | "publishAt";
type Problem = { field: Field; message: string };

type Draft = {
  title: string;
  /** An article's or video's link; a post's "read more". */
  url: string;
  description: string;
  body: string;
  pinned: boolean;
  modules: string[];
  countries: string[];
  publish: Publish;
  /** `yyyy-mm-ddThh:mm` on the console's clock; "" for none. */
  publishAt: string;
};

type Reach = { key: string; status: "loading" | "ready" | "error"; count: number; total: number; sample: string[] };

const REACH_DEBOUNCE_MS = 400;
const YEAR_MS = 365 * 86_400_000;
const REACH_FAILED = "Couldn't count the workspaces just now — it will try again when the choice changes.";

/** Characters as the database counts them — an emoji is one. */
const charCount = (s: string) => [...s].length;
const oneLine = (s: string) => s.trim().replace(/\s+/g, " ");
const reachKey = (modules: readonly string[], countries: readonly string[]) => `${[...modules].sort().join(",")}|${[...countries].sort().join(",")}`;

function draftOf(initial: HelpEditorItem | null): Draft {
  if (!initial) return { title: "", url: "", description: "", body: "", pinned: false, modules: [], countries: [], publish: "draft", publishAt: "" };
  return {
    title: initial.title,
    url: initial.url,
    description: initial.description,
    body: initial.body,
    pinned: initial.pinned,
    modules: [...initial.modules],
    countries: [...initial.countries],
    publish: "keep",
    publishAt: "",
  };
}

/** What the save leaves it as. */
function resultOf(publish: Publish, initial: HelpEditorItem | null): PublicationState {
  switch (publish) {
    case "keep":
      return initial?.state ?? "draft";
    case "draft":
      return "draft";
    case "now":
      return "live";
    case "at":
      return "scheduled";
  }
}

/**
 * Where a link from Deskzo may point, as far as the browser can tell: `checkLink`, and an https
 * address only on the allowlisted hosts, without a port. The save checks the whole rule again.
 */
function linkProblem(raw: string, choices: HelpEditorChoices): string | null {
  const checked = checkLink(raw);
  if (!checked.ok) return checked.error;
  if (/[\s\p{Cc}]/u.test(checked.url)) return "A link can't have spaces or line breaks in it.";
  if (checked.url.length > choices.limits.url) return "That link is too long.";
  if (!checked.external) return null;
  let host = "";
  let port = "";
  try {
    const parsed = new URL(checked.url);
    host = parsed.hostname;
    port = parsed.port;
  } catch {
    return "That isn't a link — start it with https:// or with / for a page in the app.";
  }
  const allowed = choices.linkHosts.includes(host) || host === choices.linkDomain || host.endsWith(`.${choices.linkDomain}`);
  if (port || !allowed) return `Links from Deskzo go to YouTube, Vimeo, Loom or ${choices.linkDomain}, or to a page in the app.`;
  return null;
}

/**
 * What stops a save. `now` is the moment Save was pressed (state, never the render's clock): the
 * check that a scheduled time is still ahead waits for it.
 */
function problemsOf(d: Draft, kind: HelpItemKind, choices: HelpEditorChoices, now: number | null, clock: Clock): Problem[] {
  const { limits } = choices;
  const out: Problem[] = [];
  const title = charCount(oneLine(d.title));
  if (title < limits.titleMin) out.push({ field: "title", message: `Give it a title of at least ${limits.titleMin} characters.` });
  else if (title > limits.titleMax) out.push({ field: "title", message: `Keep the title to ${limits.titleMax} characters.` });

  const url = d.url.trim();
  if (kind !== "POST" || url) {
    const problem = url ? linkProblem(url, choices) : "Add a link.";
    if (problem) out.push({ field: "url", message: problem });
  }
  if (kind === "POST") {
    const body = charCount(d.body.trim());
    if (body < 1) out.push({ field: "body", message: "Write what the post says." });
    else if (body > limits.body) out.push({ field: "body", message: `Keep the post to ${limits.body.toLocaleString("en-IN")} characters.` });
  } else if (charCount(oneLine(d.description)) > limits.description) {
    out.push({ field: "description", message: `Keep the description to ${limits.description} characters.` });
  }

  if (d.modules.length > limits.modules) out.push({ field: "targets", message: `Choose at most ${limits.modules} modules.` });
  if (d.countries.length > limits.countries) out.push({ field: "targets", message: `Choose at most ${limits.countries} countries.` });

  if (d.publish === "at") {
    const at = d.publishAt ? clock.parseInput(d.publishAt) : null;
    if (!at) out.push({ field: "publishAt", message: "Enter when it goes live as a date and time." });
    else if (now !== null && at.getTime() <= now) out.push({ field: "publishAt", message: "That time has already passed — publish it now, or choose a later time." });
    else if (now !== null && at.getTime() - now > YEAR_MS) out.push({ field: "publishAt", message: "That is more than a year away — check the date." });
  }
  return out;
}

/** The wall clock — for event handlers only; a render reads the time Save was pressed from state. */
function clockNow(): number {
  return Date.now();
}

/** "Thu, 1 Oct 2026, 10:00 am UTC+05:30" — on the console's clock, saying which. */
const zoned = (at: Date, clock: Clock) => `${clock.dateTime(at)} ${clock.offsetLabel(at)}`;

/** What the save sends — the same shape for both actions, which each read their own fields. */
function inputOf(d: Draft, kind: HelpItemKind, id: string | undefined) {
  const common = {
    ...(id ? { id } : {}),
    title: oneLine(d.title),
    modules: [...d.modules].sort(),
    countries: [...d.countries].sort(),
    publish: d.publish,
    ...(d.publish === "at" ? { publishAt: d.publishAt } : {}),
  };
  if (kind === "POST") return { ...common, body: d.body.replace(/\r\n?/g, "\n").trim(), linkUrl: d.url.trim() || null, pinned: d.pinned };
  return { ...common, kind, url: d.url.trim(), description: oneLine(d.description) || null };
}

/** How many open workspaces a choice reaches now. Never throws. */
async function askReach(modules: string[], countries: string[], key: string): Promise<Reach> {
  try {
    const result = await consoleHelpReach(modules, countries);
    return result.ok
      ? { key, status: "ready", count: result.data.count, total: result.data.total, sample: result.data.sample }
      : { key, status: "error", count: 0, total: 0, sample: [] };
  } catch {
    return { key, status: "error", count: 0, total: 0, sample: [] };
  }
}

export function HelpContentEditor({
  kind,
  initial,
  choices,
  caps,
  mode,
}: {
  kind: HelpItemKind;
  initial: HelpEditorItem | null;
  choices: HelpEditorChoices;
  caps: Caps;
  mode: Mode;
}) {
  const router = useRouter();
  const clock = useClock();
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  /** The draft the page came with, and its reach key — never set again. */
  const [opening] = useState(() => {
    const first = draftOf(mode === "edit" ? initial : null);
    return { draft: first, key: reachKey(first.modules, first.countries) };
  });
  const [draft, setDraft] = useState<Draft>(opening.draft);
  /** When Save was last pressed — the clock the time check uses; null until then. */
  const [attemptedAt, setAttemptedAt] = useState<number | null>(null);

  const editId = mode === "edit" && initial ? initial.id : undefined;
  const saved = mode === "edit" ? initial : null;
  const initialSignature = useMemo(() => JSON.stringify(inputOf(opening.draft, kind, editId)), [opening, kind, editId]);
  const input = inputOf(draft, kind, editId);
  const dirty = mode === "create" || JSON.stringify(input) !== initialSignature;
  // The item page's header verbs act on what was saved, so they wait while this holds changes.
  useReportUnsaved(mode === "edit" && dirty);
  const problems = problemsOf(draft, kind, choices, attemptedAt, clock);
  const errors: Partial<Record<Field, string>> = {};
  if (attemptedAt !== null) for (const p of problems) errors[p.field] ??= p.message;

  const result = resultOf(draft.publish, saved);
  const showing = result === "live" || result === "scheduled";
  const everywhere = isEverywhere(draft);
  const needsTyped = showing && everywhere && !caps.owner;
  const word = KIND_WORD[kind];

  // ─── Reach ─────────────────────────────────────────────────────────────────────────────────────
  const [reach, setReach] = useState<Reach>({ key: opening.key, status: "loading", count: 0, total: choices.openWorkspaces, sample: [] });
  const reachTimer = useRef<number | undefined>(undefined);
  /** Bumped by every request; an answer carrying an older ticket is for a choice since changed. */
  const reachTicket = useRef(0);

  // The first count, for the choice the page came with. The state is set when the answer arrives,
  // never in the effect's own body.
  useEffect(() => {
    const ticket = ++reachTicket.current;
    const timer = window.setTimeout(async () => {
      const answer = await askReach(opening.draft.modules, opening.draft.countries, opening.key);
      if (ticket === reachTicket.current) setReach(answer);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [opening]);

  // A count still waiting to be asked for is not asked for once the editor has gone.
  useEffect(() => {
    const timers = reachTimer;
    return () => window.clearTimeout(timers.current);
  }, []);

  /** Called by every handler that changes modules or countries: count again, 400 ms after the last change. */
  function recount(next: Draft) {
    const key = reachKey(next.modules, next.countries);
    if (key === reach.key && reach.status !== "error") return;
    window.clearTimeout(reachTimer.current);
    const ticket = ++reachTicket.current;
    setReach((r) => ({ ...r, key, status: "loading" }));
    const modules = [...next.modules];
    const countries = [...next.countries];
    reachTimer.current = window.setTimeout(async () => {
      const answer = await askReach(modules, countries, key);
      if (ticket === reachTicket.current) setReach(answer);
    }, REACH_DEBOUNCE_MS);
  }

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    const next = { ...draft, [field]: value };
    setDraft(next);
    if (field === "modules" || field === "countries") recount(next);
  }

  function toggleModule(key: string, on: boolean) {
    update("modules", on ? (draft.modules.includes(key) ? draft.modules : [...draft.modules, key]) : draft.modules.filter((k) => k !== key));
  }

  /** A product on adds its modules; off takes away those no other chosen product still needs. */
  function toggleProduct(product: TargetProduct) {
    const chosen = new Set(draft.modules);
    if (!productChosen(product, chosen)) {
      update("modules", [...new Set([...draft.modules, ...product.modules])]);
      return;
    }
    const kept = new Set(TARGET_PRODUCTS.filter((p) => p.key !== product.key && productChosen(p, chosen)).flatMap((p) => p.modules));
    update("modules", draft.modules.filter((k) => kept.has(k) || !product.modules.includes(k)));
  }

  function toggleCountry(code: string, on: boolean) {
    update("countries", on ? (draft.countries.includes(code) ? draft.countries : [...draft.countries, code]) : draft.countries.filter((c) => c !== code));
  }

  // ─── Saving ────────────────────────────────────────────────────────────────────────────────────
  const [saveOpen, setSaveOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{ input: ReturnType<typeof inputOf>; result: PublicationState; at: string } | null>(null);
  const save = useConsoleAction<{ id: string; state: PublicationState }>();
  const listHref = `/help-content${tabOf(kind) === "articles" ? "" : `?tab=${tabOf(kind)}`}`;

  function send(sent: ReturnType<typeof inputOf>, typed: string | null) {
    const withConfirm = typed === null ? sent : { ...sent, confirm: typed };
    const work = () => (kind === "POST" ? consoleSaveHelpPost(withConfirm as Parameters<typeof consoleSaveHelpPost>[0]) : consoleSaveHelpLink(withConfirm as Parameters<typeof consoleSaveHelpLink>[0]));
    save.run(work, {
      success: (data) =>
        data.state === "live"
          ? `“${sent.title}” is live.`
          : data.state === "scheduled"
            ? `“${sent.title}” is scheduled.`
            : mode === "edit"
              ? `“${sent.title}” saved as a draft.`
              : `Draft “${sent.title}” saved.`,
      // Leaving for the list, which loads fresh; refreshing this page first would only redraw it.
      refresh: false,
      onDone: () => {
        setSaveOpen(false);
        router.push(listHref);
      },
    });
  }

  function requestSave() {
    const now = clockNow();
    setAttemptedAt(now);
    const found = problemsOf(draft, kind, choices, now, clock);
    if (found.length > 0) {
      rootRef.current?.querySelector<HTMLElement>(`[data-help-field="${found[0]!.field}"]`)?.focus();
      return;
    }
    save.reset();
    if (!showing) {
      send(input, null);
      return;
    }
    const at = draft.publish === "at" ? clock.parseInput(draft.publishAt) : null;
    setSnapshot({ input, result, at: at ? zoned(at, clock) : "" });
    setSaveOpen(true);
  }

  function confirmSave({ typed }: { typed: string; reason: string }) {
    if (!snapshot) return;
    send(snapshot.input, needsTyped ? typed : null);
  }

  function discard() {
    setDraft(opening.draft);
    setAttemptedAt(null);
    save.reset();
    recount(opening.draft);
  }

  const saveLabel =
    draft.publish === "now" ? "Publish…" : draft.publish === "at" ? "Schedule…" : showing ? "Save changes…" : mode === "edit" ? "Save changes" : "Save draft";
  const confirmLabel = draft.publish === "at" ? "Schedule" : draft.publish === "now" ? "Publish" : "Save changes";

  // ─── Field ids ─────────────────────────────────────────────────────────────────────────────────
  const ids = {
    title: `${uid}-title`,
    titleHint: `${uid}-title-hint`,
    url: `${uid}-url`,
    urlHint: `${uid}-url-hint`,
    description: `${uid}-description`,
    descriptionHint: `${uid}-description-hint`,
    body: `${uid}-body`,
    bodyHint: `${uid}-body-hint`,
    publish: `${uid}-publish`,
    publishAt: `${uid}-publish-at`,
    publishAtHint: `${uid}-publish-at-hint`,
    country: `${uid}-country`,
  };

  const { limits } = choices;
  const titleCount = charCount(oneLine(draft.title));
  const descriptionCount = charCount(oneLine(draft.description));
  const bodyCount = charCount(draft.body.trim());
  const atChosen = draft.publish === "at" && draft.publishAt ? clock.parseInput(draft.publishAt) : null;
  const atText = atChosen ? zoned(atChosen, clock) : null;
  const shows =
    result === "draft"
      ? "Nowhere — it is a draft"
      : draft.publish === "now"
        ? saved?.state === "live" && saved.publishedAt
          ? `Since ${zoned(saved.publishedAt, clock)}`
          : "As soon as it's saved"
        : draft.publish === "at"
          ? atText
            ? `From ${atText}`
            : "At the time you choose"
          : saved?.publishedAt
            ? saved.state === "live"
              ? `Since ${zoned(saved.publishedAt, clock)}`
              : `From ${zoned(saved.publishedAt, clock)}`
            : "—";

  return (
    <div ref={rootRef} className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        {/* ─── The form ─── */}
        <div className="min-w-0 space-y-6">
          <Panel
            title={kind === "POST" ? "Post" : KIND_TITLE[kind]}
            description={kind === "POST" ? "Plain text: line breaks are kept; markdown and HTML are not." : "Only the link is kept — the page itself lives where it points."}
          >
            <div className="space-y-5">
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor={ids.title}>Title</Label>
                  <span className={cn("text-[11px] tabular-nums", titleCount > limits.titleMax ? "text-danger" : "text-subtle")}>{`${titleCount} / ${limits.titleMax}`}</span>
                </div>
                <Input
                  id={ids.title}
                  data-help-field="title"
                  value={draft.title}
                  onChange={(e) => update("title", e.target.value)}
                  placeholder={kind === "POST" ? "Order punching on one screen" : kind === "VIDEO" ? "Raising your first invoice" : "Setting up GST on your items"}
                  autoComplete="off"
                  aria-invalid={errors.title ? true : undefined}
                  aria-describedby={errors.title ? ids.titleHint : undefined}
                />
                <FieldError id={ids.titleHint} message={errors.title} />
              </div>

              {kind === "POST" && (
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <Label htmlFor={ids.body}>What changed</Label>
                    <span className={cn("text-[11px] tabular-nums", bodyCount > limits.body ? "text-danger" : "text-subtle")}>{`${bodyCount.toLocaleString("en-IN")} / ${limits.body.toLocaleString("en-IN")}`}</span>
                  </div>
                  <Textarea
                    id={ids.body}
                    data-help-field="body"
                    value={draft.body}
                    onChange={(e) => update("body", e.target.value)}
                    rows={8}
                    placeholder="Orders are now punched on one screen: sections down the left, a live order summary on the right, and search as you type for customers and items."
                    aria-invalid={errors.body ? true : undefined}
                    aria-describedby={ids.bodyHint}
                  />
                  {errors.body ? <FieldError id={ids.bodyHint} message={errors.body} /> : <Hint id={ids.bodyHint}>Shown in full in What&apos;s new. Say what changed and where to find it.</Hint>}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor={ids.url}>{kind === "POST" ? "Read more (optional)" : "Link"}</Label>
                <Input
                  id={ids.url}
                  data-help-field="url"
                  value={draft.url}
                  onChange={(e) => update("url", e.target.value)}
                  placeholder={kind === "VIDEO" ? "https://www.youtube.com/watch?v=…" : kind === "POST" ? "https://deskzo.com/blog/… or /orders/new" : "https://deskzo.com/help/… or /settings/tax"}
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                  className="font-mono text-[13px]"
                  aria-invalid={errors.url ? true : undefined}
                  aria-describedby={ids.urlHint}
                />
                {errors.url ? (
                  <FieldError id={ids.urlHint} message={errors.url} />
                ) : (
                  <Hint id={ids.urlHint}>
                    An https:// address on YouTube, Vimeo, Loom or {choices.linkDomain} (and its subdomains), or a path in the app such as /orders/new.
                  </Hint>
                )}
              </div>

              {kind !== "POST" && (
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <Label htmlFor={ids.description}>Description (optional)</Label>
                    <span className={cn("text-[11px] tabular-nums", descriptionCount > limits.description ? "text-danger" : "text-subtle")}>{`${descriptionCount} / ${limits.description}`}</span>
                  </div>
                  <Input
                    id={ids.description}
                    data-help-field="description"
                    value={draft.description}
                    onChange={(e) => update("description", e.target.value)}
                    placeholder={kind === "VIDEO" ? "Four minutes, from a new order to a sent invoice." : "What it covers, in one line."}
                    autoComplete="off"
                    aria-invalid={errors.description ? true : undefined}
                    aria-describedby={ids.descriptionHint}
                  />
                  {errors.description ? <FieldError id={ids.descriptionHint} message={errors.description} /> : <Hint id={ids.descriptionHint}>One line under the title.</Hint>}
                </div>
              )}

              {kind === "POST" && (
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line px-4 py-3">
                  <Checkbox checked={draft.pinned} onChange={(e) => update("pinned", e.target.checked)} className="mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text">Pin it</span>
                    <span className="block text-xs text-muted">A pinned post stays above the newer ones while it is live.</span>
                  </span>
                </label>
              )}
            </div>
          </Panel>

          <Panel title="Who sees it" description="Choose nothing to show it in every workspace.">
            <TargetPicker
              modules={draft.modules}
              countries={draft.countries}
              available={choices.countries}
              countryInputId={ids.country}
              error={errors.targets}
              onProduct={toggleProduct}
              onModule={toggleModule}
              onCountry={toggleCountry}
              onClearModules={() => update("modules", [])}
              onClearCountries={() => update("countries", [])}
            />
          </Panel>

          <Panel title="Publishing" description={`Times in ${clock.zone.replace(/_/g, " ")}, the console's time zone. Workspaces pick up a change within a minute.`}>
            <PublishChoice
              name={ids.publish}
              value={draft.publish}
              saved={saved}
              onChange={(value) => update("publish", value)}
              atInput={
                <div className="space-y-1.5 pt-1">
                  <Label htmlFor={ids.publishAt}>Goes live at</Label>
                  <Input
                    id={ids.publishAt}
                    data-help-field="publishAt"
                    type="datetime-local"
                    value={draft.publishAt}
                    onChange={(e) => update("publishAt", e.target.value)}
                    aria-invalid={errors.publishAt ? true : undefined}
                    aria-describedby={ids.publishAtHint}
                    className="max-w-xs tabular-nums"
                  />
                  {errors.publishAt ? <FieldError id={ids.publishAtHint} message={errors.publishAt} /> : <Hint id={ids.publishAtHint}>It stays hidden until then.</Hint>}
                </div>
              }
            />
          </Panel>
        </div>

        {/* ─── What it looks like, who sees it, and when ─── */}
        <div className="min-w-0 space-y-6 lg:sticky lg:top-20">
          <Panel title="Preview" description={`As a workspace shows it — read-only, under “From Deskzo”, apart from the company's own ${kind === "POST" ? "news" : "guides"}.`}>
            <Preview kind={kind} draft={draft} published={draft.publish === "keep" && saved?.publishedAt ? saved.publishedAt : null} atText={atText} />
          </Panel>

          <Panel title="Reach" description="Open workspaces it would show in, counted now.">
            <ReachSummary reach={reach} everywhere={everywhere} />
          </Panel>

          <Panel title="When">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted">Shows</dt>
                <dd className="mt-0.5 text-sm break-words text-text">{shows}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted">Until</dt>
                <dd className="mt-0.5 text-sm break-words text-text">{result === "draft" ? "—" : "Someone takes it down or archives it"}</dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>

      {/* Above the lifted table actions (z-[1]–z-[3]) and below the top bar (z-20), as the announcement editor's. */}
      <div className="sticky bottom-4 z-[4] rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-lg backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 text-xs" aria-live="polite">
            {attemptedAt !== null && problems.length > 0 ? (
              <p className="text-danger">
                <span className="font-medium">{plural(problems.length, "thing")} to fix before saving.</span> {problems[0]!.message}
              </p>
            ) : save.error && !saveOpen ? (
              <p className="text-danger">{save.error}</p>
            ) : mode === "edit" ? (
              dirty ? (
                <p className="flex items-center gap-2 text-text">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
                  {showing ? "Unsaved changes — workspaces see them within a minute of saving." : "Unsaved changes."}
                </p>
              ) : (
                <p className="text-muted">No changes yet.</p>
              )
            ) : (
              <p className="text-muted">{showing ? `The ${word} shows in workspaces once you confirm.` : "A draft shows nowhere until it is published."}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {mode === "edit" && dirty ? (
              <Button type="button" variant="ghost" size="sm" onClick={discard}>
                Discard changes
              </Button>
            ) : (
              <Link href={listHref} className="inline-flex h-8 items-center rounded-base px-3 text-[13px] font-medium text-muted hover:bg-surface-sunken hover:text-text">
                Cancel
              </Link>
            )}
            <Button
              type="button"
              size="sm"
              onClick={requestSave}
              disabled={!dirty}
              aria-disabled={(save.pending && !saveOpen) || undefined}
              aria-busy={(save.pending && !saveOpen) || undefined}
              className={save.pending && !saveOpen ? "cursor-wait opacity-70" : undefined}
            >
              {save.pending && !saveOpen && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {saveLabel}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title={draft.publish === "now" ? `Publish ${word}` : draft.publish === "at" ? `Schedule ${word}` : `Save ${word}`}
        confirmLabel={confirmLabel}
        typed={needsTyped ? "publish" : undefined}
        pending={save.pending}
        error={save.error}
        confirmDisabled={reach.status === "loading"}
        wide
        onConfirm={confirmSave}
      >
        {snapshot && (
          <>
            <p>
              {snapshot.result === "scheduled"
                ? snapshot.at
                  ? `It goes live ${snapshot.at}.`
                  : "It goes live at the time it was scheduled for."
                : saved?.state === "live"
                  ? "Workspaces it reaches see the change on their next page."
                  : "It goes live as soon as you confirm."}{" "}
              Other servers pick it up within a minute.
            </p>
            <ImpactList
              items={[
                { label: KIND_TITLE[kind], value: snapshot.input.title },
                { label: "Shown to", value: targetingText(snapshot.input.modules, snapshot.input.countries, 4) },
                {
                  label: "Reaches",
                  value: reach.status === "ready" ? plural(reach.count, "open workspace") : reach.status === "loading" ? "Counting…" : "Couldn't count",
                  tone: reach.status === "ready" && reach.count === 0 ? "warning" : undefined,
                },
                { label: "Shows", value: shows },
                ...(kind === "POST" ? [{ label: "Pinned", value: draft.pinned ? "Yes" : "No" }] : []),
              ]}
            />
            {reach.status === "ready" && reach.count === 0 && (
              <p className="text-xs text-warning">No open workspace is in this choice right now — it will show only in ones that come into it.</p>
            )}
            {needsTyped && (
              <p className="text-xs text-muted">
                No module or country is chosen, so it shows in every workspace — that needs <span className="font-mono text-text">publish</span> typed below.
              </p>
            )}
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────────────────────────

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-danger">
      {message}
    </p>
  );
}

function Hint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-muted">
      {children}
    </p>
  );
}

/** The chosen count and a way to clear it, above each picker. */
function PickerHead({ label, count, onClear }: { label: string; count: number; onClear: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <div className="flex items-center gap-2 text-xs text-muted tabular-nums">
        {count > 0 ? `${count} chosen` : "Any"}
        {count > 0 && (
          <button type="button" onClick={onClear} className="rounded-base font-medium text-brand hover:underline">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/** Modules grouped as the workspace sidebar groups them. */
function moduleGroups(): { title: string; modules: TargetModule[] }[] {
  const map = new Map<string, TargetModule[]>();
  for (const m of TARGET_MODULES) map.set(m.group, [...(map.get(m.group) ?? []), m]);
  return [...map].map(([title, modules]) => ({ title, modules }));
}

const GROUPS = moduleGroups();
/** The ISO codes there are — "Another country" takes only one of these. */
const COUNTRY_CODES: ReadonlySet<string> = new Set(COUNTRIES.map((c) => c.code));

function TargetPicker({
  modules,
  countries,
  available,
  countryInputId,
  error,
  onProduct,
  onModule,
  onCountry,
  onClearModules,
  onClearCountries,
}: {
  modules: string[];
  countries: string[];
  available: string[];
  countryInputId: string;
  error?: string;
  onProduct: (product: TargetProduct) => void;
  onModule: (key: string, on: boolean) => void;
  onCountry: (code: string, on: boolean) => void;
  onClearModules: () => void;
  onClearCountries: () => void;
}) {
  const chosen = new Set(modules);
  const [code, setCode] = useState("");
  const typed = code.trim().toUpperCase();
  // Only a country's ISO code — the save refuses anything else, as "UK" (GB) would reach nobody.
  const codeOk = COUNTRY_CODES.has(typed);
  const codeWrong = /^[A-Z]{2}$/.test(typed) && !codeOk;
  // A country chosen before that no open workspace is in any more stays listed, so it can be unticked.
  const codes = [...new Set([...available, ...countries])].sort();

  function addCode() {
    if (!codeOk) return;
    onCountry(typed, true);
    setCode("");
  }

  return (
    <div className="space-y-5" data-help-field="targets" tabIndex={-1}>
      <fieldset className="space-y-2">
        <legend className="sr-only">Products</legend>
        {/* Counted in modules — what is stored — whether they came from a product or one at a time. */}
        <PickerHead label="Products and modules" count={modules.length} onClear={onClearModules} />
        <div className="flex flex-wrap gap-1.5">
          {TARGET_PRODUCTS.map((p) => {
            const on = productChosen(p, chosen);
            const some = !on && p.modules.some((k) => chosen.has(k));
            return (
              <button
                key={p.key}
                type="button"
                aria-pressed={on}
                onClick={() => onProduct(p)}
                title={`${p.modules.length} modules`}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium",
                  on ? "border-brand bg-brand-subtle text-brand" : some ? "border-brand/40 bg-surface text-text hover:bg-surface-sunken" : "border-line bg-surface text-text hover:bg-surface-sunken",
                )}
              >
                {on ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Plus aria-hidden="true" className="h-3.5 w-3.5 text-subtle" />}
                {p.name}
                {some && <span className="font-normal text-muted">some</span>}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted">A product stands for its modules: it shows where the plan has any of them.</p>
      </fieldset>

      <details className="rounded-lg border border-line">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-[13px] font-medium text-text hover:bg-surface-sunken">
          <span>Single modules</span>
          <span className="text-xs font-normal text-muted">One at a time, beside or instead of products</span>
        </summary>
        <div className="max-h-80 space-y-3 overflow-y-auto border-t border-line px-3 py-3">
          {GROUPS.map((g) => (
            <fieldset key={g.title} className="space-y-1">
              <legend className="text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">{g.title}</legend>
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {g.modules.map((m) => (
                  <label key={m.key} className="flex cursor-pointer items-center gap-2 py-0.5 text-sm text-text">
                    <Checkbox checked={chosen.has(m.key)} onChange={(e) => onModule(m.key, e.target.checked)} className="shrink-0" />
                    <span className="min-w-0 truncate">{m.label}</span>
                    {m.countries && <span className="shrink-0 text-[11px] text-muted">{`${m.countries.join(", ")} only`}</span>}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </details>

      <fieldset className="space-y-2">
        <legend className="sr-only">Countries</legend>
        <PickerHead label="Countries" count={countries.length} onClear={onClearCountries} />
        {codes.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {codes.map((c) => {
              const on = countries.includes(c);
              return (
                <label
                  key={c}
                  className={cn(
                    "inline-flex h-8 cursor-pointer items-center gap-2 rounded-full border pr-3 pl-2.5 text-xs font-medium",
                    on ? "border-brand bg-brand-subtle text-brand" : "border-line bg-surface text-text hover:bg-surface-sunken",
                  )}
                >
                  <Checkbox checked={on} onChange={(e) => onCountry(c, e.target.checked)} className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-mono">{c}</span>
                  {!available.includes(c) && <span className="font-normal text-muted">no open workspaces</span>}
                </label>
              );
            })}
          </div>
        )}
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={countryInputId}>Another country</Label>
            <Input
              id={countryInputId}
              value={code}
              onChange={(e) => setCode(e.target.value.slice(0, 2))}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                addCode();
              }}
              placeholder="AE"
              autoComplete="off"
              spellCheck={false}
              className="w-20 font-mono uppercase"
            />
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={addCode} disabled={!codeOk}>
            Add
          </Button>
        </div>
        <p className={cn("text-xs", codeWrong ? "text-danger" : "text-muted")} aria-live="polite">
          {!codeWrong
            ? "Two-letter ISO codes, like IN, US or GB. With none, every country."
            : typed === "UK"
              ? "UK isn't a country code — the United Kingdom is GB."
              : `${typed} isn't a country code.`}
        </p>
      </fieldset>

      {error && <p className="text-xs text-danger">{error}</p>}
      <InsetBlock className="text-xs text-muted">
        <span className="font-medium text-text">Shown to: </span>
        {targetingText(modules, countries, 6)}
      </InsetBlock>
    </div>
  );
}

function PublishChoice({
  name,
  value,
  saved,
  onChange,
  atInput,
}: {
  name: string;
  value: Publish;
  saved: HelpEditorItem | null;
  onChange: (value: Publish) => void;
  atInput: ReactNode;
}) {
  const clock = useClock();
  const state = saved?.state ?? null;
  const since = saved?.publishedAt ? zoned(saved.publishedAt, clock) : null;
  const options: { value: Publish; title: string; body: string }[] =
    state === "live"
      ? [
          { value: "keep", title: "Keep it live", body: since ? `Live since ${since}.` : "It stays where it is." },
          { value: "draft", title: "Take it down", body: "Back to the drafts — it stops showing." },
        ]
      : state === "scheduled"
        ? [
            { value: "keep", title: "Keep the schedule", body: since ? `Goes live ${since}.` : "It goes live as planned." },
            { value: "now", title: "Publish now", body: "It shows as soon as it's saved." },
            { value: "at", title: "Change the time", body: "Choose another time to go live." },
            { value: "draft", title: "Back to drafts", body: "It won't go live." },
          ]
        : [
            { value: state === "draft" ? "keep" : "draft", title: state === "draft" ? "Keep as a draft" : "Save as a draft", body: "It shows nowhere until it is published." },
            { value: "now", title: "Publish now", body: "It shows as soon as it's saved." },
            { value: "at", title: "Schedule", body: "It goes live at the time you choose." },
          ];
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">When it shows</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const chosen = value === o.value;
          return (
            <label
              key={o.value}
              className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5", chosen ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken")}
            >
              <input type="radio" name={name} value={o.value} checked={chosen} onChange={() => onChange(o.value)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text">{o.title}</span>
                <span className="mt-0.5 block text-xs text-muted">{o.body}</span>
              </span>
            </label>
          );
        })}
      </div>
      {value === "at" && atInput}
    </fieldset>
  );
}

/** The item as a workspace's rail or What's new draws it under "From Deskzo" — drawn here, not borrowed, so it never depends on a workspace's own components. */
function Preview({ kind, draft, published, atText }: { kind: HelpItemKind; draft: Draft; published: Date | null; atText: string | null }) {
  const clock = useClock();
  const title = oneLine(draft.title) || "Your title";
  const url = draft.url.trim();
  const checked = url ? checkLink(url) : null;
  const external = checked?.ok ? checked.external : false;
  const video = kind === "VIDEO" && checked?.ok && external ? youtubeId(checked.url) : null;
  const description = oneLine(draft.description);

  return (
    <div aria-label="Preview" role="group" className="rounded-lg border border-line bg-bg p-3">
      <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">{kind === "POST" ? "What's new · From Deskzo" : "From Deskzo"}</p>
      {kind === "POST" ? (
        <article className="rounded-lg border border-line bg-surface px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold break-words text-text">{title}</h3>
            {draft.pinned && (
              <StatusPill tone="brand" icon={<Pin className="h-3 w-3" />}>
                Pinned
              </StatusPill>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted">{published ? clock.date(published) : (atText ?? "The day it's published")}</p>
          <p className="mt-2 text-sm whitespace-pre-line break-words text-text">{draft.body.trim() || "What the post says appears here."}</p>
          {url && (
            <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand">
              Read more
              {external && <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />}
            </p>
          )}
        </article>
      ) : kind === "VIDEO" ? (
        <div className="max-w-xs">
          <span className="relative block aspect-video overflow-hidden rounded-lg border border-line bg-surface-sunken">
            {video ? (
              // YouTube's own still, fetched without saying which page asked for it — as the rail does.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`https://i.ytimg.com/vi/${video}/mqdefault.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
            ) : null}
            <span className="absolute inset-0 grid place-items-center bg-black/10">
              <PlayCircle className="h-9 w-9 text-white drop-shadow" aria-hidden="true" />
            </span>
          </span>
          <span className="mt-1.5 block text-sm font-medium text-text">{title}</span>
          {description && <span className="block text-xs text-muted">{description}</span>}
        </div>
      ) : (
        <div className="flex items-start gap-2.5 rounded-lg px-1 py-1">
          <BookOpen aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
          <span className="min-w-0">
            <span className="flex items-center gap-1 text-sm font-medium break-words text-text">
              {title}
              {external && <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />}
            </span>
            {description && <span className="block text-xs text-muted">{description}</span>}
          </span>
        </div>
      )}
      {url && <p className="mt-2 truncate font-mono text-[11px] text-subtle">{`Opens ${linkText(checked?.ok ? checked.url : url)}${external ? " in a new tab" : ""}`}</p>}
    </div>
  );
}

function ReachSummary({ reach, everywhere }: { reach: Reach; everywhere: boolean }) {
  if (reach.status === "error") {
    return (
      <p role="status" className="text-sm text-muted">
        {REACH_FAILED}
      </p>
    );
  }
  const loading = reach.status === "loading";
  const more = reach.count - reach.sample.length;
  return (
    <div className="space-y-3">
      <p role="status" className="flex flex-wrap items-baseline gap-2">
        <span className={cn("text-2xl font-semibold tracking-tight text-text tabular-nums", loading && "opacity-50")}>{reach.count.toLocaleString("en-IN")}</span>
        <span className="text-sm text-muted">{`of ${plural(reach.total, "open workspace")}`}</span>
        {loading && (
          <span className="inline-flex items-center gap-1 text-xs text-subtle">
            <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            Counting…
          </span>
        )}
      </p>
      {everywhere && <p className="text-xs text-muted">Every workspace — including ones that open later.</p>}
      {reach.sample.length > 0 && (
        <div className={cn(loading && "opacity-50")}>
          <p className="mb-1.5 text-xs text-muted">Including</p>
          <ul className="flex flex-wrap gap-1.5">
            {reach.sample.map((slug) => (
              <li key={slug} className="inline-flex h-6 items-center rounded-full border border-line bg-surface-sunken px-2 font-mono text-xs text-text">
                {slug}
              </li>
            ))}
            {more > 0 && <li className="inline-flex h-6 items-center px-1 text-xs text-muted tabular-nums">{`and ${more.toLocaleString("en-IN")} more`}</li>}
          </ul>
        </div>
      )}
      {!loading && reach.count === 0 && <p className="text-xs text-warning">No open workspace is in this choice right now.</p>}
    </div>
  );
}
