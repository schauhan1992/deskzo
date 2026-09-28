import type { AnnouncementView } from "@/lib/platform/announcements";
import { AnnouncementBanner } from "@/components/platform/announcement-banner";
import { DismissAnnouncementButton, DismissibleAnnouncement } from "@/components/platform/announcement-dismiss";

/**
 * The platform's announcements at the top of a workspace page, above the billing reminder — what
 * `activeAnnouncementsFor` (src/lib/platform/announcements.ts) found for this workspace, most serious
 * first. Plain props in, so the layout does the reading and this only draws.
 *
 * Nothing at all for an empty list, and the list hides itself (`empty:hidden`) once every banner in it
 * has been dismissed, so no gap is left behind.
 */
export function PlatformAnnouncements({ items }: { items: AnnouncementView[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Announcements" className="my-4 flex flex-col gap-2 empty:hidden md:my-6">
      {items.map((item) => {
        // A critical one stays until it ends, whatever the row says.
        const dismissible = item.dismissible && item.tone !== "CRITICAL";
        return (
          <DismissibleAnnouncement key={item.id} id={item.id} dismissible={dismissible}>
            <AnnouncementBanner
              title={item.title}
              body={item.body}
              tone={item.tone}
              dismissAction={dismissible ? <DismissAnnouncementButton id={item.id} /> : undefined}
            />
          </DismissibleAnnouncement>
        );
      })}
    </section>
  );
}
