import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { targetCapabilities, targetsFor } from "@/actions/target";
import { Card } from "@/components/ui/card";
import { TargetCard } from "@/components/targets/target-card";

export default async function MyTargetsPage() {
  const enabled = await isModuleEnabled("targets");
  if (!enabled) return <ModuleDisabledNotice moduleKey="targets" />;

  const caps = await targetCapabilities();
  const targets = await targetsFor(caps.userId);

  const now = new Date();
  const live = targets.filter((t) => new Date(t.toDate) >= now);
  const finished = targets.filter((t) => new Date(t.toDate) < now);

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">My targets</h1>
      <p className="mt-1 text-sm text-muted">
        What you&apos;ve been asked to hit, and where you are. Each one says exactly what counts towards it — open
        &ldquo;what counts&rdquo; if a figure looks wrong, because the answer is usually there.
      </p>

      {live.length === 0 ? (
        <Card className="mt-5 px-6 py-10 text-center text-sm text-subtle">
          Nothing set for you at the moment.
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
          <p className="mt-0.5 text-xs text-muted">
            Kept as they were measured — a review that can&apos;t find the number you were judged on is worse than one
            that can.
          </p>
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
