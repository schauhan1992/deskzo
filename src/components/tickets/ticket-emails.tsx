import { Paperclip } from "lucide-react";
import { ticketEmails } from "@/actions/support-mail";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { workspaceClock } from "@/lib/time/workspace";
import { fileSize } from "@/lib/support-mail/rules";
import { TicketEmailReply } from "@/components/tickets/ticket-email-reply";

/**
 * A ticket's email conversation with the customer (src/lib/support-mail): what they wrote, what we
 * answered, oldest first — and the box to answer from. Only text is ever shown; the earlier conversation
 * each email quotes is folded away under it. Renders nothing for a ticket that never had an email and
 * whose contact has no address to write to.
 */
export async function TicketEmails({ ticketId }: { ticketId: string }) {
  const [thread, clock] = await Promise.all([ticketEmails(ticketId), workspaceClock()]);
  if (!thread || (thread.emails.length === 0 && !thread.replyTo)) return null;

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Email conversation</CardHeader>
      <CardContent className="space-y-4">
        {thread.emails.length === 0 && <p className="text-sm text-subtle">No emails yet. A reply from here starts the conversation.</p>}
        {thread.emails.map((e) => {
          const ours = e.direction === "OUTBOUND";
          return (
            <article key={e.id} className={`rounded-base border px-3 py-2.5 ${ours ? "border-brand/30 bg-brand-subtle/40" : "border-line"}`}>
              <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-sm font-medium text-text">
                  {ours ? (e.sentBy?.name ?? "Automatic reply") : (e.fromName ?? e.fromAddress)}
                  <span className="ml-1.5 text-xs font-normal text-subtle">
                    {ours ? `to ${e.toAddresses.join(", ")}` : e.fromName ? e.fromAddress : ""}
                  </span>
                </p>
                <span className="flex items-center gap-2 text-xs text-subtle">
                  {e.state === "FAILED" && <Badge tone="red">Not sent</Badge>}
                  <time dateTime={e.createdAt}>{clock.dateTime(e.createdAt)}</time>
                </span>
              </header>
              {e.ccAddresses.length > 0 && <p className="text-xs text-subtle">Cc {e.ccAddresses.join(", ")}</p>}
              <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-text">{e.visible || <span className="text-subtle">(No text.)</span>}</p>
              {e.quoted && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted hover:text-text">Earlier conversation</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-xs text-muted">{e.quoted}</p>
                </details>
              )}
              {e.state === "FAILED" && e.note && <p className="mt-1 text-xs text-danger">{e.note}</p>}
              {e.attachments.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {e.attachments.map((a) => (
                    <li key={a.id}>
                      <a
                        href={`/api/support-email/attachments/${a.id}`}
                        className="inline-flex items-center gap-1 rounded-base border border-line px-2 py-1 text-xs text-text hover:bg-surface-sunken"
                      >
                        <Paperclip className="h-3 w-3" aria-hidden="true" />
                        {a.fileName} <span className="text-subtle">({fileSize(a.sizeBytes)})</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
        <TicketEmailReply ticketId={ticketId} to={thread.replyTo} canReply={thread.canReply} />
      </CardContent>
    </Card>
  );
}
