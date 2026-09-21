"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { duplicateWorkbook } from "@/actions/workspace";
import { Button } from "@/components/ui/button";

/** Copies someone else's list so it can be narrowed without changing theirs. */
export function DuplicateWorkbookButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await duplicateWorkbook(id);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.push(`/workspace/${result.data.id}/edit`);
            router.refresh();
          })
        }
      >
        <Copy className="mr-1.5 h-3.5 w-3.5" />
        {pending ? "Copying…" : "Duplicate"}
      </Button>
      {error && <span className="text-sm text-danger">{error}</span>}
    </>
  );
}
