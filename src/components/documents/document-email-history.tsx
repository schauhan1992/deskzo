import { Mail } from "lucide-react";
import { listDocumentEmails } from "@/actions/document-mail";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatIstDateTime } from "@/lib/india-time";

/**
 * Every time this document was emailed from here, one line per send: when, who sent it, from which
 * mailbox, and to whom — including the ones that failed, with why. Nothing is shown until the first
 * send, so an unsent document carries no empty box.
 */
export async function DocumentEmailHistory({ documentId }: { documentId: string }) {
  const rows = await listDocumentEmails(documentId);
  if (rows.length === 0) return null;

  // One send reaches several people; they are one line here, as they were one email.
  const sends = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.createdAt}|${r.subject}|${r.status}`;
    sends.set(key, [...(sends.get(key) ?? []), r]);
  }

  return (
    <Card className="mt-4">
      <CardHeader className="flex items-center gap-2">
        <Mail className="h-4 w-4 text-brand" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-text">Emailed</h2>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-line">
          {[...sends.values()].map((group) => {
            const first = group[0];
            const failed = first.status === "FAILED";
            return (
              <li key={first.id} className="px-5 py-3 text-sm">
                <p className="text-text">
                  {failed ? <span className="font-medium text-danger">Not sent</span> : <span className="font-medium">Sent</span>} to{" "}
                  {group.map((r) => (r.contact?.name ? `${r.contact.name} <${r.toEmail}>` : r.toEmail)).join(", ")}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {formatIstDateTime(first.sentAt ?? first.createdAt)}
                  {first.sentBy?.name ? ` · by ${first.sentBy.name}` : ""}
                  {first.fromEmail ? ` · from ${first.fromEmail}` : ""}
                </p>
                {failed && first.error && <p className="mt-0.5 text-xs text-danger">{first.error}</p>}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
