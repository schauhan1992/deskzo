"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { giveVendorsCodes, saveVendorCodePrefix, type VendorCodeSettings } from "@/actions/vendor-codes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

export function VendorCodesManager({ settings }: { settings: VendorCodeSettings }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [prefix, setPrefix] = useState(settings.prefix);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const changed = prefix.trim().toUpperCase() !== settings.prefix;

  function save() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await saveVendorCodePrefix(prefix);
      if (!result.ok) return setError(result.error);
      setNotice("Saved. Vendors added from now on are numbered under the new prefix; existing codes stay as they are.");
      router.refresh();
    });
  }

  function giveCodes() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await giveVendorsCodes();
      if (!result.ok) return setError(result.error);
      setNotice(result.data.given === 0 ? "Every vendor already has a code." : `Gave ${result.data.given} vendor${result.data.given === 1 ? "" : "s"} a code.`);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Numbering</CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="vendor-code-prefix">Prefix</Label>
            <Input
              id="vendor-code-prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              maxLength={12}
              className="w-40 font-mono uppercase"
              aria-describedby="vendor-code-next"
            />
          </div>
          <Button type="button" size="sm" onClick={save} disabled={pending || !changed}>
            Save
          </Button>
        </div>
        <p id="vendor-code-next" className="text-sm text-muted">
          The next vendor added will be{" "}
          <span className="font-mono text-text">{changed ? `${prefix.trim().toUpperCase()}0001 (or after the highest in use)` : settings.nextCode}</span>.
        </p>

        {settings.withoutCode > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-base border border-line bg-surface-sunken px-3 py-2.5 text-sm">
            <span className="text-muted">
              {settings.withoutCode} vendor{settings.withoutCode === 1 ? " has" : "s have"} no code yet — added before codes were
              automatic.
            </span>
            <Button type="button" variant="secondary" size="sm" onClick={giveCodes} disabled={pending || changed}>
              Give them codes
            </Button>
          </div>
        )}

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {notice && <p role="status" className="text-sm text-success">{notice}</p>}
      </CardContent>
    </Card>
  );
}
