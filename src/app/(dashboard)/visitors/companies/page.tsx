import Link from "next/link";
import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listVisitorCompanies } from "@/actions/visitor";
import { VisitorCompanies } from "@/components/visitors/visitor-companies";

export default async function VisitorCompaniesPage() {
  if (!(await isModuleEnabled("visitors"))) return <ModuleDisabledNotice moduleKey="visitors" />;

  const rows = await listVisitorCompanies();
  if (rows === null) redirect("/visitors");

  return (
    <div className="animate-fade-rise">
      <Link href="/visitors" className="text-sm text-muted hover:text-text">
        ← Visitors
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-text">Visitor companies</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        The list the reception tablet searches. It grows on its own as people arrive.
      </p>
      <div className="mt-5">
        <VisitorCompanies rows={rows} />
      </div>
    </div>
  );
}
