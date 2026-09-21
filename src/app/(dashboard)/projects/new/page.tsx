import Link from "next/link";
import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { projectFormOptions } from "@/actions/project";
import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import { ProjectForm } from "@/components/projects/project-form";

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  if (!(await isModuleEnabled("projects"))) return <ModuleDisabledNotice moduleKey="projects" />;

  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "projects.manage"))) redirect("/projects");

  const { companyId } = await searchParams;
  const options = await projectFormOptions();

  return (
    <div className="animate-fade-rise">
      <Link href="/projects" className="text-sm text-muted hover:text-text">
        ← Projects
      </Link>
      <div className="mt-3 max-w-3xl">
        <ProjectForm options={options} defaultCompanyId={companyId} />
      </div>
    </div>
  );
}
