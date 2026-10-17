/**
 * What the Calendar page lays out — plain, so the browser's components share it with the server. A meeting
 * (from the person's connected calendar, or Deskzo's own), and alongside it, read-only, what else fills
 * their days here: tasks due, planned visits, approved leave, holidays and bookings taken on their pages.
 */

export const CALENDAR_ITEM_KINDS = ["meeting", "task", "visit", "leave", "holiday", "booking"] as const;
export type CalendarItemKind = (typeof CALENDAR_ITEM_KINDS)[number];

export const ITEM_KIND_LABELS: Record<CalendarItemKind, string> = {
  meeting: "Meeting",
  task: "Task due",
  visit: "Planned visit",
  leave: "Leave",
  holiday: "Holiday",
  booking: "Booking",
};

export type CalendarItem = {
  id: string;
  kind: CalendarItemKind;
  /** A meeting in Deskzo's own calendar, in no provider's. */
  native: boolean;
  title: string;
  startsAt: string;
  endsAt: string;
  /** Midnight UTC of the first day to midnight UTC after the last, as a typed day is kept. */
  allDay: boolean;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  location: string | null;
  joinUrl: string | null;
  isOrganizer: boolean;
  organizerEmail: string | null;
  description: string | null;
  attendees: { email: string; name: string | null; response: string | null }[];
  record: { label: string; href: string } | null;
};
