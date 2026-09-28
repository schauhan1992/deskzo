"use client";

import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { LoaderCircle, Mail, NotebookPen } from "lucide-react";
import { noteSupport, replySupport } from "@/actions/platform/console-support";
import { Panel } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { LIMITS } from "@/lib/support/types";
import { cn } from "@/lib/utils";

/**
 * Answering a request: "Reply to customer" is emailed to the requester and kept on the timeline;
 * "Internal note" stays on the timeline for staff and goes nowhere. One draft per tab, so starting
 * a note does not lose half a reply.
 *
 * There is no inbound mail: the customer's answer to the email reaches the support mailbox (the
 * mail's Reply-To), not this page — the reply tab's hint says so, naming the address.
 *
 * After a reply the outcome stays under the form — emailed, or kept on the timeline with why the
 * email failed — and the page refreshes, so the timeline shows it. Plain text only; Ctrl/⌘+Enter
 * sends.
 */

type Mode = "reply" | "note";

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
/** The counter turns to a warning this close to the limit. */
const NEAR = 500;

function submitOnModEnter(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  e.currentTarget.form?.requestSubmit();
}

export function SupportComposer({ number, requesterEmail, supportEmail }: { number: number; requesterEmail: string; supportEmail: string }) {
  const [mode, setMode] = useState<Mode>("reply");
  const [drafts, setDrafts] = useState<Record<Mode, string>>({ reply: "", note: "" });
  const [outcome, setOutcome] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const reply = useConsoleAction<{ emailed: boolean; error: string | null }>();
  const note = useConsoleAction<null>();
  const id = useId();

  const action = mode === "reply" ? reply : note;
  const pending = reply.pending || note.pending;
  const body = drafts[mode];
  const length = [...body].length;
  const over = length > LIMITS.body;
  const empty = body.trim() === "";

  const tabId = (m: Mode) => `${id}-tab-${m}`;
  const panelId = `${id}-panel`;
  const fieldId = `${id}-field`;
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;

  function choose(next: Mode) {
    setMode(next);
    setOutcome(null);
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next: Mode = e.key === "Home" ? "reply" : e.key === "End" ? "note" : mode === "reply" ? "note" : "reply";
    choose(next);
    document.getElementById(tabId(next))?.focus();
  }

  function edit(text: string) {
    if (action.error) action.reset();
    setOutcome(null);
    setDrafts((d) => ({ ...d, [mode]: text }));
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (empty || over || pending) return;
    setOutcome(null);
    if (mode === "reply") {
      reply.run(() => replySupport(number, body), {
        onDone: (data) => {
          setDrafts((d) => ({ ...d, reply: "" }));
          setOutcome(
            data.emailed
              ? { tone: "success", message: `Reply emailed to ${requesterEmail}.` }
              : { tone: "error", message: `The reply is on the timeline, but the email failed: ${data.error ?? "the mail server gave no reason"}. Try again, or contact them another way.` },
          );
        },
      });
    } else {
      note.run(() => noteSupport(number, body), {
        onDone: () => {
          setDrafts((d) => ({ ...d, note: "" }));
          setOutcome({ tone: "success", message: "Internal note added." });
        },
      });
    }
  }

  const notice = action.error ? { tone: "error" as const, message: action.error } : outcome;

  return (
    <Panel title="Respond" padded={false}>
      <div role="tablist" aria-label="Respond with" className="flex gap-1 px-5 pt-2 shadow-[inset_0_-1px_0_var(--line)]">
        {(["reply", "note"] as const).map((m) => {
          const on = m === mode;
          const Icon = m === "reply" ? Mail : NotebookPen;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              id={tabId(m)}
              aria-selected={on}
              aria-controls={panelId}
              tabIndex={on ? 0 : -1}
              onClick={() => choose(m)}
              onKeyDown={onTabKey}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-t-base border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
                on ? "border-brand text-text" : "border-transparent text-muted hover:border-line-strong hover:text-text",
              )}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              {m === "reply" ? "Reply to customer" : "Internal note"}
            </button>
          );
        })}
      </div>

      <form id={panelId} role="tabpanel" aria-labelledby={tabId(mode)} onSubmit={submit} noValidate className={cn("space-y-3 px-5 py-4", mode === "note" && "bg-warning-bg/40")}>
        <div className="space-y-1.5">
          <label htmlFor={fieldId} className="text-[13px] font-medium text-muted">
            {mode === "reply" ? "Reply" : "Note"}
          </label>
          <Textarea
            id={fieldId}
            value={body}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={submitOnModEnter}
            rows={6}
            placeholder={mode === "reply" ? "Write to the customer…" : "For staff only — the customer never sees this."}
            aria-describedby={`${hintId} ${countId}`}
            aria-invalid={over || undefined}
            readOnly={pending}
            className={cn(over && "border-danger")}
          />
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <p id={hintId} className="min-w-0 flex-1 basis-64 text-xs text-muted">
              {mode === "reply" ? (
                <>
                  {`They'll get this by email at ${requesterEmail}; replies to it go to `}
                  <span className="font-medium text-text">{supportEmail}</span>
                  {", not back here."}
                </>
              ) : (
                "Internal: kept on this request for staff, never emailed."
              )}
            </p>
            <p id={countId} className={cn("shrink-0 text-xs tabular-nums", over ? "text-danger" : length > LIMITS.body - NEAR ? "text-warning" : "text-subtle")}>
              {over
                ? `${INTEGER.format(length - LIMITS.body)} characters over the ${INTEGER.format(LIMITS.body)} limit`
                : `${INTEGER.format(length)} / ${INTEGER.format(LIMITS.body)}`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={empty || over}
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
            className={cn(pending && "cursor-wait opacity-70")}
          >
            {pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            {mode === "reply" ? "Send reply" : "Add note"}
          </Button>
        </div>
        <ActionNoticeRegion notice={notice} />
      </form>
    </Panel>
  );
}
