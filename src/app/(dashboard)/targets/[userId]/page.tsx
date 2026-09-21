import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { targetCapabilities, targetsFor } from "@/actions/target";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { TargetCard } from "@/components/targets/target-card";

export default async function PersonTargetsPage({ params }: { params: Promise<{ userId: string }> }) {
  const enabled = await isModuleEnabled("targets");
  if (!enabled) return <ModuleDisabledNotice moduleKey="targets" />;

  const { userId } = await params;
  const [targets, caps, person] = await Promise.all([
    targetsFor(userId),
    targetCapabilities(),
    db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true, department: { select: { name: true } } },
    }),
  ]);
  if (!person) notFound();

  // targetsFor returns nothing for somebody out of view, which is also the answer here.
  if (targets.length === 0 && !caps.viewAll && caps.userId !== userId) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        You can see your own targets and those of people who report to you.
      </Card>
    );
  }

  const now = new Date();
  const live = targets.filter((t) => new Date(t.toDate) >= now);
  const finished = targets.filter((t) => new Date(t.toDate) < now);

  return (
    <div className="animate-fade-rise">
      <Link href="/targets" className="text-sm text-muted hover:text-text">
        ← Targets
      </Link>
      <h1 className="mt-1 text-xl font-semibold text-text">{person.name}</h1>
      <p className="mt-0.5 text-sm text-muted">
        {person.department?.name ?? person.role}
      </p>

      {live.length === 0 ? (
        <Card className="mt-5 px-6 py-10 text-center text-sm text-subtle">
          Nothing set for them at the moment.
        </Card>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {live.map((t) => (
            <TargetCard key={t.id} target={t} />
          ))}
        </div>
      )}

      {finished.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-medium text-text">Finished</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {finished.map((t) => (
              <TargetCard key={t.id} target={t} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
