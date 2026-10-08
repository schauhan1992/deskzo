"use client";

import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MeetingDialog } from "@/components/calendar/meeting-dialog";
import type { MeetingRecordRef } from "@/lib/calendar/kinds";

/**
 * "Schedule meeting", wherever a meeting can be about something: a lead, a customer, one of its
 * contacts, a ticket, a planned visit — or nothing, from the Calendar page. The dialog loads only when
 * it is opened.
 */
export function ScheduleMeetingButton({
  record,
  label,
  size = "md",
  variant = "secondary",
  className,
}: {
  record: MeetingRecordRef | null;
  label?: string;
  size?: "sm" | "md" | "icon";
  variant?: "primary" | "secondary" | "ghost" | "subtle";
  /** For an icon among a row's actions: `h-7 w-7` to sit with IconButton's. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const text = label ?? (record?.kind === "visit" ? "Add to my calendar" : "Schedule meeting");
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)} title={text} aria-label={text} className={className}>
        <CalendarPlus className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
        {size === "icon" ? null : text}
      </Button>
      {open && <MeetingDialog mode={{ kind: "new", record }} onClose={() => setOpen(false)} />}
    </>
  );
}
