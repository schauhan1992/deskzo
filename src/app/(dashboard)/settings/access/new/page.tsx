import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ADMIN_ROLE } from "@/lib/roles";
import { listRoles } from "@/lib/authz/role-registry";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { listDepartments } from "@/actions/department";
import { listUsers } from "@/actions/user";
import { isMultiBranch, listBranchChoices } from "@/lib/branches/identity";
import { linkedSignInEnabled } from "@/lib/platform/linked/groups";
import { currentTenant } from "@/lib/tenancy/resolve";
import { AddStaffForm } from "@/components/settings/staff/add-staff-form";

export const metadata = { title: "Add staff" };

/**
 * Add staff — Staff & roles' "+ Add staff", as a page (the reference's "Add a staff account"), with
 * room for its two-column form.
 *
 * Open to whoever may create accounts (`users.manage`, the key `createUser` checks) and may open
 * Staff & roles at all (`permissions.view`, its catalogue key). The reporting manager is offered only
 * to somebody who may set one (`permissions.manage` — a reporting line hands the reports' permissions
 * to the manager), and "Works at" only where there is more than one branch.
 *
 * Admin is never offered as a starting role, as before: making an admin is `users.assignRole`'s
 * business, done afterwards from the person's row by a super admin.
 */
export default async function AddStaffPage() {
  const sessionUser = await currentUser();
  const allowed =
    sessionUser !== null &&
    (await can(sessionUser.id, "permissions.view")) &&
    (await can(sessionUser.id, "users.manage"));

  if (!sessionUser || !allowed) {
    return (
      <div className="max-w-md">
        <BackLink />
        <h1 className="mt-1 text-xl font-semibold text-text">Add a staff account</h1>
        <p className="mt-2 text-sm text-muted">You can&apos;t add staff. Somebody who can create accounts can do it for you.</p>
      </div>
    );
  }

  const [roles, departments, users, mayManage, multiBranch] = await Promise.all([
    listRoles(),
    listDepartments(),
    listUsers(),
    can(sessionUser.id, "permissions.manage"),
    isMultiBranch(),
  ]);
  const branches = multiBranch ? await listBranchChoices() : null;
  // The one-step invite (set up here, and link it to the workspace they already use) only where linking
  // can happen: a workspace in the control plane, with linked sign-in not paused.
  const offerLinking = (await currentTenant()).source === "control" && (await linkedSignInEnabled());

  return (
    <div className="max-w-4xl animate-fade-rise">
      <BackLink />
      <h1 className="mt-1 text-xl font-semibold text-text">Add a staff account</h1>
      <p className="mt-1 text-sm text-muted">
        They&apos;ll get an email with a link to choose their own password, and can sign in as soon as they have.
      </p>

      <div className="mt-5">
        <AddStaffForm
          roles={roles.filter((r) => r.key !== ADMIN_ROLE).map((r) => ({ key: r.key, name: r.name }))}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
          managers={mayManage ? users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })) : null}
          branches={
            branches?.map((b) => ({ id: b.id, name: b.name, code: b.code, isHeadOffice: b.isHeadOffice, active: b.active })) ??
            null
          }
          offerLinking={offerLinking}
        />
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/settings/access" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      Staff &amp; roles
    </Link>
  );
}
