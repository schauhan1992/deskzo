"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, Copy, Globe, Phone, Plus, Trash2 } from "lucide-react";
import { deleteInboxChannel, newInboxVerifyToken, saveInboxChannel, saveInboxWhatsApp, setInboxChannelActive } from "@/actions/inbox-admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { botReply, type BotState, type Known } from "@/lib/inbox/bot";
import { INBOX_LIMITS, WEEKDAYS, defaultChannelSettings, widgetSnippet, type ChannelSettings, type InboxKind, type Weekday } from "@/lib/inbox/settings";
import { cn } from "@/lib/utils";

/**
 * Settings › Customer inbox's form (src/actions/inbox-admin.ts): a card for each website bubble and
 * WhatsApp number, opened to edit; the WhatsApp credentials and the webhook to give Meta; and, on each
 * channel, a box to try its bot — the very code that answers customers (src/lib/inbox/bot.ts), run here.
 */

type ChannelView = {
  id: string;
  kind: InboxKind;
  name: string;
  active: boolean;
  publicKey: string | null;
  phoneNumberId: string | null;
  displayPhone: string | null;
  ownerUserId: string | null;
  settings: ChannelSettings;
  conversations: number;
  /** Whom Deskzo AI's answers on this channel are charged as, by name, while they're on. */
  aiChargedTo: string | null;
};

const DAY_NAMES: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

type Draft = { id: string | null; kind: InboxKind; name: string; phoneNumberId: string; displayPhone: string; ownerUserId: string; sites: string; settings: ChannelSettings };

const draftOf = (c: ChannelView): Draft => ({
  id: c.id,
  kind: c.kind,
  name: c.name,
  phoneNumberId: c.phoneNumberId ?? "",
  displayPhone: c.displayPhone ?? "",
  ownerUserId: c.ownerUserId ?? "",
  sites: c.settings.allowedSites.join("\n"),
  settings: c.settings,
});

const newDraft = (kind: InboxKind): Draft => ({
  id: null,
  kind,
  name: kind === "WEB" ? "Website chat" : "WhatsApp",
  phoneNumberId: "",
  displayPhone: "",
  ownerUserId: "",
  sites: "",
  settings: defaultChannelSettings(kind),
});

