import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HelpContentEditor } from "@/components/console/help-content/help-content-editor";
import { HelpItemActions, HelpItemScope, type HelpVerbTarget } from "@/components/console/help-content/help-verb-dialog";
import { HELP_STATE, KIND_TITLE, linkText, moduleNames, reachLine, tabOf, type HelpListItem } from "@/components/console/help-content/shared";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { consoleClock } from "@/lib/platform/console-clock";
import { consoleStaff } from "@/lib/platform/console-page";
import type { Clock } from "@/lib/time/zone";
import { helpEditorChoices, helpItemById } from "../load";

/** The address holds an id, not a name, so the title says what the page is and nothing more. */
export const metadata: Metadata = { title: "Help item" };

/**
 * One of Deskzo's help articles, walkthrough videos or What's new posts. Owners and admins edit it in
 * place — the same editor as a new one — and publish, take down, archive or restore it from the
 * header — which waits while the editor holds unsaved changes, as it acts on what was saved.
 * Everybody else, and an archived item, gets a read-only view: what it says, where it points, who
 * sees it and since when.
 */
export default async function ConsoleHelpItemPage({ params }: PageProps<"/platform-console/help-content/[id]">) {
  const staff = await consoleStaff(PAGE_ROLES.help);
  const caps = capsFor(staff.role);
  const { id } = await params;
  const [detail, choices, clock] = await Promise.all([helpItemById(String(id)), caps.manage ? helpEditorChoices() : Promise.resolve(null), consoleClock()]);
  if (!detail) notFound();
  const { item, editor, createdByName } = detail;

  const tab = tabOf(item.kind);
  const query = new URLSearchParams();
  if (tab !== "articles") query.set("tab", tab);
  if (item.state === "archived") query.set("show", "archived");
  const listHref = query.toString() ? `/help-content?${query.toString()}` : "/help-content";
  const target: HelpVerbTarget = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    state: item.state,
    publishedAt: item.publishedAt,
    modules: item.modules,
    countries: item.countries,
    reach: item.reach,
  };

  return (
    <HelpItemScope>
      <PageHeader
        crumbs={[{ label: "Help and What's new", href: listHref }, { label: item.title }]}
        title={item.title}
        chips={
          <>
            <LabelPill map={HELP_STATE} value={item.state} />
            <StatusPill tone="neutral">{KIND_TITLE[item.kind]}</StatusPill>
          </>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{`Updated by ${item.updatedByName}, ${zoned(clock, item.updatedAt)}`}</span>
            {reachLine(item.state, item.reach) && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{reachLine(item.state, item.reach)}</span>
              </>
            )}
          </span>
        }
        actions={caps.manage ? <HelpItemActions target={target} caps={caps} /> : undefined}
      />

      {caps.manage && choices && item.state !== "archived" ? (
        // Keyed by what the header's buttons change, so publishing or taking it down from there starts the form again from what was saved.
        <HelpContentEditor
          key={`${item.state}:${item.publishedAt?.getTime() ?? "none"}:${item.updatedAt.getTime()}`}
          kind={item.kind}
          initial={editor}
          choices={choices}
          caps={caps}
          mode="edit"
        />
      ) : (
        <div className="space-y-6">
          {caps.manage && item.state === "archived" && (
            <Banner tone="info" title="Archived items can't be edited or shown.">
              Restore it as a draft to change it or publish it again.
            </Banner>
          )}
          <ReadOnlyView item={item} createdByName={createdByName} clock={clock} />
        </div>
      )}
    </HelpItemScope>
  );
}

/** A time on the console's clock with its zone named — it goes live in every workspace at once, whatever their zones. */
const zoned = (clock: Clock, at: Date) => `${clock.dateTime(at)} ${clock.offsetLabel(at)}`;

function ReadOnlyView({ item, createdByName, clock }: { item: HelpListItem; createdByName: string; clock: Clock }) {
  const names = moduleNames(item.modules);
  const post = item.kind === "POST";
  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <Panel title="Details">
        <DefinitionList
          items={[
            { term: "Kind", value: KIND_TITLE[item.kind] },
            { term: "Status", value: <LabelPill map={HELP_STATE} value={item.state} /> },
            {
              term: item.state === "scheduled" ? "Goes live" : "Published",
              value: item.publishedAt ? zoned(clock, item.publishedAt) : "Not yet — a draft",
            },
            ...(post ? [{ term: "Pinned", value: item.pinned ? "Yes" : "No" }] : []),
            { term: post ? "Read more" : "Link", value: item.url ? <span className="font-mono text-xs break-all">{linkText(item.url)}</span> : "None", wide: true },
            { term: "Modules", value: names.length ? names.join(", ") : "Any — every workspace", wide: true },
            { term: "Countries", value: item.countries.length ? <span className="font-mono text-xs">{item.countries.join(", ")}</span> : "Any" },
            ...(item.reach !== null && item.state !== "archived" ? [{ term: "Reach", value: <span className="tabular-nums">{reachLine(item.state, item.reach)}</span> }] : []),
            { term: "Created by", value: createdByName },
          ]}
        />
      </Panel>

      <Panel title={post ? "What it says" : "Description"}>
        {item.text ? <p className="text-sm whitespace-pre-line break-words text-text">{item.text}</p> : <p className="text-sm text-muted">None.</p>}
      </Panel>
    </div>
  );
}
