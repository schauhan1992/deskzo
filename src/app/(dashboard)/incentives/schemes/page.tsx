import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { incentiveCapabilities, listSchemes } from "@/actions/incentive";
import { Card } from "@/components/ui/card";
import { SchemeManager } from "@/components/incentives/scheme-manager";

export default async function SchemesPage() {
  const enabled = await isModuleEnabled("incentives");
  if (!enabled) return <ModuleDisabledNotice moduleKey="incentives" />;

  const caps = await incentiveCapabilities();
  if (!caps.manage) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        Incentive schemes sit behind their own permission.
      </Card>
    );
  }

  const schemes = await listSchemes();

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">Incentive schemes</h1>
        <p className="mt-1 text-sm text-muted">
          What hitting a target is worth. A scheme is attached to a target, which already knows who carries it and
          over what period — so the scheme only has to say the rules. The form works out what each one would actually
          pay as you write it, before anybody is put on it.
        </p>
      </div>
      <div className="mt-5">
        <SchemeManager schemes={schemes} />
      </div>
    </div>
  );
}
