import { currentUser } from "@/lib/session";
import { effectivePermissionsFor } from "@/actions/permission";
import { userPermissionOverrides } from "@/actions/access";
import { Card } from "@/components/ui/card";
import { MyAccess } from "@/components/settings/my-access";

/**
 * What you yourself are allowed to do.
 *
 * `permissions.view` defaults to MANAGEMENT alone, so for every SALES, SUPPORT, ACCOUNTS and
 * PURCHASE user the question "what am I allowed to do here?" had no answer anywhere in the product
 * — and the activity log does not help, because a permission change is filed against the person who
 * made it, not the person it was made to. Somebody whose sidebar lost a section after an admin
 * adjusted a role had no way to find out that anything had happened.
 *
 * Read-only, and **no action changed to build it**: `effectivePermissionsFor` and
 * `userPermissionOverrides` each already allow the self case explicitly.
 */
export default async function MyAccessPage() {
  const user = await currentUser();
  if (!user) {
    return <Card className="px-6 py-10 text-center text-sm text-muted">Sign in to see your access.</Card>;
  }

  const [resolved, exceptions] = await Promise.all([
    effectivePermissionsFor(user.id),
    userPermissionOverrides(user.id),
  ]);

  if (!resolved) {
    return <Card className="px-6 py-10 text-center text-sm text-muted">Your account could not be read.</Card>;
  }

  // Lapsed exceptions are not access; `userPermissionOverrides` flags them so neither this page
  // nor the component has to read a clock while rendering.
  return <MyAccess resolved={resolved} exceptions={exceptions.filter((e) => !e.expired)} />;
}
