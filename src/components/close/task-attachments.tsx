"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Paperclip, Trash2 } from "lucide-react";
import { addTaskAttachment, deleteTaskAttachment, getTaskAttachmentFile } from "@/actions/close";
import { Label } from "@/components/ui/input";
import { ALLOWED_MIME, MAX_FILE_BYTES } from "@/lib/hr/document-upload";
import { dayLong } from "@/components/close/format";

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date | string;
  uploadedBy: { id: string; name: string } | null;
};

function sizeText(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The files kept with a task — the bank statement a reconciliation was agreed to, the GST working.
 *
 * Stored the way project and HR documents are (a data URL in the row), with the same rules: PDF,
 * Word or an image, up to 4 MB. The list carries names only; a file is fetched when it is opened.
 */
export function TaskAttachments({ taskId, attachments, canEdit }: { taskId: string; attachments: Attachment[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputId = `task-${taskId}-file`;

  function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    setError(null);
    if (!ALLOWED_MIME.includes(file.type)) {
      setError("Only PDF, Word and image files can be attached.");
      input.value = "";
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 4 MB.`);
      input.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      startTransition(async () => {
        const result = await addTaskAttachment(taskId, { name: file.name, fileDataUrl: String(reader.result), mimeType: file.type });
        input.value = "";
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      });
    };
    reader.readAsDataURL(file);
  }

  function open(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await getTaskAttachmentFile(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Through a blob rather than the data URL itself: browsers refuse to navigate to a long data URL.
      const blob = await (await fetch(result.data.fileDataUrl)).blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.data.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });
  }

  function remove(file: Attachment) {
    if (!window.confirm(`Remove "${file.name}" from this task?`)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteTaskAttachment(file.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-subtle">
        <Paperclip className="h-3.5 w-3.5" aria-hidden />
        Attachments
      </h4>
      {attachments.length === 0 ? (
        <p className="text-sm text-subtle">
          {canEdit ? "Nothing attached. Keep the statement or working this task was agreed to here." : "Nothing attached."}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-base border border-line">
          {attachments.map((file) => (
            <li key={file.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <button
                type="button"
                onClick={() => open(file.id)}
                disabled={pending}
                className="inline-flex min-w-0 items-center gap-1.5 break-all text-left text-brand hover:underline"
              >
                <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {file.name}
              </button>
              <span className="text-xs text-subtle">
                {sizeText(file.sizeBytes)} · {file.uploadedBy?.name ?? "somebody"} · {dayLong(file.createdAt)}
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => remove(file)}
                  disabled={pending}
                  aria-label={`Remove ${file.name}`}
                  className="ml-auto rounded-base p-1 text-subtle hover:bg-surface-sunken hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="space-y-1">
          <Label htmlFor={inputId}>Attach a file</Label>
          <input
            id={inputId}
            type="file"
            accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp"
            onChange={onPick}
            disabled={pending}
            className="block w-full max-w-md rounded-base border border-line-strong bg-surface px-3 py-2 text-sm text-text file:mr-3 file:rounded file:border-0 file:bg-surface-sunken file:px-2 file:py-1 file:text-xs file:text-text"
          />
          <p className="text-xs text-subtle">PDF, Word or an image, up to 4 MB.{pending ? " Working…" : ""}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
