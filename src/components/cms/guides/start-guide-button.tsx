"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { cmsStartGuide } from "@/actions/cms/guides";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { Button } from "@/components/ui/button";
import { CMS_ROUTES } from "@/lib/cms/nav";
import type { PageDetail } from "@/lib/cms/types";

/** "Start the guide": a draft at help/<module name> with the outline in it, opened in the page editor. */
export function StartGuideButton({ moduleKey, label }: { moduleKey: string; label: string }) {
  const router = useRouter();
  const action = useCmsAction<PageDetail>();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={action.pending}
        onClick={() => action.run(() => cmsStartGuide(moduleKey), { success: "", refresh: false, onDone: (page) => router.push(CMS_ROUTES.page(page.id)) })}
      >
        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
        {action.pending ? "Starting…" : "Start the guide"}
        <span className="sr-only"> for {label}</span>
      </Button>
      {action.error && <span className="max-w-xs text-right text-xs text-danger">{action.error}</span>}
    </span>
  );
}
