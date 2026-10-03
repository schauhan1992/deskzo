import Link from "next/link";
import { ArrowLeft, Database } from "lucide-react";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import {
  accessOverview,
  listDevices,
  listIpRules,
  listNetworks,
  listRolePolicies,
  listSignIns,
} from "@/actions/access-control";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { Pagination } from "@/components/ui/pagination";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { OutboundLink } from "@/components/ui/outbound-link";
import { RolePolicies } from "@/components/access/role-policies";
import { IpRules } from "@/components/access/ip-rules";
import { NetworkReview } from "@/components/access/network-review";
import { DeviceQueue } from "@/components/access/device-queue";
import { SignInTable } from "@/components/access/sign-in-table";
import { GeoDatabaseUpload } from "@/components/access/geo-database";
import { mayManageSharedData } from "@/lib/platform/shared-data";
import { DEVICE_KIND_LABEL } from "@/lib/access/device";
import { GEO_ATTRIBUTION, placeText } from "@/lib/access/geo";
import { normaliseIp } from "@/lib/access/ip";
import { requestFacts } from "@/lib/access/request";
import { workspaceClock } from "@/lib/time/workspace";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";

type Params = { tab?: string; page?: string; pageSize?: string; q?: string; status?: string; view?: string; flag?: string; userId?: string };

/**
 * Devices, networks and sign-ins. One page, three permissions: `security.manage` writes the rules and
 * reviews networks, `access.approveDevices` works the device queue, `access.viewSignIns` sees where
 * people signed in. Each tab appears only to somebody its own action would answer.
 */
export default async function AccessControlPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await currentUser();
  const [manage, approve, view] = user
    ? await Promise.all([can(user.id, "security.manage"), can(user.id, "access.approveDevices"), can(user.id, "access.viewSignIns")])
    : [false, false, false];
  if (!user || (!manage && !approve && !view)) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Devices, networks & sign-ins</h1>
        <p className="mt-2 text-sm text-muted">You need permission to manage security, approve devices, or see sign-ins.</p>
      </div>
    );
  }

  const params = await searchParams;
  const overview = await accessOverview();
  const tabs = [
    ...(manage ? [{ key: "rules", label: "Rules" }] : []),
    ...(manage ? [{ key: "networks", label: `Networks${overview?.reviewNetworks ? ` (${overview.reviewNetworks})` : ""}` }] : []),
    ...(approve || manage ? [{ key: "devices", label: `Devices${overview?.pendingDevices ? ` (${overview.pendingDevices})` : ""}` }] : []),
    ...(view ? [{ key: "sign-ins", label: "Sign-ins" }] : []),
  ];
  const tab = tabs.some((t) => t.key === params.tab) ? params.tab! : tabs[0]!.key;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);

  return (
    <div>
      <Link href="/settings/security" className="inline-flex items-center gap-1 text-xs text-muted hover:text-text">
        <ArrowLeft className="h-3.5 w-3.5" /> Security & data protection
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-text">Devices, networks & sign-ins</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Who may sign in, on what, and from where — checked on every request, not only at sign-in, so approving, revoking or
        ending something takes effect within seconds. The super admin is never held: they are the way back in if a rule locks
        everybody else out.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Devices waiting" value={overview?.pendingDevices ?? 0} />
        {manage && <Stat label="Networks to review" value={overview?.reviewNetworks ?? 0} />}
        {view && <Stat label="Sign-ins, last 24 h" value={overview?.signInsToday ?? 0} />}
        {view && <Stat label="Flagged, last 24 h" value={overview?.flaggedToday ?? 0} />}
      </div>

      <div className="mt-5">
        <TabNav tabs={tabs} activeKey={tab} basePath="/settings/security/access" />
      </div>

      <div className="mt-4 space-y-4">
        {tab === "rules" && manage && <RulesTab geo={overview?.geo ?? null} />}
        {tab === "networks" && manage && <NetworksTab params={params} page={page} pageSize={pageSize} />}
        {tab === "devices" && (approve || manage) && <DevicesTab params={params} page={page} pageSize={pageSize} canDecide={approve} />}
        {tab === "sign-ins" && view && <SignInsTab params={params} page={page} pageSize={pageSize} />}
      </div>
    </div>
  );
}

