"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PaymentsDialog, type PayableOrder } from "@/components/payments/payments-dialog";

export function PaymentsRowAction({
  order,
  companyId,
  companyName,
  canRecord,
  canDelete,
}: {
  order: PayableOrder;
  companyId: string;
  companyName: string;
  canRecord: boolean;
  canDelete: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!canRecord && !canDelete) return null;

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Payments
      </Button>
      {open && (
        <PaymentsDialog
          order={order}
          open
          onClose={() => setOpen(false)}
          canRecord={canRecord}
          canDelete={canDelete}
          companyId={companyId}
          companyName={companyName}
        />
      )}
    </>
  );
}
