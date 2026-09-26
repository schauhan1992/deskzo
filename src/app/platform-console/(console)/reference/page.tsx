import { consoleRemovePinKey, consoleStartSync } from "@/actions/platform/console";
import { ConsoleAction } from "@/components/console/console-action";
import { PinKeyForm } from "@/components/console/console-forms";
import { Cell, DataTable, PageTitle, Section, StatusBadge, when } from "@/components/console/console-ui";
import { consoleStaff, mayManage } from "@/lib/platform/console-page";
import { readPinDirectory, readWorldPlaces, type SyncStatus } from "@/lib/platform/reference-sync";

function SyncLine({ status, stale, startedAt, finishedAt, progress, message }: { status: SyncStatus; stale: boolean; startedAt: string | null; finishedAt: string | null; progress: string; message: string | null }) {
  return (
    <p className="text-sm text-text">
      <StatusBadge status={stale ? "FAILED" : status} /> {stale ? "It stopped answering — start it again." : status === "RUNNING" ? `Running since ${when(startedAt)} · ${progress}` : finishedAt ? `Last finished ${when(finishedAt)}` : "Never run."}
      {message && <span className="block text-xs text-muted">{message}</span>}
    </p>
  );
}

/**
 * The shared reference database — one copy for every workspace: India's PIN directory and the world's
 * states, cities and postal codes. A sync changes every workspace's address lookups, which is why it is
 * started from here (or the installation's first workspace) and never from a customer's.
 */
export default async function ConsoleReferencePage() {
  const staff = await consoleStaff();
  const [pin, world] = await Promise.all([readPinDirectory(), readWorldPlaces()]);
  const manager = mayManage(staff);
  return (
    <>
      <PageTitle title="Reference data">Shared by every workspace. Never removed by a workspace&apos;s reset.</PageTitle>

      <Section title="India PIN directory">
        <p className="mb-3 text-sm text-text">
          {pin.loaded ? `${pin.loaded.postOffices.toLocaleString("en-IN")} post offices, ${pin.loaded.pincodes.toLocaleString("en-IN")} PIN codes — from ${pin.loaded.source}, ${when(pin.loaded.loadedAt)}.` : "Empty. PIN codes are not filled in anywhere until it is loaded."}
        </p>
        <SyncLine
          status={pin.sync.status}
          stale={pin.sync.stale}
          startedAt={pin.sync.startedAt}
          finishedAt={pin.sync.finishedAt}
          progress={`${pin.sync.fetched.toLocaleString("en-IN")}${pin.sync.total ? ` of ${pin.sync.total.toLocaleString("en-IN")}` : ""} records`}
          message={pin.sync.message}
        />
        {manager && (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-muted">
              The sync reads the directory from data.gov.in, with an API key from there. {pin.sync.hasApiKey ? "A key is saved." : "No key is saved yet."}
            </p>
            <PinKeyForm hasKey={pin.sync.hasApiKey} />
            <div className="flex flex-wrap gap-2">
              {pin.sync.hasApiKey && (pin.sync.status !== "RUNNING" || pin.sync.stale) && <ConsoleAction action={consoleStartSync.bind(null, "pin")} label="Sync now" variant="primary" />}
              {pin.sync.hasApiKey && <ConsoleAction action={consoleRemovePinKey} label="Remove the key" confirm="Remove the saved data.gov.in key? Syncing stops until one is saved again." />}
            </div>
          </div>
        )}
      </Section>

      <Section title="World places (GeoNames)">
        <DataTable head={["Dataset", "Rows", "Source", "Loaded"]} empty="Nothing loaded yet.">
          {world.loaded.map((d) => (
            <tr key={d.key}>
              <Cell className="font-mono text-xs">{d.key}</Cell>
              <Cell>{d.rows.toLocaleString("en-IN")}</Cell>
              <Cell className="text-muted">{d.source}</Cell>
              <Cell className="whitespace-nowrap text-muted">{when(d.loadedAt)}</Cell>
            </tr>
          ))}
        </DataTable>
        <div className="mt-4">
          <SyncLine
            status={world.sync.status}
            stale={world.sync.stale}
            startedAt={world.sync.startedAt}
            finishedAt={world.sync.finishedAt}
            progress={`${world.sync.done}${world.sync.total ? ` of ${world.sync.total}` : ""} files`}
            message={world.sync.message}
          />
        </div>
        {manager && (world.sync.status !== "RUNNING" || world.sync.stale) && (
          <div className="mt-3">
            <ConsoleAction action={consoleStartSync.bind(null, "world")} label="Sync now" confirm="Download the GeoNames files again and reload them? It takes several minutes." />
          </div>
        )}
      </Section>
    </>
  );
}
