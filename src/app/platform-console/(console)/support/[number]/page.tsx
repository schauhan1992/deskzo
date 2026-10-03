import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { AttachmentGallery } from "@/components/console/support/attachments";
import { SupportPriorityPill, SupportStatusPill } from "@/components/console/support/badges";
import { SupportComposer } from "@/components/console/support/composer";
import { RequestControls } from "@/components/console/support/request-controls";
import { ContextPanel, RecordingDiagnostics, RequesterPanel, WorkspacePanel } from "@/components/console/support/side-panels";
import { SupportTimeline } from "@/components/console/support/timeline";
import { plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { consoleClock } from "@/lib/platform/console-clock";
import { consoleStaff } from "@/lib/platform/console-page";
import { supportRequestDetail } from "@/lib/support/console";
import { supportRef } from "@/lib/support/types";

/** A request number as the address writes it: digits only, no leading zero — "SR-1042" or "01042" is not found. */
function numberFrom(segment: unknown): number | null {
  const text = typeof segment === "string" ? segment : "";
  if (!/^[1-9]\d{0,8}$/.test(text)) return null;
  return Number(text);
}

export async function generateMetadata({ params }: PageProps<"/platform-console/support/[number]">): Promise<Metadata> {
  const n = numberFrom((await params).number);
  return { title: n === null ? "Support" : `${supportRef(n)} · Support` };
}

/**
 * One support request (spec §5): what the customer wrote and sent, its history, the answer box, and
 * — on the right — who asked, from which workspace, and what their browser said. Owners, admins,
 * support and read-only staff may open it; only the first three change it, reply, or open its files
 * (each action and the file route check again).
 *
 * The body, replies and notes are plain text, rendered as text nodes; nothing a customer wrote is
 * ever read as HTML. Everything is loaded here, in one read, and handed down as plain props.
 */
export default async function ConsoleSupportRequestPage({ params }: PageProps<"/platform-console/support/[number]">) {
  const staff = await consoleStaff(PAGE_ROLES.support);
  const caps = capsFor(staff.role);
  const number = numberFrom((await params).number);
  if (number === null) notFound();
  const [detail, clock] = await Promise.all([supportRequestDetail(number), consoleClock()]);
  if (!detail) notFound();

  const recording = detail.attachments.some((a) => a.kind === "RECORDING");
  const files = detail.attachments.length;

  const chips = (
    <>
      <SupportStatusPill status={detail.status} />
      <SupportPriorityPill priority={detail.priority} />
    </>
  );

  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="font-mono text-xs text-text">{detail.ref}</span>
      <span aria-hidden="true" className="text-subtle">
        ·
      </span>
      <span className="text-xs">{`${detail.requester.name} at ${detail.workspace.name}`}</span>
      <span aria-hidden="true" className="text-subtle">
        ·
      </span>
      <span className="text-xs">
        {"sent "}
        <RelativeTime at={detail.createdAt} absolute="datetime" />
      </span>
      {!caps.actOnSupport && (
        <>
          <span aria-hidden="true" className="text-subtle">
            ·
          </span>
          <span className="text-xs">{detail.assignee ? `assigned to ${detail.assignee.name}` : "unassigned"}</span>
        </>
      )}
    </span>
  );

  const stamps = [
    detail.firstResponseAt ? `First reply ${clock.dateTime(detail.firstResponseAt)}` : "No reply emailed yet",
    detail.resolvedAt ? `Resolved ${clock.dateTime(detail.resolvedAt)}` : null,
    detail.closedAt ? `Closed ${clock.dateTime(detail.closedAt)}` : null,
  ].filter((s): s is string => s !== null);

  return (
    <>
      <PageHeader
        title={detail.subject}
        crumbs={[{ label: "Support", href: "/support" }, { label: detail.ref }]}
        chips={chips}
        subtitle={subtitle}
        actions={
          caps.actOnSupport ? (
            <RequestControls number={detail.number} status={detail.status} priority={detail.priority} assignee={detail.assignee} assignees={detail.assignees} />
          ) : undefined
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Panel title="What they wrote" description={stamps.join(" · ")}>
            <p className="text-sm break-words whitespace-pre-wrap text-text">{detail.body}</p>
          </Panel>

          <Panel
            title="Attachments"
            description={files > 0 ? `${plural(files, "file")}${recording ? ", including a screen recording" : ""}` : undefined}
          >
            <AttachmentGallery attachments={detail.attachments} canOpen={caps.actOnSupport} />
          </Panel>

          <Panel title="Timeline" description="Replies, internal notes and every change, oldest first.">
            <SupportTimeline entries={detail.entries} received={{ at: detail.createdAt, name: detail.requester.name, email: detail.requester.email }} />
          </Panel>

          {caps.actOnSupport && <SupportComposer number={detail.number} requesterEmail={detail.requester.email} supportEmail={detail.supportEmail} />}
        </div>

        <div className="min-w-0 space-y-6">
          <RequesterPanel requester={detail.requester} />
          <WorkspacePanel detail={detail} caps={caps} />
          <ContextPanel context={detail.context} />
          {detail.recordingConsentAt && <RecordingDiagnostics consoleLog={detail.consoleLog} perf={detail.perf} consentAt={detail.recordingConsentAt} />}
        </div>
      </div>
    </>
  );
}
