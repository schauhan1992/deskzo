import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listInvites } from "@/actions/visitor";
import { hasEffectivePermission } from "@/actions/permission";
import { getOrganisation } from "@/lib/organisation";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { ExpectedVisitors } from "@/components/visitors/expected-visitors";

/**
 * Who is expected.
 *
 * Not gated on `visitors.view`: inviting somebody to come and see you is not the same as reading
 * the building's visitor book, and requiring the second to do the first would mean nobody used it.
 * Without that permission the list is your own invitations; with it, it's the whole front desk's.
 */
export default async function ExpectedPage() {
  if (!(await isModuleEnabled("visitors"))) return <ModuleDisabledNotice moduleKey="visitors" />;

  const user = await requireUser();
  const [invites, canSeeAll, org, people] = await Promise.all([
    listInvites(),
    hasEffectivePermission(user.id, "visitors.view"),
    getOrganisation(),
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <div className="animate-fade-rise">
      <Link href="/visitors" className="text-sm text-muted hover:text-text">
        ← Visitors
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-text">Expected visitors</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Invite somebody in advance and they get a code to type at reception — no form to fill in on the day.
      </p>
      <div className="mt-5">
        <ExpectedVisitors
          invites={invites}
          people={people}
          myUserId={user.id}
          companyName={org.tradeName || org.legalName || "our office"}
          canSeeAll={canSeeAll}
        />
      </div>
    </div>
  );
}
