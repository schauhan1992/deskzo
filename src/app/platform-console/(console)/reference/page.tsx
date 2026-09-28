import type { Metadata } from "next";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { PinDirectoryCard, WorldPlacesCard, isSyncing } from "@/components/console/reference/dataset-card";
import { plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { readPinDirectory, readWorldPlaces } from "@/lib/platform/reference-sync";

export const metadata: Metadata = { title: "Reference data" };

/** How often the page reads the sync rows again while a worker is writing its progress to them. */
const REFRESH_SECONDS = 5;

/**
 * Reference data (spec §3.15): the shared reference database — one copy for every workspace — with
 * India's PIN directory and the world's states, cities and postal codes. A sync changes every
 * workspace's address lookups, which is why it is started from here (managers only) and never from a
 * customer's workspace. Nothing on this page deletes reference data, and a workspace's reset never
 * touches it.
 *
 * `?sync=pin|world` (the command palette's "Sync PIN directory") opens that dataset's confirmation;
 * the button reads it itself, so the page takes no params.
 */
export default async function ConsoleReferencePage() {
  const staff = await consoleStaff(PAGE_ROLES.reference);
  const caps = capsFor(staff.role);
  const [pin, world] = await Promise.all([readPinDirectory(), readWorldPlaces()]);

  // One poll for the page, however many syncs run: each card would otherwise start its own.
  const running = isSyncing(pin.sync) || isSyncing(world.sync);
  const unresolved = Object.entries(pin.loaded?.unresolvedStates ?? {})
    .filter(([, n]) => typeof n === "number" && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return (
    <>
      <PageHeader
        title="Reference data"
        subtitle="Shared by every workspace. A workspace's reset never removes it."
        autoRefreshSeconds={running ? REFRESH_SECONDS : undefined}
        live={running}
      />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-6">
          <PinDirectoryCard pin={pin} caps={caps} />
          {unresolved.length > 0 && <UnresolvedStates rows={unresolved} />}
        </div>
        <WorldPlacesCard world={world} caps={caps} />
      </div>
    </>
  );
}

/**
 * State names in the PIN directory that resolved to no GST state code (India Post spells a few its
 * own way). A PIN under one of them does not fill in a state.
 */
function UnresolvedStates({ rows }: { rows: [string, number][] }) {
  const offices = rows.reduce((sum, [, n]) => sum + n, 0);
  return (
    <Panel
      title="Unresolved state names"
      description={`${plural(rows.length, "name")} in the PIN directory match no state — ${plural(offices, "post office")} under them don't fill in a state.`}
      padded={false}
    >
      <DataTable caption="Unresolved state names" minWidth={320}>
        <THead>
          <Th>Name in the directory</Th>
          <Th numeric>Post offices</Th>
        </THead>
        <TBody>
          {rows.map(([name, n]) => (
            <Tr key={name}>
              <Td>{name}</Td>
              <Td numeric>{n.toLocaleString("en-IN")}</Td>
            </Tr>
          ))}
        </TBody>
      </DataTable>
    </Panel>
  );
}
