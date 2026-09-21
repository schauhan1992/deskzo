import Link from "next/link";
import { Plus, Users } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listWorkbooks } from "@/actions/workspace";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

/**
 * Saved lists. The ones most recently opened come first, because a worklist is something people
 * come back to daily rather than browse.
 */
type Workbook = Awaited<ReturnType<typeof listWorkbooks>>[number];

function WorkbookCard({ workbook: w }: { workbook: Workbook }) {
  return (
    <Link href={`/workspace/${w.id}`}>
      <Card className="h-full p-4 transition-colors hover:bg-surface-sunken">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <span className="font-medium text-text">{w.name}</span>
          {!w.mine && (
            <Badge tone="default">
              <Users className="mr-1 inline h-3 w-3" />
              {w.owner.name}
            </Badge>
          )}
        </div>
        {w.description && <p className="mt-1 text-sm text-muted">{w.description}</p>}

        {w.assignees.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {w.assignees.map((a) => (
              <Badge key={a.userId} tone="blue">
                {a.user.name}
              </Badge>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-subtle">
          {w.mode === "COLD_CALLING" ? (
            <Badge tone="amber">Calling · {w._count.records} records</Badge>
          ) : (
            <span>
              {w.filterCount} filter{w.filterCount === 1 ? "" : "s"}
            </span>
          )}
          <span>·</span>
          <span>{w.lastOpenedAt ? `opened ${formatDate(w.lastOpenedAt)}` : `saved ${formatDate(w.updatedAt)}`}</span>
          {!w.shared && (
            <>
              <span>·</span>
              <span>private</span>
            </>
          )}
        </div>
      </Card>
    </Link>
  );
}

export default async function WorkspacePage() {
  const enabled = await isModuleEnabled("workspace");
  if (!enabled) return <ModuleDisabledNotice moduleKey="workspace" />;

  const all = await listWorkbooks();
  const mine = all.filter((w) => w.assignedToMe);
  const rest = all.filter((w) => !w.assignedToMe);

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Workspace</h1>
          <p className="mt-1 text-sm text-muted">
            Saved lists built from filters — a territory, a renewal window, every account nobody has called in
            90 days. The filters are saved, not the rows, so a list stays current as the data moves.
          </p>
        </div>
        <Link href="/workspace/new">
          <Button>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New list
          </Button>
        </Link>
      </div>

      {mine.length > 0 && (
        <>
          <h2 className="mt-6 text-sm font-medium text-text">Assigned to you</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {mine.map((w) => (
              <WorkbookCard key={w.id} workbook={w} />
            ))}
          </div>
          <h2 className="mt-8 text-sm font-medium text-text">Everything else</h2>
        </>
      )}

      <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rest.map((w) => (
          <WorkbookCard key={w.id} workbook={w} />
        ))}

        {all.length === 0 && (
          <Card className="col-span-full px-4 py-12 text-center">
            <p className="text-sm text-muted">No lists yet.</p>
            <p className="mt-1 text-sm text-subtle">
              Build one from any combination of city, industry, order type, renewal window, pipeline state or what
              their domain says — then save it and work from it.
            </p>
            <Link href="/workspace/new" className="mt-4 inline-block">
              <Button>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Build a list
              </Button>
            </Link>
          </Card>
        )}
      </div>
    </div>
  );
}
