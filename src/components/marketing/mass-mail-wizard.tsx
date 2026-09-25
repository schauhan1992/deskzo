"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock, Mail, Send, Upload, Users } from "lucide-react";
import type { MarketingTopic, TemplateFormat } from "@prisma/client";
import { previewRecipients, sendMassMail, sendTestEmail } from "@/actions/marketing";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { EmailFrame } from "@/components/marketing/email-frame";
import { ListUploader } from "@/components/marketing/list-uploader";
import { TemplateEditor } from "@/components/marketing/template-editor";
import { TOPICS } from "@/lib/marketing/topics";
import { cn } from "@/lib/utils";

type GalleryItem = { id: string; name: string; subject: string | null; topic: MarketingTopic; format: TemplateFormat; html: string | null; problems: string[] };
type Option = { id: string; name: string };
type Reach = Awaited<ReturnType<typeof previewRecipients>>;
type Outcome = { id: string; outcome: "QUEUED" | "NEEDS_APPROVAL" | "DRAFT"; queued: number; withheld: number };

const topicLabel = (t: MarketingTopic) => TOPICS.find((x) => x.key === t)?.label ?? t;

/**
 * A mass mail, start to finish: the email, the people, a last look — then send. Each step opens
 * once the one before it is done, and nothing is created until the button at the end is pressed.
 */
