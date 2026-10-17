import { isModuleEnabled } from "@/actions/module";
import { getAutomationConnections } from "@/actions/automate";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ConnectionsManager } from "@/components/automate/connections-manager";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Automate › Connections (Phase 4): the outside apps workflows may call — Slack and Teams channels, and
 * outside APIs with their keys — kept encrypted and never shown again; the workspace's signing secret
 * for the apps that check where a call came from; and the two that ride on something else: Google
 * Sheets on a person's Google mailbox, WhatsApp on Settings › Mail & messaging.
 */
export default async function AutomateConnectionsPage() {
  if (!(await isModuleEnabled("automate"))) return <ModuleDisabledNotice moduleKey="automate" />;

  let data;
  try {
    data = await Promise.all([getAutomationConnections(), workspaceClock()]);
  } catch (err) {
    if (notMigratedYet(err)) {
      return <p className="text-sm text-muted">Connections are being set up for this workspace. Try again in a few minutes.</p>;
    }
    throw err;
  }
  const [page, clock] = data;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Connections</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          The outside apps your workflows talk to. Addresses and keys are kept encrypted and never shown again — to change one, give it anew. A connection is yours; share it and
          everybody&rsquo;s workflows may use it.
        </p>
      </div>
      <ConnectionsManager
        connections={page.connections.map((c) => ({
          id: c.id,
          provider: c.provider,
          name: c.name,
          host: c.host,
          shared: c.sharedWithWorkspace,
          ownerName: c.ownerName,
          mine: c.mine,
          lastUsed: c.lastUsedAt ? clock.dateTimeShort(c.lastUsedAt) : null,
          lastError: c.lastError,
        }))}
        sheets={page.sheets}
        whatsappReady={page.whatsappReady}
      />
    </div>
  );
}
