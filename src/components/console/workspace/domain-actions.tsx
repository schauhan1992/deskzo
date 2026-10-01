"use client";

import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { consoleAddDomain, consoleRemoveDomain } from "@/actions/platform/console-domains";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/**
 * Workspace 360's Domains panel, its two controls that need more than a click: adding an address
 * (typed in a dialog) and removing one (with the reason that is kept with it). Check now and Make
 * primary are plain `ActionButton`s in the panel itself.
 */

export function AddDomainButton({ tenantId, slug }: { tenantId: string; slug: string }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");
  const { pending, error, run, reset } = useConsoleAction<{ id: string; host: string }>();
  const id = useId();

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          reset();
          setHost("");
          setOpen(true);
        }}
      >
        <Plus aria-hidden="true" className="h-4 w-4" />
        Add address
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title="Add an address"
        confirmLabel="Add address"
        pending={pending}
        error={error}
        confirmDisabled={!host.trim()}
        onConfirm={() => run(() => consoleAddDomain(tenantId, host), { success: (d) => `${d.host} added — it waits for its DNS records.`, onDone: () => setOpen(false) })}
      >
        <div className="space-y-1.5">
          <Label htmlFor={id}>Address</Label>
          <Input id={id} value={host} onChange={(e) => setHost(e.target.value)} placeholder="erp.example.com" autoComplete="off" spellCheck={false} className="font-mono" />
        </div>
        <p className="text-xs text-muted">
          {`Added for ${slug} whatever the platform switch says — its plan's allowance still applies. It is served once its TXT record and its pointer check out.`}
        </p>
      </ConfirmDialog>
    </>
  );
}

export function RemoveDomainButton({ tenantId, domainId, host, primary, ownHost }: { tenantId: string; domainId: string; host: string; primary: boolean; ownHost: string }) {
  const [open, setOpen] = useState(false);
  const { pending, error, run, reset } = useConsoleAction<null>();
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
        Remove
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title={`Remove ${host}`}
        confirmLabel="Remove address"
        tone="danger"
        reason={{ label: "Why", minLength: 5, maxLength: 300, placeholder: "Kept with the change — e.g. the customer asked, moving to another address" }}
        pending={pending}
        error={error}
        onConfirm={({ reason }) => run(() => consoleRemoveDomain(tenantId, domainId, reason), { success: `${host} removed.`, onDone: () => setOpen(false) })}
      >
        <p>{`${host} stops reaching this workspace at once${primary ? `, and its links go back to ${ownHost}` : ""}. Anybody signed in there is signed out.`}</p>
      </ConfirmDialog>
    </>
  );
}
