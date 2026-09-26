import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities } from "@/actions/hr";
import { listDepartmentOptions, listManagerOptions } from "@/actions/department";
import { listCelebrations, upcomingOccasions } from "@/actions/celebration";
import { Card } from "@/components/ui/card";
import { CelebrationsManager } from "@/components/hr/celebrations-manager";

export default async function CelebrationsPage() {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const caps = await hrCapabilities();
  if (!caps.manage) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        Only HR can post celebrations. Birthdays, anniversaries and holidays reach you on their own.
      </Card>
    );
  }

  const [celebrations, upcoming, departments, people] = await Promise.all([
    listCelebrations(),
    upcomingOccasions(),
    listDepartmentOptions(),
    listManagerOptions(),
  ]);

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">Celebrations</h1>
        <p className="mt-1 text-sm text-muted">
          Birthdays, work anniversaries and holidays reach people on their own — they come off the employee records
          and the holiday calendar, so there is nothing to enter here. This page is for what the app can&apos;t know:
          a team hitting a target, a festival greeting in your own words, a welcome for somebody joining.
        </p>
      </div>

      <div className="mt-5">
        <CelebrationsManager
          celebrations={celebrations}
          upcoming={upcoming}
          departments={departments}
          people={people}
        />
      </div>
    </div>
  );
}
