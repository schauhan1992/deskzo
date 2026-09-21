import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getProject, projectFormOptions } from "@/actions/project";
import { listCredentials } from "@/actions/project-credential";
import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import {
  daysLate,
  isClosed,
  milestoneProgress,
  projectHealthLabels,
  projectHealthTone,
  projectStatusLabels,
  projectStatusTone,
} from "@/lib/projects/status";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TabNav } from "@/components/ui/tab-nav";
import { ProjectPlan } from "@/components/projects/project-plan";
import { ProjectPeople } from "@/components/projects/project-people";
import { ProjectLog } from "@/components/projects/project-log";
import { ProjectFiles } from "@/components/projects/project-files";
import { ProjectVault } from "@/components/projects/project-vault";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * One project.
 *
 * `getProject` returns null both for a project that doesn't exist and for one this person isn't on,
 * and both land on `notFound`. Deliberately the same answer: a distinct "you don't have access to
 * this" confirms that PRJ-2026-0041 exists and belongs to somebody, which is exactly the fact a
 * stakeholders-only rule is keeping.
 */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  if (!(await isModuleEnabled("projects"))) return <ModuleDisabledNotice moduleKey="projects" />;

  const [{ id }, { tab }, user] = await Promise.all([params, searchParams, requireUser()]);
  const project = await getProject(id);
  if (!project) notFound();

  const [canManage, canUseCredentials, options] = await Promise.all([
    hasEffectivePermission(user.id, "projects.manage"),
    hasEffectivePermission(user.id, "projects.credentials"),
    projectFormOptions(project.companyId),
  ]);

  // Fetched only when they hold the key, and only for the tab that shows them.
  const credentials = canUseCredentials && tab === "credentials" ? await listCredentials(id) : null;

  // One clock read for the whole render, taken before any JSX. Two reads, or one inside the
  // tree, would let "overdue" and "days late" disagree on a slow render.
  const now = new Date();

  const progress = milestoneProgress(
    project.milestones.map((m) => ({ completedAt: m.completedAt ? new Date(m.completedAt) : null })),
  );
  const late = daysLate(
    {
      targetEndDate: project.targetEndDate ? new Date(project.targetEndDate) : null,
      actualEndDate: project.actualEndDate ? new Date(project.actualEndDate) : null,
      status: project.status,
    },
    now,
  );

  const tabs = [
    { key: "plan", label: "Plan & billing" },
    { key: "people", label: `People (${project.stakeholders.length})` },
    { key: "log", label: `Risks & updates${project.risks.length > 0 ? ` (${project.risks.length})` : ""}` },
    { key: "documents", label: `Documents (${project.documents.length})` },
    // Offered only to people who could actually use it — a tab that always refuses is a tab that
    // teaches people the app is broken.
    ...(canUseCredentials ? [{ key: "credentials", label: "Credentials" }] : []),
  ];
  const active = tabs.some((t) => t.key === tab) ? tab! : tabs[0]!.key;

  return (
    <div className="animate-fade-rise">
      <Link href="/projects" className="text-sm text-muted hover:text-text">
        ← Projects
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-subtle">{project.code}</span>
            <h1 className="text-xl font-semibold text-text">{project.name}</h1>
            <Badge tone={projectStatusTone[project.status]}>{projectStatusLabels[project.status]}</Badge>
            {!isClosed(project.status) && (
              <Badge tone={projectHealthTone[project.health]}>{projectHealthLabels[project.health]}</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link href={`/companies/${project.company.id}`} className="hover:underline">
              {project.company.name}
            </Link>
            {project.type && ` · ${project.type.name}`}
            {project.manager && ` · ${project.manager.name}`}
          </p>
        </div>
        {canManage && (
          <Link href={`/projects/${project.id}/edit`}>
            <Button variant="secondary">
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit
            </Button>
          </Link>
        )}
      </div>

      {project.description && (
        <p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm text-muted">{project.description}</p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        <Stat label="Starts" value={project.startDate ? formatDate(new Date(project.startDate)) : "—"} />
        <Stat
          label="Promised by"
          value={project.targetEndDate ? formatDate(new Date(project.targetEndDate)) : "—"}
          hint={late !== null ? `${late} days late` : undefined}
        />
        <Stat
          label="Progress"
          value={progress.percent === null ? "No plan" : `${progress.percent}%`}
          hint={progress.percent === null ? undefined : `${progress.done} of ${progress.total}`}
        />
        <Stat label="Value" value={project.value != null ? formatCurrency(Number(project.value)) : "—"} />
      </div>

      <div className="mt-5">
        <TabNav tabs={tabs} activeKey={active} basePath={`/projects/${project.id}`} />
      </div>

      <div className="mt-5">
        {active === "plan" && (
          <ProjectPlan
            projectId={project.id}
            milestones={project.milestones}
            billing={project.billingMilestones}
            hasType={!!project.typeId}
            canManage={canManage}
            now={now.getTime()}
          />
        )}
        {active === "people" && (
          <ProjectPeople
            projectId={project.id}
            stakeholders={project.stakeholders}
            users={options.users}
            contacts={options.contacts}
            canManage={canManage}
          />
        )}
        {active === "log" && (
          <ProjectLog
            projectId={project.id}
            risks={project.risks}
            updates={project.updates}
            users={options.users}
            currentHealth={project.health}
            canManage={canManage}
          />
        )}
        {active === "documents" && (
          <ProjectFiles projectId={project.id} documents={project.documents} canManage={canManage} />
        )}
        {active === "credentials" &&
          (credentials?.ok ? (
            <ProjectVault projectId={project.id} credentials={credentials.data} canManage={canManage} />
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted">
                {credentials?.ok === false ? credentials.error : "Credentials aren't available."}
              </CardContent>
            </Card>
          ))}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
        <div className="mt-0.5 text-sm font-medium text-text">{value}</div>
        {hint && <div className="text-xs text-danger">{hint}</div>}
      </CardContent>
    </Card>
  );
}
