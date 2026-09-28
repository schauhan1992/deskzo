import type { Metadata } from "next";
import { AnnouncementEditor } from "@/components/console/announcements/announcement-editor";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { one } from "@/lib/console-shared/params";
import { MANAGERS, capsFor } from "@/lib/console-shared/roles";
import { announcementById, announcementTargets, type AnnouncementRow } from "@/lib/platform/announcements";
import { consoleStaff } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "New announcement" };

/**
 * A new announcement (spec §3.8) — blank, or a copy of another (`?from=id`). A copy keeps what it
 * says, its tone and its audience, and starts with an empty window: the original's has usually
 * passed, and a banner that goes up the moment it is saved should be a choice, not an inheritance.
 * Owners and admins only; everyone else gets "not found".
 */
export default async function ConsoleNewAnnouncementPage({ searchParams }: PageProps<"/platform-console/announcements/new">) {
  const staff = await consoleStaff(MANAGERS);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const from = one(sp, "from", 64);
  const [targets, source] = await Promise.all([announcementTargets(), from ? announcementById(from) : Promise.resolve(null)]);

  // Only what the editor reads crosses to the browser — not who wrote it or when it was archived.
  const initial: AnnouncementRow | null = source
    ? {
        id: source.id,
        title: source.title,
        body: source.body,
        tone: source.tone,
        audience: source.audience,
        targets: source.targets,
        startsAt: source.startsAt,
        endsAt: source.endsAt,
        dismissible: source.dismissible,
      }
    : null;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Announcements", href: "/announcements" }, { label: "New announcement" }]}
        title="New announcement"
        subtitle={
          source ? (
            <>
              A copy of <span className="font-medium text-text">{`“${source.title}”`}</span> — choose when it runs.
            </>
          ) : (
            "A banner across the top of every page in the workspaces you choose, for as long as you choose."
          )
        }
      />
      {from && !source && (
        <Banner tone="info" title="There is no announcement to copy at that address." className="mb-6">
          This starts from a blank one instead.
        </Banner>
      )}
      <AnnouncementEditor initial={initial} targets={targets} caps={caps} mode={source ? "duplicate" : "create"} />
    </>
  );
}
