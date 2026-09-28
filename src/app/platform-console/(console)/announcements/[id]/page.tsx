import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Archive, CircleStop, CopyPlus, X } from "lucide-react";
import { consoleArchiveAnnouncement, consoleEndAnnouncement } from "@/actions/platform/console-announcements";
import { AnnouncementEditor } from "@/components/console/announcements/announcement-editor";
import { ActionButton } from "@/components/console/kit/action-button";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { LabelPill } from "@/components/console/kit/status";
import { AnnouncementBanner } from "@/components/platform/announcement-banner";
import { plural, when } from "@/lib/console-shared/format";
import { ANNOUNCEMENT_STATE, ANNOUNCEMENT_TONE } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { announcementById, announcementTargets, type AnnouncementListRow, type AnnouncementRow, type AnnouncementTargets } from "@/lib/platform/announcements";
import { consoleStaff } from "@/lib/platform/console-page";

/** The address holds an id, not a name, so the title says what the page is and nothing more. */
export const metadata: Metadata = { title: "Announcement" };

const SECONDARY_LINK =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium whitespace-nowrap text-text shadow-sm hover:bg-surface-sunken";

/** At most this many chosen workspaces or plans are listed on the read-only view; the rest are counted. */
const LISTED_MAX = 24;

/**
 * One announcement (spec §3.8). Owners and admins edit it in place — the same editor as a new one —
 * and end, archive or duplicate it from the header. Everybody else, and an archived announcement,
 * gets a read-only view: what it says as workspaces see it, who it is for and when it shows.
 *
 * Only an owner may save an announcement to every workspace, so an admin opening one gets the
 * read-only view too, with end, archive and duplicate still in reach.
 */
export default async function ConsoleAnnouncementPage({ params }: PageProps<"/platform-console/announcements/[id]">) {
  const staff = await consoleStaff(PAGE_ROLES.announcements);
  const caps = capsFor(staff.role);
  const { id } = await params;
  const [row, editorTargets] = await Promise.all([announcementById(String(id)), caps.announce ? announcementTargets() : Promise.resolve(null)]);
  if (!row) notFound();
  // Names for the chosen plans and workspaces, when there are any to name.
  const targets = editorTargets ?? (row.audience === "PLANS" || row.audience === "TENANTS" ? await announcementTargets() : null);

  const ownerOnly = row.audience === "ALL" && !caps.announceAll;
  const editable = caps.announce && row.state !== "archived" && !ownerOnly;
  const showing = row.state === "live" || row.state === "scheduled";

  const actions = caps.announce ? (
    <>
      {row.state === "live" && (
        <ActionButton
          action={consoleEndAnnouncement.bind(null, row.id)}
          label="End now…"
          icon={<CircleStop aria-hidden="true" className="h-4 w-4" />}
          confirm={{
            title: "End announcement",
            body: `It stops showing in ${plural(row.reach, "open workspace")} and moves to Ended. Other servers pick it up within a minute.`,
            confirmLabel: "End now",
          }}
          success="Announcement ended."
        />
      )}
      <Link href={`/announcements/new?from=${encodeURIComponent(row.id)}`} className={SECONDARY_LINK}>
        <CopyPlus aria-hidden="true" className="h-4 w-4" />
        Duplicate
      </Link>
      {row.state !== "archived" && (
        <ActionButton
          action={consoleArchiveAnnouncement.bind(null, row.id)}
          label="Archive…"
          variant="ghost"
          icon={<Archive aria-hidden="true" className="h-4 w-4" />}
          confirm={{
            title: "Archive announcement",
            body:
              row.state === "live"
                ? `It stops showing in ${plural(row.reach, "open workspace")} and moves to Archived, where it can't be edited — duplicate it to use it again. Other servers pick it up within a minute.`
                : row.state === "scheduled"
                  ? "It will not go up, and moves to Archived, where it can't be edited — duplicate it to use it again."
                  : "It moves to Archived, where it can't be edited — duplicate it to use it again.",
            confirmLabel: "Archive",
            tone: row.state === "live" ? "danger" : "primary",
          }}
          success="Announcement archived."
        />
      )}
    </>
  ) : undefined;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Announcements", href: row.state === "live" ? "/announcements" : `/announcements?tab=${row.state}` }, { label: row.title }]}
        title={row.title}
        chips={
          <>
            <LabelPill map={ANNOUNCEMENT_STATE} value={row.state} />
            <LabelPill map={ANNOUNCEMENT_TONE} value={row.tone} />
          </>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{`Created by ${row.createdByName}`}</span>
            {showing && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{row.state === "live" ? `Showing in ${plural(row.reach, "open workspace")}` : `Reaches ${plural(row.reach, "open workspace")} today`}</span>
              </>
            )}
          </span>
        }
        actions={actions}
      />

      {editable && targets ? (
        <div className="space-y-6">
          {row.state === "ended" && (
            <Banner tone="info" title="This announcement has ended.">
              Give it an end time in the future and save to put it back up — or duplicate it to keep this one as it was.
            </Banner>
          )}
          {/* Keyed by its window, so ending it from the header starts the form again from what was saved. */}
          <AnnouncementEditor
            key={`${row.state}:${row.startsAt.getTime()}:${row.endsAt?.getTime() ?? "open"}`}
            initial={editorRow(row)}
            targets={targets}
            caps={caps}
            mode="edit"
          />
        </div>
      ) : (
        <div className="space-y-6">
          {caps.announce && row.state === "archived" && (
            <Banner tone="info" title="Archived announcements can't be edited or shown again.">
              Duplicate it to send the same message again.
            </Banner>
          )}
          {caps.announce && row.state !== "archived" && ownerOnly && (
            <Banner tone="info" title="Only an owner can change an announcement to every workspace.">
              You can still end or archive it, or duplicate it for a narrower audience.
            </Banner>
          )}
          <ReadOnlyView row={row} targets={targets} />
        </div>
      )}
    </>
  );
}

