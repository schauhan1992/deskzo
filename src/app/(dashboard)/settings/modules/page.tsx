import { getModuleStates } from "@/actions/module";
import { SettingsPage } from "@/components/settings/settings-page";
import { ModuleToggle } from "@/components/settings/module-toggle";
import { Badge, Card, CardContent } from "@/components/ui/card";

export default async function Page() {
  const modules = await getModuleStates();

  return (
    <SettingsPage
      title="Modules"
      description="Which parts of the app exist for this company. Switching one off hides its pages and its place in the sidebar; the data stays where it is, so switching it back on loses nothing. Modules outside your plan are listed at the end."
      settingsKey="modules"
    >
      <Card>
        <CardContent className="divide-y divide-line">
          {[...modules.filter((m) => m.entitled), ...modules.filter((m) => !m.entitled)].map((m) => (
            <div key={m.key} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">{m.label}</span>
                  {m.core && <Badge tone="blue">Core — always on</Badge>}
                  {!m.entitled && <Badge>Not in your plan</Badge>}
                </div>
                <p className="mt-0.5 max-w-2xl text-sm text-muted">{m.description}</p>
              </div>
              {!m.entitled ? (
                /* Nothing to switch: the plan decides, not this page. */
                <div className="h-6 w-11 shrink-0 rounded-full bg-surface-sunken" />
              ) : m.core ? (
                /* Not a disabled switch: a control you cannot move should not look like one you could. */
                <div className="h-6 w-11 shrink-0 rounded-full bg-brand opacity-50" />
              ) : (
                <ModuleToggle moduleKey={m.key} enabled={m.enabled} />
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </SettingsPage>
  );
}
