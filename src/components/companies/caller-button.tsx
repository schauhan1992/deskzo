"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PhoneCall } from "lucide-react";
import { setCompanyCaller } from "@/actions/company";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

type Caller = { id: string; name: string } | null;
type AssignableUser = { id: string; name: string; role: string };

/** The caller works this company for lead generation — the calling counterpart to `AccountManagerButton`, who services the account once it's a customer. Both can be set at once. */
export function CallerButton({
  companyId,
  caller,
  users,
}: {
  companyId: string;
  caller: Caller;
  users: AssignableUser[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(caller?.id ?? "");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setSelected(caller?.id ?? "");
    setOpen(true);
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await setCompanyCaller(companyId, selected || null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs font-medium text-text transition-colors hover:bg-line"
      >
        <PhoneCall className="h-3 w-3" />
        {caller ? `Caller: ${caller.name}` : "Assign caller"}
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Caller">
        <div className="space-y-3">
          <p className="text-xs text-muted">Who&apos;s working this company for lead generation.</p>
          {error && <p className="text-xs text-danger">{error}</p>}
          {/* aria-label rather than a visible label: the dialog heading is the only caption this
              control has, and a heading is not a label — it names the dialog, not the select. */}
          <Select aria-label="Caller" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </Select>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={isPending}>
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
