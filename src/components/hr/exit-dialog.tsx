"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserMinus } from "lucide-react";
import { recordExit } from "@/actions/hr";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { exitTypeLabels, exitTypeValues } from "@/lib/validation/hr";

/**
 * Recording that somebody has left.
 *
 * "Also deactivate their login" is ticked by default and shown as its own line rather than done
 * quietly, because an ex-employee who still has access is the failure that actually costs something
 * — and because somebody serving notice may need their login for another three weeks, which is the
 * one case where it has to be untickable.
 */
export function ExitDialog({ userId, name }: { userId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [exitedOn, setExitedOn] = useState(new Date().toISOString().slice(0, 10));
  const [exitType, setExitType] = useState<string>("RESIGNED");
  const [exitReason, setExitReason] = useState("");
  const [deactivateLogin, setDeactivateLogin] = useState(true);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await recordExit({ userId, exitedOn, exitType, exitReason, deactivateLogin });
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
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <UserMinus className="mr-1.5 h-3.5 w-3.5" />
        Record exit
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title={`Record ${name}'s exit`}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="exitedOn">Last working day</Label>
              <Input id="exitedOn" type="date" value={exitedOn} onChange={(e) => setExitedOn(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exitType">How</Label>
              <Select id="exitType" value={exitType} onChange={(e) => setExitType(e.target.value)}>
                {exitTypeValues.map((t) => (
                  <option key={t} value={t}>
                    {exitTypeLabels[t]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="exitReason">Notes</Label>
            <Textarea
              id="exitReason"
              rows={3}
              value={exitReason}
              onChange={(e) => setExitReason(e.target.value)}
              placeholder="Where they're going, what was said at the exit interview, anything worth remembering."
            />
          </div>

          <label className="flex items-start gap-2 rounded-base border border-line px-3 py-2.5">
            <Checkbox checked={deactivateLogin} onChange={() => setDeactivateLogin((v) => !v)} aria-label="Deactivate login" />
            <span className="text-sm">
              <span className="block text-text">Deactivate their login now</span>
              <span className="block text-xs text-muted">
                Untick only if they&apos;re serving notice and still need access. Their records stay either way.
              </span>
            </span>
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button variant="danger" disabled={pending} onClick={submit}>
              {pending ? "Recording…" : "Record exit"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
