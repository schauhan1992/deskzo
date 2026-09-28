import type { ReactNode } from "react";
import { Database, LoaderCircle } from "lucide-react";
import { Meter } from "@/components/console/charts/meter";
import { Banner } from "@/components/console/kit/banner";
import { DefinitionList, InsetBlock, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { when } from "@/lib/console-shared/format";
import { SYNC_STATUS } from "@/lib/console-shared/labels";
import { redactSecrets } from "@/lib/console-shared/redact";
import type { Caps } from "@/lib/console-shared/roles";
import type { PinDirectory, SyncStatus, WorldPlaces } from "@/lib/platform/reference-sync";
import { PinKeyButtons, SyncButton } from "./reference-actions";

/**
 * The two dataset cards of the Reference data page (spec §3.15): India's PIN directory and the
 * GeoNames world places, each with its sync's state, what is loaded, and — while a sync runs — how far
 * it has got. The page refreshes itself every five seconds while one runs (see the page).
 *
 * Server components: the only interactive parts are the managers' buttons (reference-actions.tsx),
 * which are not drawn for anybody else.
 */

type Sync = { status: SyncStatus; stale: boolean; startedAt: string | null; finishedAt: string | null; message: string | null };
type SyncKey = keyof typeof SYNC_STATUS;

/** The GeoNames datasets a world sync loads, in the order they are shown, with the names people use. */
const WORLD_DATASETS: { key: string; label: string }[] = [
  { key: "geonames-states", label: "States and provinces" },
  { key: "geonames-cities", label: "Cities" },
  { key: "geonames-postal", label: "Postal codes" },
];

const num = (n: number) => n.toLocaleString("en-IN");

/** A RUNNING row whose worker went quiet reads as stale, whatever it last said; IDLE has never run. */
function syncKey(sync: Sync): SyncKey {
  if (sync.stale) return "stale";
  if (sync.status === "IDLE") return "never";
  return sync.status;
}

/** Running, and still reporting — the state in which the page polls and the progress shows. */
export function isSyncing(sync: Sync): boolean {
  return sync.status === "RUNNING" && !sync.stale;
}

function SyncPill({ sync }: { sync: Sync }) {
  const key = syncKey(sync);
  // A status written by a newer worker shows as itself rather than failing the page.
  const entry = SYNC_STATUS[key] ?? { label: String(sync.status), tone: "neutral" as const };
  return (
    <StatusPill tone={entry.tone} icon={key === "RUNNING" ? <LoaderCircle className="h-3 w-3 animate-spin" /> : undefined}>
      {entry.label}
    </StatusPill>
  );
}

/** The headline figures of a loaded dataset. */
function Stats({ items }: { items: { label: string; value: string; note?: string }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-4">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs font-medium text-muted">{item.label}</dt>
          <dd className="mt-1 text-2xl font-semibold tracking-tight break-words text-text tabular-nums">{item.value}</dd>
          {item.note && <dd className="mt-0.5 text-xs text-muted">{item.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Nothing loaded yet — said plainly, with the next step for whoever can take it. */
function NotLoaded({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed border-line-strong px-4 py-3">
      <span aria-hidden="true" className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-sunken text-subtle">
        <Database className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-text">{title}</p>
        <p className="mt-0.5 text-xs text-muted">{children}</p>
      </div>
    </div>
  );
}

/**
 * A running sync: what the worker last said, when it started, and how far it has got. Before the
 * worker knows the total there is nothing to measure against, so it counts instead of drawing a bar.
 */
function Progress({ sync, done, total, unit, label }: { sync: Sync; done: number; total: number | null; unit: string; label: string }) {
  return (
    <InsetBlock className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-info">
          <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span className="break-words">{redactSecrets(sync.message) ?? "Running"}</span>
        </span>
        {sync.startedAt && (
          <span className="text-muted">
            Started <RelativeTime at={sync.startedAt} />
          </span>
        )}
      </div>
      {total && total > 0 ? (
        <Meter value={done} max={total} label={label} tone="brand" showText />
      ) : (
        <p className="text-xs text-muted tabular-nums">{done > 0 ? `${num(done)} ${unit} so far` : "Waiting for the first figures…"}</p>
      )}
    </InsetBlock>
  );
}

/**
 * What went wrong, or what the last run said. A stale run is a worker that died mid-way (no word for
 * 30 minutes); a failed one says why in its own message.
 */
function Outcome({ sync, caps }: { sync: Sync; caps: Caps }) {
  if (sync.stale) {
    return (
      <Banner tone="warning" title="The sync stopped answering">
        {`It started ${when(sync.startedAt)} and has not finished in 30 minutes. `}
        {caps.manage ? "Sync now starts it again." : "A manager can start it again."}
      </Banner>
    );
  }
  if (sync.status === "FAILED") {
    return (
      <Banner tone="danger" title="The last sync failed">
        {redactSecrets(sync.message) ?? "No reason was recorded."}
        {sync.finishedAt && <span className="mt-1 block text-xs">{`Stopped ${when(sync.finishedAt)}. What was loaded before is still in use.`}</span>}
      </Banner>
    );
  }
  return null;
}

/** When the last sync finished — or that one is running, or has never run. */
function lastSync(sync: Sync): ReactNode {
  if (isSyncing(sync)) return "Running now";
  if (sync.finishedAt) return <RelativeTime at={sync.finishedAt} />;
  return <span className="text-muted">Never</span>;
}

/** The last message of a run that is neither running nor failed ("Loaded 1,65,627 post offices…"). */
function quietMessage(sync: Sync): string | null {
  if (isSyncing(sync) || sync.stale || sync.status === "FAILED") return null;
  return redactSecrets(sync.message);
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function PinDirectoryCard({ pin, caps }: { pin: PinDirectory; caps: Caps }) {
  const { loaded, sync } = pin;
  const running = isSyncing(sync);
  const message = quietMessage(sync);
  const syncBlocked = running ? "A sync is running — it finishes on its own." : !sync.hasApiKey ? "Save an API key first" : undefined;

  const details: { term: string; value: ReactNode; wide?: boolean }[] = [
    { term: "Source", value: loaded ? loaded.source : <span className="text-muted">—</span> },
    { term: "Loaded", value: loaded ? <RelativeTime at={loaded.loadedAt} /> : <span className="text-muted">Not yet</span> },
    { term: "Last sync", value: lastSync(sync) },
    {
      term: "API key",
      value: <StatusPill tone={sync.hasApiKey ? "success" : "warning"}>{sync.hasApiKey ? "Set" : "Not set"}</StatusPill>,
    },
  ];
  if (message) details.push({ term: "Last message", value: message, wide: true });

  return (
    <Panel
      title="India PIN directory"
      description="India Post's post offices and PIN codes, from data.gov.in"
      actions={<SyncPill sync={sync} />}
      padded={false}
      footer={
        caps.manage ? (
          <Footer>
            <SyncButton which="pin" disabledReason={syncBlocked} />
            <PinKeyButtons hasKey={sync.hasApiKey} />
          </Footer>
        ) : undefined
      }
    >
      <div className="space-y-4 px-5 py-4">
        {loaded ? (
          <Stats
            items={[
              { label: "Post offices", value: num(loaded.postOffices) },
              { label: "PIN codes", value: num(loaded.pincodes) },
            ]}
          />
        ) : (
          !running && (
            <NotLoaded title="Not loaded yet">
              Typing a PIN code fills in nothing, in any workspace, until the directory is loaded.
              {caps.manage && (sync.hasApiKey ? " Sync now to load it." : " Add a data.gov.in key, then sync.")}
            </NotLoaded>
          )
        )}
        {running && <Progress sync={sync} done={sync.fetched} total={sync.total} unit="post offices fetched" label="Post offices fetched" />}
        <Outcome sync={sync} caps={caps} />
      </div>

      <div className="border-t border-line px-5 py-4">
        <DefinitionList items={details} />
      </div>
    </Panel>
  );
}

export function WorldPlacesCard({ world, caps }: { world: WorldPlaces; caps: Caps }) {
  const { loaded, sync } = world;
  const running = isSyncing(sync);
  const message = quietMessage(sync);
  const byKey = new Map(loaded.map((d) => [d.key, d]));
  // The three known datasets first, then anything a newer worker loads that this page has no name for.
  const rows = [
    ...WORLD_DATASETS.map((d) => ({ key: d.key, label: d.label, data: byKey.get(d.key) ?? null })),
    ...loaded.filter((d) => !WORLD_DATASETS.some((w) => w.key === d.key)).map((d) => ({ key: d.key, label: d.key, data: d })),
  ];
  const loadedCount = rows.filter((r) => r.data).length;
  const totalRows = loaded.reduce((sum, d) => sum + d.rows, 0);

  const details: { term: string; value: ReactNode; wide?: boolean }[] = [
    { term: "Source", value: "GeoNames (geonames.org)" },
    { term: "Last sync", value: lastSync(sync) },
  ];
  if (message) details.push({ term: "Last message", value: message, wide: true });

  return (
    <Panel
      title="World places"
      description="States, cities and postal codes for every country, from GeoNames"
      actions={<SyncPill sync={sync} />}
      padded={false}
      footer={
        caps.manage ? (
          <Footer>
            <SyncButton which="world" disabledReason={running ? "A sync is running — it finishes on its own." : undefined} />
          </Footer>
        ) : undefined
      }
    >
      <div className="space-y-4 px-5 py-4">
        {loadedCount > 0 ? (
          <Stats
            items={[
              { label: "Rows loaded", value: num(totalRows) },
              { label: "Datasets", value: `${loadedCount} of ${rows.length}`, note: loadedCount < rows.length ? "Some are not loaded yet" : undefined },
            ]}
          />
        ) : (
          !running && (
            <NotLoaded title="Not loaded yet">
              Addresses outside India get no state, city or postal code lookups until these are loaded.
              {caps.manage && " Sync now to download them."}
            </NotLoaded>
          )
        )}
        {running && <Progress sync={sync} done={sync.done} total={sync.total} unit="files done" label="Files downloaded and loaded" />}
        <Outcome sync={sync} caps={caps} />
      </div>

      {loadedCount > 0 && (
        <div className="border-t border-line">
          <DataTable caption="World datasets" minWidth={440}>
            <THead>
              <Th>Dataset</Th>
              <Th numeric>Rows</Th>
              <Th>Source</Th>
              <Th>Loaded</Th>
            </THead>
            <TBody>
              {rows.map((row) => (
                <Tr key={row.key}>
                  <Td className="font-medium">{row.label}</Td>
                  <Td numeric muted={!row.data}>
                    {row.data ? num(row.data.rows) : "—"}
                  </Td>
                  <Td muted>
                    {row.data ? (
                      <span className="block max-w-[14rem] truncate" title={row.data.source}>
                        {row.data.source}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td nowrap muted>
                    {row.data ? <RelativeTime at={row.data.loadedAt} /> : "Not loaded"}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        </div>
      )}

      <div className="border-t border-line px-5 py-4">
        <DefinitionList items={details} />
      </div>
    </Panel>
  );
}
