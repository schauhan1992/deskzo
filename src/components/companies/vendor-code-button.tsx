"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Hash } from "lucide-react";
import { setVendorCode } from "@/actions/company";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

export function VendorCodeButton({ companyId, vendorCode }: { companyId: string; vendorCode: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(vendorCode ?? "");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setValue(vendorCode ?? "");
    setOpen(true);
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await setVendorCode(companyId, value);
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
        <Hash className="h-3 w-3" />
        {vendorCode ? `Vendor code: ${vendorCode}` : "Set vendor code"}
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Vendor code">
        <div className="space-y-3">
          {error && <p className="text-xs text-danger">{error}</p>}
          {/* aria-label rather than a visible label: the dialog heading captions this field but does
              not name it, and the placeholder disappears the moment somebody types. */}
          <Input
            aria-label="Vendor code"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Your internal reference for this vendor"
          />
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