async function RulesTab({ geo }: { geo: { installed: boolean; file: string | null; type: string | null; builtAt: string | Date | null; sizeBytes: number | null; directory: string } | null }) {
  const [policies, rules, roles, facts, manageShared, clock] = await Promise.all([
    listRolePolicies(),
    listIpRules(),
    db.role.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } }),
    requestFacts(),
    // The location file is the whole server's, not this workspace's (src/lib/platform/shared-data.ts).
    mayManageSharedData(),
    workspaceClock(),
  ]);
  return (
    <>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-text">By role</h2>
        {policies && <RolePolicies rows={policies} />}
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-text">Networks</h2>
        {rules && (
          <IpRules
            roles={roles}
            currentIp={normaliseIp(facts.ip)}
            rules={rules}
          />
        )}
      </section>
      {geo && (
        <Card>
          <CardHeader className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted" aria-hidden />
            <h2 className="text-sm font-semibold text-text">Location database</h2>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {geo.installed ? (
              <p className="text-text">
                {geo.type} · built {geo.builtAt ? clock.dateTime(geo.builtAt) : "—"} · {Math.round((geo.sizeBytes ?? 0) / 1048576)} MB
              </p>
            ) : (
              <p className="text-warning">
                No location database is installed, so sign-ins are recorded without a place.
                {manageShared && (
                  <>
                    {" "}
                    Put a .mmdb city file in <span className="font-mono">{geo.directory}</span>, or upload one here.
                  </>
                )}
              </p>
            )}
            <p className="text-xs text-subtle">
              Looked up on this server — no address is ever sent anywhere. City-level and approximate: mobile data often shows the
              operator&apos;s hub city, and a VPN shows wherever its server is. A new free file is published at the start of each
              month; upload it to keep places current.{" "}
              <OutboundLink href={GEO_ATTRIBUTION.url} className="text-brand hover:underline">
                {GEO_ATTRIBUTION.text}
              </OutboundLink>
              .
            </p>
            {manageShared ? (
              <GeoDatabaseUpload />
            ) : (
              <p className="text-xs text-subtle">The location database is shared by every workspace on this server and kept current by the platform.</p>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}

async function NetworksTab({ params, page, pageSize }: { params: Params; page: number; pageSize: number }) {
  const [data, clock] = await Promise.all([listNetworks({ view: params.view, q: params.q, page, pageSize }), workspaceClock()]);
  if (!data) return null;
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <SearchParamInput paramName="q" placeholder="Search address, place or person…" className="w-full sm:w-72" />
        <SelectParamFilter paramName="view" label="Show" allLabel="To review" options={[{ value: "all", label: "Every address seen" }]} />
      </div>
      <NetworkReview
        rows={data.rows.map((r) => ({
          ip: r.ip,
          place: placeText(r),
          isPrivate: r.isPrivate,
          standing: r.standing,
          rule: r.rule,
          lastUserName: r.lastUserName,
          firstSeenText: clock.dateTime(r.firstSeenAt),
          lastSeenText: clock.dateTime(r.lastSeenAt),
          held: r.heldAt !== null,
          alerted: r.alertedAt !== null,
          dismissed: r.dismissedAt !== null,
        }))}
      />
      <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={totalPages(data.total, pageSize)} pageSizes={PAGE_SIZES} label="addresses" />
    </>
  );
}

async function DevicesTab({ params, page, pageSize, canDecide }: { params: Params; page: number; pageSize: number; canDecide: boolean }) {
  const [data, clock] = await Promise.all([listDevices({ status: params.status ?? "PENDING", q: params.q, page, pageSize }), workspaceClock()]);
  if (!data) return null;
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <SearchParamInput paramName="q" placeholder="Search person, device or place…" className="w-full sm:w-72" />
        <SelectParamFilter
          paramName="status"
          label="Status"
          allLabel="Waiting for approval"
          options={[
            { value: "APPROVED", label: "Approved" },
            { value: "auto", label: "Allowed automatically" },
            { value: "REJECTED", label: "Rejected" },
            { value: "REVOKED", label: "Revoked" },
            { value: "all", label: "Every device" },
          ]}
        />
      </div>
      <DeviceQueue
        canDecide={canDecide}
        rows={data.rows.map((d) => ({
          id: d.id,
          kind: d.kind,
          label: d.label,
          status: d.status,
          auto: d.status === "APPROVED" && d.decidedBy === null,
          firstSeenText: clock.dateTime(d.firstSeenAt),
          lastSeenText: clock.dateTime(d.lastSeenAt),
          lastIp: d.lastIp,
          lastPlace: d.lastPlace,
          decisionNote: d.decisionNote,
          decidedBy: d.decidedBy?.name ?? null,
          user: d.user,
          mine: d.user.id === data.me,
        }))}
      />
      <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={totalPages(data.total, pageSize)} pageSizes={PAGE_SIZES} label="devices" />
    </>
  );
}

async function SignInsTab({ params, page, pageSize }: { params: Params; page: number; pageSize: number }) {
  const [data, clock] = await Promise.all([listSignIns({ q: params.q, flag: params.flag, userId: params.userId, page, pageSize }), workspaceClock()]);
  if (!data) return null;
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <SearchParamInput paramName="q" placeholder="Search person, address or city…" className="w-full sm:w-72" />
        <SelectParamFilter
          paramName="flag"
          label="Show"
          options={[
            { value: "flagged", label: "Anything unusual" },
            { value: "IMPOSSIBLE_TRAVEL", label: "Impossible travel" },
            { value: "NEW_NETWORK", label: "New network" },
            { value: "NEW_DEVICE", label: "New device" },
          ]}
        />
      </div>
      <SignInTable
        canEnd={data.canEnd}
        rows={data.rows.map((s) => ({
          id: s.id,
          atText: clock.dateTime(s.at),
          lastSeenText: clock.dateTime(s.lastSeenAt),
          user: s.user,
          ip: s.ip,
          place: placeText(s),
          deviceLabel: s.device?.label ?? null,
          deviceKindLabel: s.deviceKind ? DEVICE_KIND_LABEL[s.deviceKind] : null,
          provider: s.provider,
          gps: s.gpsLatitude !== null && s.gpsLongitude !== null ? { lat: Number(s.gpsLatitude), lng: Number(s.gpsLongitude), accuracyM: s.gpsAccuracyM } : null,
          flags: s.flags,
          ended: s.endedAt ? `Ended${s.endedBy ? ` by ${s.endedBy.name}` : ""}` : null,
          active: s.active,
        }))}
      />
      <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={totalPages(data.total, pageSize)} pageSizes={PAGE_SIZES} label="sign-ins" />
      <p className="text-[11px] text-subtle">
        Network locations are approximate and city-level.{" "}
        <OutboundLink href={GEO_ATTRIBUTION.url} className="underline">
          {GEO_ATTRIBUTION.text}
        </OutboundLink>
        .
      </p>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="px-3.5 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-text">{value}</div>
    </Card>
  );
}
