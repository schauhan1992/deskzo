"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setExpenseReceiptRule } from "@/actions/expense";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * When a claim needs its receipt (owner, 22 Oct 2026; src/lib/expenses/receipts.ts): an amount in rupees, or empty for
 * never — the same rule for claims made on the web and in the Deskzo app.
 */
export function ExpenseReceiptRuleForm({ above }: { above: number | null }) {
  const router = useRouter();
  const [value, setValue] = useState(above === null ? "" : String(above));
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = value.trim() !== (above === null ? "" : String(above));

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await setExpenseReceiptRule({ above: value.trim() === "" ? null : value.replace(/[,\s₹]/g, "") });
      if (!result.ok) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      setMessage({
        ok: true,
        text: result.data.above === null ? "Saved. A receipt is never required." : `Saved. Claims over ₹${result.data.above.toLocaleString("en-IN")} need a receipt from now on.`,
      });
      router.refresh();
    });
  }

  return (
    <Card className="mt-5 max-w-2xl p-5">
      <Label htmlFor="receipt-above" className="text-sm font-medium text-text">
        A receipt is needed for claims over
      </Label>
      <div className="mt-2 flex max-w-xs items-center gap-2">
        <span className="text-sm text-muted">₹</span>
        <Input id="receipt-above" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Never" />
      </div>
      <p className="mt-2 text-xs text-subtle">
        Over this amount a claim can&apos;t be submitted without a photo of its receipt — on the web and in the Deskzo app. A draft can wait
        for one. Leave it empty and a receipt is never required.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} disabled={pending || !changed}>
          Save
        </Button>
        {message && <span className={cn("text-sm", message.ok ? "text-success" : "text-danger")}>{message.text}</span>}
      </div>
    </Card>
  );
}
