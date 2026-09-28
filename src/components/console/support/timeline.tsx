import type { ReactNode } from "react";
import { ArrowRightLeft, CircleAlert, CircleCheck, Flag, Inbox, Mail, NotebookPen, UserRound } from "lucide-react";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { SUPPORT_PRIORITY, SUPPORT_STATUS } from "@/lib/console-shared/labels";
import type { SupportEntryView } from "@/lib/support/types";
import { cn } from "@/lib/utils";

/**
 * A request's history, oldest first: the request arriving, every reply (and whether its email went),
 * every internal note, and each change of status, priority and assignee, with who did it and when.
 *
 * Replies and notes are what staff wrote, shown as text nodes (`whitespace-pre-wrap`) — never HTML.
 * Notes are tinted and labelled "Internal", so nobody mistakes one for something the customer saw.
 * Server-safe; times are `RelativeTime` (the exact IST time on the server, "3 min ago" after mount).
 */

const statusLabel = (s: SupportEntryView & { kind: "STATUS" }, side: "from" | "to") => {
  const key = s[side];
  return key ? (SUPPORT_STATUS[key]?.label ?? key) : "—";
};
const priorityLabel = (p: SupportEntryView & { kind: "PRIORITY" }, side: "from" | "to") => {
  const key = p[side];
  return key ? (SUPPORT_PRIORITY[key]?.label ?? key) : "—";
};

export function SupportTimeline({ entries, received }: { entries: SupportEntryView[]; received: { at: Date; name: string; email: string } }) {
  return (
    <ol aria-label="Timeline" className="space-y-4">
      <Event icon={<Inbox className="h-3.5 w-3.5" />} at={received.at}>
        <span className="font-medium text-text">{received.name}</span>
        {` sent this request from Contact Support (${received.email}).`}
      </Event>
      {entries.map((entry) => (
        <EntryItem key={entry.id} entry={entry} />
      ))}
    </ol>
  );
}

function EntryItem({ entry }: { entry: SupportEntryView }) {
  const who = entry.author?.name ?? "Somebody";
  switch (entry.kind) {
    case "REPLY":
      return (
        <Message
          icon={<Mail className="h-3.5 w-3.5" />}
          who={who}
          at={entry.at}
          label={<StatusPill tone="brand">Reply</StatusPill>}
          outcome={
            entry.emailed ? (
              <span className="inline-flex items-center gap-1 text-xs text-success">
                <CircleCheck aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                {`Emailed to ${entry.to ?? "the requester"}`}
              </span>
            ) : (
              <span className="inline-flex items-start gap-1 text-xs text-danger">
                <CircleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
                <span className="break-words">{`Email failed: ${entry.error ?? "no reason given"}`}</span>
              </span>
            )
          }
          body={entry.body}
        />
      );
    case "NOTE":
      return (
        <Message
          icon={<NotebookPen className="h-3.5 w-3.5" />}
          who={who}
          at={entry.at}
          label={<StatusPill tone="warning">Internal</StatusPill>}
          body={entry.body}
          internal
        />
      );
    case "STATUS":
      return (
        <Event icon={<ArrowRightLeft className="h-3.5 w-3.5" />} at={entry.at}>
          <span className="font-medium text-text">{who}</span>
          {` changed the status from ${statusLabel(entry, "from")} to `}
          <span className="font-medium text-text">{statusLabel(entry, "to")}</span>.
        </Event>
      );
    case "PRIORITY":
      return (
        <Event icon={<Flag className="h-3.5 w-3.5" />} at={entry.at}>
          <span className="font-medium text-text">{who}</span>
          {` changed the priority from ${priorityLabel(entry, "from")} to `}
          <span className="font-medium text-text">{priorityLabel(entry, "to")}</span>.
        </Event>
      );
    case "ASSIGN":
      return (
        <Event icon={<UserRound className="h-3.5 w-3.5" />} at={entry.at}>
          <span className="font-medium text-text">{who}</span>
          {entry.to ? (
            <>
              {" assigned it to "}
              <span className="font-medium text-text">{entry.to}</span>
              {entry.from ? ` (was ${entry.from}).` : "."}
            </>
          ) : (
            ` unassigned it${entry.from ? ` (was ${entry.from})` : ""}.`
          )}
        </Event>
      );
    default:
      return null;
  }
}

/** A one-line change: an icon, the sentence, when. */
function Event({ icon, at, children }: { icon: ReactNode; at: Date; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden="true" className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-sunken text-subtle">
        {icon}
      </span>
      <p className="min-w-0 flex-1 pt-0.5 text-sm break-words text-muted">
        {children}
        <span className="ml-2 text-xs whitespace-nowrap text-subtle">
          <RelativeTime at={at} />
        </span>
      </p>
    </li>
  );
}

/** A reply or a note: who, when, what kind, and the text as written. */
function Message({
  icon,
  who,
  at,
  label,
  outcome,
  body,
  internal,
}: {
  icon: ReactNode;
  who: string;
  at: Date;
  label: ReactNode;
  outcome?: ReactNode;
  body: string;
  internal?: boolean;
}) {
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden="true" className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full", internal ? "bg-warning-bg text-warning" : "bg-brand-subtle text-brand")}>
        {icon}
      </span>
      <div className={cn("min-w-0 flex-1 rounded-lg border px-4 py-3", internal ? "border-warning/40 bg-warning-bg/50" : "border-line bg-surface")}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-text">{who}</span>
          {label}
          <span className="text-xs text-subtle">
            <RelativeTime at={at} />
          </span>
        </div>
        {outcome && <div className="mt-1">{outcome}</div>}
        <p className="mt-2 text-sm break-words whitespace-pre-wrap text-text">{body}</p>
      </div>
    </li>
  );
}