export function MassMailWizard({
  templates,
  audiences,
  lists,
  canSend,
}: {
  templates: GalleryItem[];
  audiences: Option[];
  lists: (Option & { members: number })[];
  canSend: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [audienceId, setAudienceId] = useState("");
  const [listId, setListId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [reach, setReach] = useState<Reach>(null);
  const [name, setName] = useState("");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [done, setDone] = useState<Outcome | null>(null);

  const template = templates.find((t) => t.id === templateId) ?? null;
  const hasPeople = !!audienceId || !!listId;

  // Who it would reach, recounted whenever the email or the people change.
  useEffect(() => {
    if (!templateId || !hasPeople) return;
    let live = true;
    const timer = setTimeout(() => {
      void previewRecipients({ templateId, audienceId: audienceId || null, listId: listId || null }).then((r) => live && setReach(r));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [templateId, audienceId, listId, hasPeople]);

  if (done) {
    return (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-success" aria-hidden />
          <p className="text-lg font-semibold text-text">
            {done.outcome === "QUEUED" ? `On its way to ${done.queued} people` : done.outcome === "NEEDS_APPROVAL" ? "Waiting for approval" : "Saved as a draft"}
          </p>
          <p className="mx-auto max-w-lg text-sm text-muted">
            {done.outcome === "QUEUED"
              ? `It goes out over the next few minutes, inside your quiet hours and send window.${done.withheld ? ` ${done.withheld} were held back — the report says why.` : ""}`
              : done.outcome === "NEEDS_APPROVAL"
                ? "It's big enough to need a second person. Once somebody with approval rights approves it, it goes straight out."
                : "You can build campaigns but not send them — somebody with send rights can send it from the campaign list."}
          </p>
          <div className="flex justify-center gap-2">
            <Link href={`/marketing/campaigns/${done.id}`}>
              <Button size="sm">Open the report</Button>
            </Link>
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
              Send another
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── 1. The email ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
              <Step n={1} done={!!template} /> Choose the email
            </h2>
            <p className="text-xs text-subtle">Pick a template — or make one, by typing it or uploading the HTML your designer sent.</p>
          </div>
          <TemplateEditor
            trigger="New or upload"
            onSaved={(id) => {
              setTemplateId(id);
              router.refresh();
            }}
          />
        </CardHeader>
        <CardContent>
          {templates.length === 0 ? (
            <p className="py-6 text-center text-sm text-subtle">No email templates yet. Make or upload one to begin.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setTemplateId(t.id);
                    if (!name) setName(`${t.name} — ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`);
                  }}
                  aria-pressed={t.id === templateId}
                  className={cn("rounded-xl border p-2 text-left transition-colors", t.id === templateId ? "border-brand ring-2 ring-brand/40" : "border-line hover:bg-surface-sunken")}
                >
                  {t.html ? <EmailFrame html={t.html} title={t.name} scale={0.36} height={520} /> : <div className="grid h-44 place-items-center text-xs text-danger">{t.problems[0] ?? "Can't be previewed"}</div>}
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-text">{t.name}</span>
                    <Badge className="ml-auto shrink-0">{t.format === "HTML" ? "HTML" : "Text"}</Badge>
                  </div>
                  <div className="truncate text-xs text-subtle">{t.subject ?? "No subject"}</div>
                  <div className="text-[11px] text-subtle">{topicLabel(t.topic)}</div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 2. The people ────────────────────────────────────────────── */}
      <Card className={cn(!template && "pointer-events-none opacity-50")} aria-disabled={!template}>
        <CardHeader>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
            <Step n={2} done={!!reach && reach.willReceive > 0} /> Choose who gets it
          </h2>
          <p className="text-xs text-subtle">An audience from the CRM, a list you upload, or both — nobody is mailed twice.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mm-audience">
                <Users className="mr-1 inline h-3.5 w-3.5" /> Audience
              </Label>
              <Select id="mm-audience" value={audienceId} onChange={(e) => setAudienceId(e.target.value)}>
                <option value="">None</option>
                {audiences.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mm-list">
                <Upload className="mr-1 inline h-3.5 w-3.5" /> Uploaded list
              </Label>
              <Select id="mm-list" value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">None</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.members})
                  </option>
                ))}
              </Select>
              <button type="button" onClick={() => setUploading((v) => !v)} className="text-xs text-brand hover:underline">
                {uploading ? "Hide the upload" : "Upload a new list (CSV)"}
              </button>
            </div>
          </div>
          {uploading && (
            <div className="rounded-lg border border-line p-3">
              <ListUploader
                defaultTopic={template?.topic}
                onUploaded={(id) => {
                  setListId(id);
                  router.refresh();
                }}
              />
            </div>
          )}
          {hasPeople && reach && (
            <div className="rounded-lg bg-surface-sunken px-3 py-2 text-sm">
              <p className="font-medium text-text">
                {reach.willReceive} will receive it{reach.withheld ? ` · ${reach.withheld} held back` : ""}
              </p>
              {reach.reasons.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-muted">
                  {reach.reasons.slice(0, 6).map((r) => (
                    <li key={r.reason}>
                      {r.count} — {r.reason}
                    </li>
                  ))}
                </ul>
              )}
              {reach.sample.length > 0 && (
                <p className="mt-1 text-xs text-subtle">
                  For example: {reach.sample.map((s) => `${s.name}${s.company ? ` (${s.company})` : ""}`).join(", ")}
                </p>
              )}
              {reach.needsApproval && <p className="mt-1 text-xs text-warning">That&apos;s {reach.approvalThreshold} or more — a second person will need to approve it.</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 3. Check and send ────────────────────────────────────────── */}
      <Card className={cn((!template || !reach || reach.willReceive === 0) && "pointer-events-none opacity-50")}>
        <CardHeader>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
            <Step n={3} done={false} /> Check and send
          </h2>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mm-name">Campaign name</Label>
              <Input id="mm-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Diwali offer — 25 Sep" />
              <p className="text-[11px] text-subtle">For you and the report. Customers never see it.</p>
            </div>
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium text-text">When</legend>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="mm-when" checked={when === "now"} onChange={() => setWhen("now")} className="accent-[var(--brand)]" /> Now
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="mm-when" checked={when === "later"} onChange={() => setWhen("later")} className="accent-[var(--brand)]" /> Later
                </label>
                {when === "later" && <Input type="datetime-local" aria-label="Send at" value={at} onChange={(e) => setAt(e.target.value)} className="h-8 w-auto" />}
              </div>
              <p className="flex items-center gap-1 text-[11px] text-subtle">
                <Clock className="h-3 w-3" /> Your quiet hours and holidays are respected either way.
              </p>
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={pending || !templateId}
                onClick={() =>
                  startTransition(async () => {
                    const r = await sendTestEmail({ templateId: templateId! });
                    setNotice(r.ok ? { tone: "success", text: `Test sent to ${r.data.to}.` } : { tone: "error", text: r.error });
                  })
                }
              >
                <Mail className="h-3.5 w-3.5" /> Send a test to me
              </Button>
              <Button
                size="sm"
                disabled={pending || !templateId || !name.trim() || (when === "later" && !at)}
                onClick={() =>
                  startTransition(async () => {
                    const r = await sendMassMail({
                      name,
                      templateId: templateId!,
                      audienceId: audienceId || null,
                      listId: listId || null,
                      // The picker's time is the sender's own clock; sent as an instant so the server can't misread it.
                      scheduledFor: when === "later" && at ? new Date(at).toISOString() : null,
                    });
                    if (r.ok) setDone(r.data);
                    else setNotice({ tone: "error", text: r.error });
                  })
                }
              >
                <Send className="h-3.5 w-3.5" />
                {canSend ? (when === "now" ? `Send to ${reach?.willReceive ?? 0} people` : "Schedule it") : "Save for someone to send"}
              </Button>
            </div>
            {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
          </div>
          <div className="space-y-1">
            {template?.subject && <p className="text-sm font-medium text-text">{template.subject}</p>}
            {template?.html && <EmailFrame html={template.html} title="The email" height={480} />}
            <p className="text-[11px] text-subtle">Shown with example values. Each person gets their own name, and their own unsubscribe link in the footer.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Step({ n, done }: { n: number; done: boolean }) {
  return (
    <span className={cn("grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold", done ? "bg-success text-white" : "bg-surface-sunken text-muted")}>
      {done ? "✓" : n}
    </span>
  );
}
