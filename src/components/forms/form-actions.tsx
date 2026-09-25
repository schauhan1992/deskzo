"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Copy, CopyPlus, ExternalLink, Lock, PencilLine, Trash2, Unlock } from "lucide-react";
import { deleteForm, duplicateForm, setFormActive } from "@/actions/forms";
import { Button } from "@/components/ui/button";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * The buttons at the top of a form: its link, and what this person may do to it.
 *
 * Each button is shown only to somebody the action would accept — the action checks again, because
 * a hidden button is a courtesy and not a control.
 */
export function FormActions({
  formId,
  slug,
  active,
  publicLink,
  canEdit,
  canDuplicate,
  canDelete,
}: {
  formId: string;
  slug: string;
  active: boolean;
  /** Null when the form takes invitations only, so there is no public link to hand out. */
  publicLink: boolean;
  canEdit: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (work: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, then?: (data: unknown) => void) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      then?.(result.data);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {publicLink && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(`${window.location.origin}/forms/${slug}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy link"}
            </Button>
            <a href={`/forms/${slug}`} target="_blank" rel="noreferrer">
              <Button variant="secondary" size="sm">
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </Button>
            </a>
          </>
        )}
        {canEdit && (
          <>
            <Link href={`/marketing/forms/${formId}/edit`}>
              <Button variant="secondary" size="sm">
                <PencilLine className="h-3.5 w-3.5" />
                Edit
              </Button>
            </Link>
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => run(() => setFormActive(formId, !active))}>
              {active ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
              {active ? "Close" : "Reopen"}
            </Button>
          </>
        )}
        {canDuplicate && (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => run(() => duplicateForm(formId), (data) => router.push(`/marketing/forms/${(data as { id: string }).id}/edit`))}
          >
            <CopyPlus className="h-3.5 w-3.5" />
            Duplicate
          </Button>
        )}
        {canDelete && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (!window.confirm("Delete this form? This can't be undone.")) return;
              run(() => deleteForm(formId), () => router.push("/marketing/forms"));
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        )}
      </div>
      {error && <ActionNotice tone="error">{error}</ActionNotice>}
    </div>
  );
}
