import { redirect } from "next/navigation";
import { userPath } from "@/lib/staff/staff-paths";

/**
 * One person's access page is retired: the person opens under Users, on the same tab (the tab keys are
 * unchanged). Kept so a saved link — a notification, a bookmark — still lands on them. Users checks
 * `permissions.view` itself, as this page did.
 */
export default async function RetiredPersonAccessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  redirect(userPath(id, sp.tab && sp.tab !== "permissions" ? sp.tab : undefined));
}
