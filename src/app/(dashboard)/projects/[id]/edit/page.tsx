import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getProject, projectFormOptions } from "@/actions/project";
import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import { ProjectForm } from "@/components/projects/project-form";

export default async function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("projects"))) return <ModuleDisabledNotice moduleKey="projects" />;

  const { id } = await params;
  const user = await requireUser();
  const [project, canManage] = await Promise.all([getProject(id), hasEffectivePermission(user.id, "projects.manage")]);
  if (!project) notFound();
  if (!canManage) redirect(`/projects/${id}`);
  // With its customer, so the company picker shows it even when the account isn't this person's.
  const options = await projectFormOptions(project.companyId);

  return (
    <div className="animate-fade-rise">
      <Link href={`/projects/${id}`} className="text-sm text-muted hover:text-text">
        ← {project.code}
      </Link>
      <div className="mt-3 max-w-3xl">
        <ProjectForm options={options} existing={project} />
      </div>
    </div>
  );
}
