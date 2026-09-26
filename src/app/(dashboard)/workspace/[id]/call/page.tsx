import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { myCallingQueue } from "@/actions/calling-activity";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CallingStation } from "@/components/workspace/calling-station";
import { formatDate } from "@/lib/utils";
import { isModuleEntitled } from "@/lib/modules-access";

/**
 * A caller's own queue. Shows only the records assigned to them — a shared campaign has to feel
 * like a personal list or two people work the same number.
 */
export default async function CallingPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("workspace");
  if (!enabled) return <ModuleDisabledNotice moduleKey="workspace" />;
  if (!(await isModuleEntitled("calls"))) return <ModuleDisabledNotice moduleKey="calls" />;

  const { id } = await params;
  const queue = await myCallingQueue(id);
  if (!queue) notFound();

  return (
    <div className="animate-fade-rise">
      <Link href={`/workspace/${id}`} className="text-sm text-muted hover:text-text">
        ← {queue.workbook.name}
      </Link>
      <div className="mt-1 mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Calling</h1>
          <p className="mt-1 text-sm text-muted">
            {queue.workbook.description ?? "Your share of this list."}
            {queue.workbook.dueAt && ` · due ${formatDate(queue.workbook.dueAt)}`}
          </p>
        </div>
      </div>

      {queue.records.length === 0 ? (
        <Card className="px-4 py-16 text-center">
          <p className="text-sm text-muted">Nothing on this list is assigned to you.</p>
          <Link href={`/workspace/${id}`} className="mt-4 inline-block">
            <Button variant="secondary">Back to the list</Button>
          </Link>
        </Card>
      ) : (
        <CallingStation queue={queue} />
      )}
    </div>
  );
}
