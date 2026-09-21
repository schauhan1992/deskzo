"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserRound } from "lucide-react";
import { setCompanyOwner } from "@/actions/company";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

type Owner = { id: string; name: string } | null;
type AssignableUser = { id: string; name: string; role: string };

export function AccountManagerButton({
  companyId,
  owner,
  users,
}: {
  companyId: string;
  owner: Owner;
  users: AssignableUser[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(owner?.id ?? "");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setSelected(owner?.id ?? "");
    setOpen(true);
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await setCompanyOwner(companyId, selected || null);
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
        <UserRound className="h-3 w-3" />
        {owner ? `Account manager: ${owner.name}` : "Assign account manager"}
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Account manager">
        <div className="space-y-3">
          {error && <p className="text-xs text-danger">{error}</p>}
          <Select aria-label="Account manager" value={selected} onChange={(e) => setSelected(e.target.value)}>
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
