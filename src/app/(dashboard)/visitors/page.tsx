import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, CalendarClock, Settings2 } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listVisitors } from "@/actions/visitor";
import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import { VisitorBook } from "@/components/visitors/visitor-book";
import { Button } from "@/components/ui/button";

export default async function VisitorsPage({
  searchParams,
}: {
  searchParams: Promise<{ onDate?: string; status?: string }>;
}) {
  if (!(await isModuleEnabled("visitors"))) return <ModuleDisabledNotice moduleKey="visitors" />;

  const params = await searchParams;
  const user = await requireUser();
  const [entries, canManage] = await Promise.all([
    listVisitors({ onDate: params.onDate, status: (params.status as "IN" | "OUT" | "ALL") ?? "ALL" }),
    hasEffectivePermission(user.id, "visitors.manage"),
  ]);
  if (entries === null) notFound();

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Visitors</h1>
          <p className="mt-1 text-sm text-muted">Who has signed in at reception, and who is still in the building.</p>
        </div>
        <Link href="/visitors/expected">
          <Button variant="secondary">
            <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
            Expected visitors
          </Button>
        </Link>
        {canManage && (
          <Link href="/visitors/companies">
            <Button variant="secondary">
              <Building2 className="mr-1.5 h-3.5 w-3.5" />
              Companies
            </Button>
          </Link>
        )}
        {canManage && (
          <Link href="/visitors/kiosks">
            <Button variant="secondary">
              <Settings2 className="mr-1.5 h-3.5 w-3.5" />
              Reception tablets
            </Button>
          </Link>
        )}
        </div>
      <div className="mt-5">
        <VisitorBook entries={entries} />
      </div>
    </div>
  );
}