export function InboxSettings({
  origin,
  people,
  ai,
  channels,
  whatsapp,
}: {
  origin: string;
  people: { id: string; name: string }[];
  /** Where Deskzo AI's answers would go — null until staff set up the feature. */
  ai: { model: string; residency: string; noTraining: boolean } | null;
  channels: ChannelView[];
  whatsapp: { webhookUrl: string; verifyToken: string; hasAppSecret: boolean; hasToken: boolean; providerToken: boolean; language: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creds, setCreds] = useState({ accessToken: "", appSecret: "", language: whatsapp.language });
  const [trial, setTrial] = useState<{ channel: string; text: string; log: { from: "you" | "bot"; text: string }[]; state: BotState | null; known: Known }>({
    channel: "",
    text: "",
    log: [],
    state: null,
    known: { name: null, email: null, phone: null },
  });

  function run(work: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string, after?: () => void) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const r = await work();
      if (!r.ok) return setError(r.error);
      after?.();
      setNotice(success);
      router.refresh();
    });
  }

  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => setNotice("Copied."));
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setS = (patch: Partial<ChannelSettings>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  const setBot = (patch: Partial<ChannelSettings["bot"]>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, bot: { ...d.settings.bot, ...patch } } } : d));
  const setAi = (patch: Partial<ChannelSettings["bot"]["ai"]>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, bot: { ...d.settings.bot, ai: { ...d.settings.bot.ai, ...patch } } } } : d));
  const setHours = (patch: Partial<ChannelSettings["hours"]>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, hours: { ...d.settings.hours, ...patch } } } : d));
  const setDay = (day: Weekday, span: ChannelSettings["hours"]["days"][Weekday]) =>
    setDraft((d) => (d ? { ...d, settings: { ...d.settings, hours: { ...d.settings.hours, days: { ...d.settings.hours.days, [day]: span } } } } : d));
  const setAssign = (patch: Partial<ChannelSettings["assign"]>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, assign: { ...d.settings.assign, ...patch } } } : d));

  function save() {
    if (!draft) return;
    const settings = { ...draft.settings, allowedSites: draft.sites.split(/\n|,/).map((s) => s.trim()).filter(Boolean) };
    run(
      () => saveInboxChannel({ id: draft.id, kind: draft.kind, name: draft.name, settings, phoneNumberId: draft.phoneNumberId, displayPhone: draft.displayPhone, ownerUserId: draft.ownerUserId || null }),
      draft.id ? "Saved." : "Added.",
      () => setDraft(null),
    );
  }

  function tryBot(c: ChannelView) {
    const text = trial.text.trim();
    if (!text) return;
    const raw = botReply({ text, settings: c.settings, state: trial.channel === c.id ? trial.state : null, known: trial.channel === c.id ? trial.known : { name: null, email: null, phone: null }, kind: c.kind });
    // Trying it here never spends AI credits: where Deskzo AI would step in, it says so.
    const turn =
      raw.reason === "unknown" && c.settings.bot.ai.on
        ? { ...raw, replies: ["(Deskzo AI answers this from your notes — or hands over if it can't.)"], handover: false, state: { step: "chatting" as const } }
        : raw;
    const earlier = trial.channel === c.id ? trial.log : [];
    const greeting = earlier.length === 0 && c.kind === "WHATSAPP" && c.settings.bot.on ? [{ from: "bot" as const, text: c.settings.greeting }] : [];
    setTrial({
      channel: c.id,
      text: "",
      log: [...earlier, { from: "you", text }, ...greeting, ...turn.replies.map((r) => ({ from: "bot" as const, text: r })), ...(turn.handover ? [{ from: "bot" as const, text: "— handed to a person —" }] : [])],
      state: turn.handover ? null : turn.state,
      known: { ...(trial.channel === c.id ? trial.known : { name: null, email: null, phone: null }), ...turn.learned },
    });
  }

  // ─── The form for one channel ──────────────────────────────────────────────────────────────────
  const form = (d: Draft) => (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="ch-name">Name, for your team</Label>
          <Input id="ch-name" className="mt-1" value={d.name} maxLength={INBOX_LIMITS.channelName} onChange={(e) => set({ name: e.target.value })} />
        </div>
        {d.kind === "WEB" ? (
          <div>
            <Label htmlFor="ch-title">Title on the bubble</Label>
            <Input id="ch-title" className="mt-1" value={d.settings.look.title} maxLength={INBOX_LIMITS.title} onChange={(e) => setS({ look: { ...d.settings.look, title: e.target.value } })} />
          </div>
        ) : (
          <div>
            <Label htmlFor="ch-owner">Whose number</Label>
            <Select id="ch-owner" className="mt-1" value={d.ownerUserId} onChange={(e) => set({ ownerUserId: e.target.value })}>
              <option value="">Shared — the whole team answers</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}&apos;s own
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {d.kind === "WHATSAPP" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ch-pnid">Phone number ID</Label>
            <Input id="ch-pnid" className="mt-1" inputMode="numeric" value={d.phoneNumberId} onChange={(e) => set({ phoneNumberId: e.target.value })} placeholder="From Meta › WhatsApp › API setup" />
          </div>
          <div>
            <Label htmlFor="ch-phone">The number, as people dial it</Label>
            <Input id="ch-phone" className="mt-1" value={d.displayPhone} maxLength={30} onChange={(e) => set({ displayPhone: e.target.value })} placeholder="+91 98765 43210" />
          </div>
        </div>
      )}

      {d.kind === "WEB" && (
        <div className="grid gap-3 sm:grid-cols-[8rem_10rem_1fr]">
          <div>
            <Label htmlFor="ch-colour">Colour</Label>
            <Input id="ch-colour" type="color" className="mt-1 h-9 p-1" value={d.settings.look.colour} onChange={(e) => setS({ look: { ...d.settings.look, colour: e.target.value } })} />
          </div>
          <div>
            <Label htmlFor="ch-side">Corner</Label>
            <Select id="ch-side" className="mt-1" value={d.settings.look.position} onChange={(e) => setS({ look: { ...d.settings.look, position: e.target.value === "left" ? "left" : "right" } })}>
              <option value="right">Bottom right</option>
              <option value="left">Bottom left</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="ch-sites">Sites that may show it, one a line</Label>
            <Textarea id="ch-sites" className="mt-1 min-h-0" rows={2} value={d.sites} onChange={(e) => set({ sites: e.target.value })} placeholder="Blank: any site. Or example.com" />
          </div>
        </div>
      )}

      <div>
        <Label htmlFor="ch-greeting">Greeting</Label>
        <Textarea id="ch-greeting" className="mt-1 min-h-0" rows={2} maxLength={INBOX_LIMITS.greeting} value={d.settings.greeting} onChange={(e) => setS({ greeting: e.target.value })} />
      </div>

      <fieldset className="space-y-3 rounded-base border border-line p-3">
        <legend className="px-1 text-sm font-medium text-text">The bot</legend>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={d.settings.bot.on} onChange={(e) => setBot({ on: e.target.checked })} />
          Answer first, from the set answers below, and hand over to a person when it can&apos;t
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={d.settings.bot.askDetails} onChange={(e) => setBot({ askDetails: e.target.checked })} />
          Before handing over, ask their name{d.kind === "WEB" ? " and a phone number or email" : ""}
        </label>
        <div className="space-y-2">
          <p className="text-xs text-muted">Each answer is given when a message has one of its words or phrases (comma-separated). The one matching most words wins.</p>
          {d.settings.bot.answers.map((a, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[14rem_1fr_auto]">
              <Input aria-label={`Answer ${i + 1}: its words`} value={a.keywords} maxLength={INBOX_LIMITS.keywords} placeholder="price, pricing, cost" onChange={(e) => setBot({ answers: d.settings.bot.answers.map((x, j) => (j === i ? { ...x, keywords: e.target.value } : x)) })} />
              <Textarea aria-label={`Answer ${i + 1}: what the bot says`} rows={2} className="min-h-0" value={a.answer} maxLength={INBOX_LIMITS.answer} onChange={(e) => setBot({ answers: d.settings.bot.answers.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove answer ${i + 1}`} onClick={() => setBot({ answers: d.settings.bot.answers.filter((_, j) => j !== i) })}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {d.settings.bot.answers.length < INBOX_LIMITS.answers && (
            <Button type="button" size="sm" variant="secondary" onClick={() => setBot({ answers: [...d.settings.bot.answers, { keywords: "", answer: "" }] })}>
              <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Add an answer
            </Button>
          )}
        </div>
        <div>
          <Label htmlFor="ch-handover">When it hands over, it says</Label>
          <Input id="ch-handover" className="mt-1" value={d.settings.bot.handover} maxLength={INBOX_LIMITS.handover} onChange={(e) => setBot({ handover: e.target.value })} />
          <p className="mt-1 text-xs text-muted">{"{name}"} becomes the customer&apos;s first name — or is left out, comma and all, when the bot doesn&apos;t know it. The away message takes it too.</p>
        </div>
        <div>
          <Label htmlFor="ch-assistant">The assistant&apos;s name (optional)</Label>
          <Input id="ch-assistant" className="mt-1 sm:w-64" value={d.settings.bot.name} maxLength={INBOX_LIMITS.assistantName} onChange={(e) => setBot({ name: e.target.value })} placeholder="Asha" />
          <p className="mt-1 text-xs text-muted">Shown on its messages. It chats like a person on your team, but asked whether it&apos;s a person, it always says it&apos;s the virtual assistant and offers someone from the team.</p>
        </div>
        <div className="space-y-2 border-t border-line pt-3">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={d.settings.bot.ai.on} onChange={(e) => setAi({ on: e.target.checked })} />
            Let Deskzo AI answer what the set answers don&apos;t — it hands over whenever it isn&apos;t sure
          </label>
          {d.settings.bot.ai.on && (
            <div>
              <Label htmlFor="ch-about">What the AI may tell customers about your business</Label>
              <Textarea
                id="ch-about"
                className="mt-1"
                rows={4}
                maxLength={INBOX_LIMITS.about}
                value={d.settings.bot.ai.about}
                onChange={(e) => setAi({ about: e.target.value })}
                placeholder="What you sell, where you deliver, your timings, how to book a demo… The AI says nothing that isn't here or in the set answers."
              />
              <p className="mt-1 text-xs text-muted">
                {ai
                  ? `Each answer uses your Deskzo AI credits, charged as ${channels.find((c) => c.id === d.id)?.aiChargedTo ?? "you"}. The AI sees only the conversation and what's written here — ${ai.model}, ${ai.residency}${ai.noTraining ? ", nothing kept for training" : ""}.`
                  : "Deskzo AI isn't set up for this yet. Until it is, the bot hands over instead of answering."}
              </p>
            </div>
          )}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={d.settings.autoLead} onChange={(e) => setS({ autoLead: e.target.checked })} />
        {d.kind === "WEB" ? "Make a lead once the bot has a new visitor's name and a phone number or email" : "Make a lead from a new number's first message"}
      </label>

      <fieldset className="space-y-3 rounded-base border border-line p-3">
        <legend className="px-1 text-sm font-medium text-text">Office hours</legend>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={d.settings.hours.on} onChange={(e) => setHours({ on: e.target.checked })} />
          Outside these hours, tell customers waiting for a person when you&apos;ll be back
        </label>
        {d.settings.hours.on && (
          <>
            <div className="space-y-1.5">
              {WEEKDAYS.map((w) => {
                const span = d.settings.hours.days[w];
                return (
                  <div key={w} className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="flex w-32 items-center gap-2 text-text">
                      <input type="checkbox" checked={!!span} onChange={(e) => setDay(w, e.target.checked ? { from: "09:00", to: "18:00" } : null)} />
                      {DAY_NAMES[w]}
                    </label>
                    {span ? (
                      <>
                        <Input type="time" aria-label={`${DAY_NAMES[w]} opens`} className="h-8 w-28" value={span.from} onChange={(e) => setDay(w, { ...span, from: e.target.value })} />
                        <span className="text-muted">to</span>
                        <Input type="time" aria-label={`${DAY_NAMES[w]} closes`} className="h-8 w-28" value={span.to} onChange={(e) => setDay(w, { ...span, to: e.target.value })} />
                      </>
                    ) : (
                      <span className="text-xs text-subtle">Closed</span>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted">In the workspace&apos;s time zone (Settings › Company).</p>
            <div>
              <Label htmlFor="ch-away">Away message</Label>
              <Textarea id="ch-away" className="mt-1 min-h-0" rows={2} maxLength={INBOX_LIMITS.away} value={d.settings.hours.away} onChange={(e) => setHours({ away: e.target.value })} />
            </div>
          </>
        )}
      </fieldset>

      {(d.kind === "WEB" || !d.ownerUserId) && (
        <fieldset className="space-y-3 rounded-base border border-line p-3">
          <legend className="px-1 text-sm font-medium text-text">Who gets a conversation that needs a person</legend>
          <Select aria-label="Who gets it" value={d.settings.assign.mode} onChange={(e) => setAssign({ mode: e.target.value === "rotate" ? "rotate" : "queue" })}>
            <option value="queue">The queue — whoever takes it first</option>
            <option value="rotate">Each person in turn (round-robin)</option>
          </Select>
          {d.settings.assign.mode === "rotate" && (
            <div>
              <p className="text-xs text-muted">Who takes turns — leave every box empty for everybody who answers customers.</p>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {people.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={d.settings.assign.people.includes(p.id)}
                      onChange={(e) => setAssign({ people: e.target.checked ? [...d.settings.assign.people, p.id] : d.settings.assign.people.filter((x) => x !== p.id) })}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
          )}
        </fieldset>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {d.id ? "Save" : "Add"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );

  // ─── One channel's card ────────────────────────────────────────────────────────────────────────
  const card = (c: ChannelView) => {
    const editing = draft?.id === c.id;
    return (
      <li key={c.id} className={cn("rounded-base border border-line p-4", !c.active && "opacity-70")}>
        <div className="flex flex-wrap items-center gap-2">
          {c.kind === "WEB" ? <Globe aria-hidden="true" className="h-4 w-4 text-info" /> : <Phone aria-hidden="true" className="h-4 w-4 text-success" />}
          <p className="font-medium text-text">{c.name}</p>
          <span className="text-xs text-muted">
            {c.kind === "WHATSAPP" ? `${c.displayPhone ?? c.phoneNumberId} · ${c.ownerUserId ? `${people.find((p) => p.id === c.ownerUserId)?.name ?? "A rep"}'s own` : "shared"}` : c.settings.allowedSites.length ? c.settings.allowedSites.join(", ") : "any site"}
            {` · bot ${c.settings.bot.on ? `on, ${c.settings.bot.answers.length} answers${c.settings.bot.ai.on ? " and Deskzo AI" : ""}` : "off"}`}
            {c.settings.hours.on ? " · office hours" : ""}
            {c.settings.assign.mode === "rotate" && !c.ownerUserId ? " · round-robin" : ""}
            {c.active ? "" : " · switched off"}
          </span>
          <span className="ml-auto flex gap-1">
            {!editing && (
              <Button size="sm" variant="secondary" onClick={() => setDraft(draftOf(c))}>
                Edit
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setInboxChannelActive(c.id, !c.active), c.active ? "Switched off." : "Switched on.")}>
              {c.active ? "Switch off" : "Switch on"}
            </Button>
            {c.conversations === 0 && (
              <Button size="sm" variant="ghost" aria-label={`Remove ${c.name}`} disabled={pending} onClick={() => run(() => deleteInboxChannel(c.id), "Removed.")}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </span>
        </div>
        {c.kind === "WEB" && c.publicKey && (
          <div className="mt-3">
            <p className="text-xs text-muted">Paste this before &lt;/body&gt; on every page of your site:</p>
            <div className="mt-1 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-base bg-surface-sunken px-2 py-1.5 text-xs text-text">{widgetSnippet(origin, c.publicKey)}</code>
              <Button size="sm" variant="secondary" aria-label="Copy the snippet" onClick={() => copy(widgetSnippet(origin, c.publicKey!))}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
        {editing && draft && <div className="mt-4 border-t border-line pt-4">{form(draft)}</div>}
        {!editing && c.settings.bot.on && (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              tryBot(c);
            }}
          >
            {trial.channel === c.id && trial.log.length > 0 && (
              <ol className="max-h-48 space-y-1 overflow-y-auto rounded-base bg-surface-sunken p-2 text-xs">
                {trial.log.map((m, i) => (
                  <li key={i} className={m.from === "you" ? "text-right text-text" : "text-muted"}>
                    {m.from === "bot" && <Bot aria-hidden="true" className="mr-1 inline h-3 w-3" />}
                    {m.text}
                  </li>
                ))}
              </ol>
            )}
            <div className="flex gap-2">
              <Input aria-label={`Try ${c.name}'s bot`} placeholder="Try the bot: type what a customer might" value={trial.channel === c.id || !trial.channel ? trial.text : ""} onChange={(e) => setTrial((t) => ({ ...t, ...(t.channel !== c.id ? { channel: c.id, log: [], state: null, known: { name: null, email: null, phone: null } } : {}), text: e.target.value }))} className="h-8 text-sm" />
              <Button size="sm" variant="secondary" type="submit">
                Try
              </Button>
            </div>
          </form>
        )}
      </li>
    );
  };

  const web = channels.filter((c) => c.kind === "WEB");
  const numbers = channels.filter((c) => c.kind === "WHATSAPP");

  return (
    <div className="space-y-6">
      {(error || notice) && (
        <p role={error ? "alert" : "status"} className={cn("rounded-base px-3 py-2 text-sm", error ? "bg-danger-bg text-danger" : "bg-success-bg text-success")}>
          {error ?? notice}
        </p>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-text">Website chat</h2>
          <p className="mt-0.5 text-xs text-muted">A chat bubble on your website. Visitors type; the bot answers or hands over; your team replies from the inbox.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="space-y-3">{web.map(card)}</ul>
          {draft && !draft.id && draft.kind === "WEB" ? (
            <div className="rounded-base border border-line p-4">{form(draft)}</div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setDraft(newDraft("WEB"))}>
              <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Add a website
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-text">WhatsApp</h2>
          <p className="mt-0.5 text-xs text-muted">
            Through Meta&apos;s WhatsApp Cloud API: a shared number the team answers, and reps&apos; own. Each number needs to be in your WhatsApp Business account; a
            template must be approved by Meta before it can be sent.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => saveInboxWhatsApp(creds), "Saved.", () => setCreds((c) => ({ ...c, accessToken: "", appSecret: "" })));
            }}
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem]">
              <div>
                <Label htmlFor="wa-token">Access token</Label>
                <Input
                  id="wa-token"
                  type="password"
                  autoComplete="off"
                  className="mt-1"
                  value={creds.accessToken}
                  onChange={(e) => setCreds((c) => ({ ...c, accessToken: e.target.value }))}
                  placeholder={whatsapp.hasToken ? "Saved — leave blank to keep" : whatsapp.providerToken ? "Using Mail & messaging's" : "A permanent system-user token"}
                />
              </div>
              <div>
                <Label htmlFor="wa-secret">Meta app secret</Label>
                <Input id="wa-secret" type="password" autoComplete="off" className="mt-1" value={creds.appSecret} onChange={(e) => setCreds((c) => ({ ...c, appSecret: e.target.value }))} placeholder={whatsapp.hasAppSecret ? "Saved — leave blank to keep" : "From the app's Basic settings"} />
              </div>
              <div>
                <Label htmlFor="wa-lang">Template language</Label>
                <Input id="wa-lang" className="mt-1" value={creds.language} onChange={(e) => setCreds((c) => ({ ...c, language: e.target.value }))} placeholder="en" />
              </div>
            </div>
            <Button type="submit" size="sm" disabled={pending}>
              Save WhatsApp settings
            </Button>
          </form>

          <div className="space-y-2 rounded-base bg-surface-sunken p-3 text-xs">
            <p className="font-medium text-text">Webhook — give Meta these, in the app&apos;s WhatsApp › Configuration, and subscribe to “messages”:</p>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-muted">Callback URL</span>
              <code className="min-w-0 flex-1 break-all text-text">{whatsapp.webhookUrl}</code>
              <Button size="sm" variant="ghost" aria-label="Copy the callback URL" onClick={() => copy(whatsapp.webhookUrl)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-muted">Verify token</span>
              <code className="min-w-0 flex-1 break-all text-text">{whatsapp.verifyToken}</code>
              <Button size="sm" variant="ghost" aria-label="Copy the verify token" onClick={() => copy(whatsapp.verifyToken)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => newInboxVerifyToken(), "A new verify token is ready — give it to Meta.")}>
                New
              </Button>
            </div>
            {!whatsapp.hasAppSecret && <p className="text-danger">Messages can&apos;t come in until the app secret is saved: every call Meta makes is checked against it.</p>}
          </div>

          <ul className="space-y-3">{numbers.map(card)}</ul>
          {draft && !draft.id && draft.kind === "WHATSAPP" ? (
            <div className="rounded-base border border-line p-4">{form(draft)}</div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setDraft(newDraft("WHATSAPP"))}>
              <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Add a WhatsApp number
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
