import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { listDepartments } from "@/actions/department";
import { Card, CardContent } from "@/components/ui/card";
import { DepartmentsManager } from "@/components/settings/departments-manager";

export const metadata = { title: "Departments" };

/**
 * Settings › Staff › Departments — what sat under the Staff table before Users had a page of its own.
 * Opened with `permissions.view`, as Users is; adding, renaming and removing one take `users.manage`,
 * which the department actions check (src/actions/department.ts).
 */
export default async function DepartmentsPage() {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  const departments = await listDepartments();
  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Departments</h1>
        {/* Said plainly, because the picker sits beside role and manager and looks like one of them. */}
        <p className="mt-1 max-w-3xl text-sm text-muted">How people are grouped. Grouping only — a department carries no permissions of its own.</p>
      </div>
      <Card className="max-w-3xl">
        <CardContent>
          <DepartmentsManager departments={departments} />
        </CardContent>
      </Card>
    </div>
  );
}
