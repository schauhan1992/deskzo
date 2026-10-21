import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { employeeFiles, fileManagerPeople, fileManagerViewer, myFiles } from "@/actions/file-manager";
import { FileAccessList, FileBrowser } from "@/components/hr/file-manager";
import { TabNav } from "@/components/ui/tab-nav";
import { Badge, Card } from "@/components/ui/card";
import { personPath } from "@/lib/record-links";

/**
 * People › File manager (owner, 21 Oct 2026). Everybody it's been given to sees their own payslips, letters
 * and documents in folders. An admin or the super admin also has Employees: who may open the file manager,
 * and each person's files with a switch on every one.
 */
export default async function FileManagerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;
  const viewer = await fileManagerViewer();
  if (!viewer.canUse) notFound();

  const query = await searchParams;
  const one = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : "");
  const view = viewer.isAdmin && one("view") === "employees" ? "employees" : "mine";

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">File manager</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        {viewer.isAdmin
          ? "Every employee's salary slips, salary certificates, offer and joining letters, other letters and documents. Give the file manager to whoever should have it, and switch each document on or off for the person it belongs to."
          : "Your salary slips, salary certificates, offer and joining letters, other letters and documents, in one place."}
      </p>

      {viewer.isAdmin && (
        <div className="mt-5">
          <TabNav
            basePath="/people/files"
            paramName="view"
            activeKey={view}
            tabs={[
              { key: "mine", label: "My files" },
              { key: "employees", label: "Employees" },
            ]}
          />
        </div>
      )}

      <div className="mt-5">{view === "mine" ? <MyFiles /> : <Employees personId={one("person")} search={one("q")} />}</div>
    </div>
  );
}

async function MyFiles() {
  const files = await myFiles();
  if (!files) notFound();
  return <FileBrowser files={files} />;
}

async function Employees({ personId, search }: { personId: string; search: string }) {
  const [people, selected] = await Promise.all([fileManagerPeople(search), personId ? employeeFiles(personId) : Promise.resolve(null)]);
  if (!people) notFound();

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[20rem_1fr]">
      <FileAccessList people={people} selectedId={selected?.person.id ?? null} search={search} />
      {selected ? (
        <div className="min-w-0 space-y-4">
          <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <Link href={personPath(selected.person.userSeq)} className="text-sm font-medium text-text hover:underline">
                {selected.person.name}
              </Link>
              <p className="text-xs text-subtle">
                {selected.person.code}
                {selected.person.designation && ` · ${selected.person.designation}`}
              </p>
            </div>
            <Badge tone={selected.person.hasAccess ? "green" : "default"}>
              {selected.person.hasAccess ? "Can open the file manager" : "No file manager yet"}
            </Badge>
          </Card>
          <FileBrowser files={selected.files} manage={{ userId: selected.person.id, name: selected.person.name }} />
        </div>
      ) : (
        <Card className="grid place-items-center px-4 py-16 text-center text-sm text-subtle">Choose somebody to see their files.</Card>
      )}
    </div>
  );
}