/** Only what the editor reads crosses to the browser. */
function editorRow(row: AnnouncementListRow): AnnouncementRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tone: row.tone,
    audience: row.audience,
    targets: row.targets,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    dismissible: row.dismissible,
  };
}

function ReadOnlyView({ row, targets }: { row: AnnouncementListRow; targets: AnnouncementTargets | null }) {
  const showing = row.state === "live" || row.state === "scheduled";
  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <Panel title="Details">
        <DefinitionList
          items={[
            { term: "Tone", value: <LabelPill map={ANNOUNCEMENT_TONE} value={row.tone} /> },
            { term: "Can be dismissed", value: row.dismissible ? "Yes" : row.tone === "CRITICAL" ? "No — it is critical" : "No" },
            { term: "Starts", value: `${when(row.startsAt)} IST` },
            { term: "Ends", value: row.endsAt ? `${when(row.endsAt)} IST` : "No end — until someone ends it" },
            { term: "Audience", value: <AudienceDetail row={row} targets={targets} />, wide: true },
            ...(showing ? [{ term: row.state === "live" ? "Showing in" : "Reaches today", value: <span className="tabular-nums">{plural(row.reach, "open workspace")}</span> }] : []),
            { term: "Created by", value: row.createdByName },
          ]}
        />
      </Panel>

      <Panel title="As workspaces see it" description="Across the top of every page in a workspace it reaches.">
        <div className="rounded-lg border border-line bg-bg p-3">
          <AnnouncementBanner
            title={row.title}
            body={row.body}
            tone={row.tone}
            dismissAction={
              row.dismissible ? (
                <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-base text-subtle">
                  <X className="h-4 w-4" />
                </span>
              ) : undefined
            }
          />
        </div>
      </Panel>
    </div>
  );
}

/** Who it is for, named: countries by code, plans by name, workspaces by address (each a link). */
function AudienceDetail({ row, targets }: { row: AnnouncementListRow; targets: AnnouncementTargets | null }) {
  if (row.audience === "ALL") return <>All workspaces</>;
  if (row.audience === "COUNTRIES") return <span className="font-mono text-xs">{row.targets.join(", ")}</span>;

  if (row.audience === "PLANS") {
    const names = new Map((targets?.plans ?? []).map((p) => [p.key, p.name]));
    return (
      <ul className="flex flex-wrap gap-1.5">
        {row.targets.map((key) => (
          <li key={key} className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-surface-sunken px-2 text-xs text-text">
            {names.get(key) ?? key}
            {names.has(key) && <span className="font-mono text-[11px] text-muted">{key}</span>}
          </li>
        ))}
      </ul>
    );
  }

  // Only open workspaces are in the editor's list; one held or closed since is counted, not named.
  const open = new Map((targets?.tenants ?? []).map((t) => [t.id, t]));
  const named = row.targets.flatMap((tenantId) => {
    const t = open.get(tenantId);
    return t ? [t] : [];
  });
  const listed = named.slice(0, LISTED_MAX);
  const unlisted = named.length - listed.length;
  const notOpen = row.targets.length - named.length;
  return (
    <div className="space-y-1.5">
      <p>{plural(row.targets.length, "workspace")}</p>
      {listed.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {listed.map((t) => (
            <li key={t.id}>
              <Link
                href={`/workspaces/${t.slug}`}
                title={t.name}
                className="inline-flex h-6 items-center rounded-full border border-line bg-surface-sunken px-2 font-mono text-xs text-text hover:border-line-strong hover:text-brand"
              >
                {t.slug}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {(unlisted > 0 || notOpen > 0) && (
        <p className="text-xs text-muted">
          {[unlisted > 0 ? `and ${unlisted} more` : null, notOpen > 0 ? `${plural(notOpen, "workspace")} no longer open` : null].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );
}
