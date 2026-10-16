import { redirect } from "next/navigation";
import { rolePath } from "@/lib/staff/staff-paths";

/**
 * Staff & roles is retired: its tabs became pages of their own under Settings › Staff. A saved link —
 * a bookmark, an old notification, an email — lands on the one that replaced its tab:
 *
 * - Staff (and People, its older name) → Users;
 * - Roles & permissions → Roles & Permissions, on the same role and tab; Compare roles → the
 *   permission matrix;
 * - Exceptions and Who can → the permission matrix, where both now sit under the matrix.
 *
 * Each page checks `permissions.view` itself, as this one did.
 */
export default async function RetiredStaffAndRolesPage({ searchParams }: { searchParams: Promise<{ tab?: string; view?: string; role?: string; rtab?: string }> }) {
  const sp = await searchParams;
  if (sp.tab === "roles") {
    if (sp.view === "compare") redirect("/settings/roles/matrix");
    redirect(sp.role ? rolePath(sp.role, sp.rtab) : "/settings/roles");
  }
  if (sp.tab === "exceptions") redirect("/settings/roles/matrix#exceptions");
  if (sp.tab === "who") redirect("/settings/roles/matrix#who-can");
  redirect("/settings/users");
}
