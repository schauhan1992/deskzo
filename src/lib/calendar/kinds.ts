/** The records a meeting can be scheduled from — plain, so the browser's components can name one too. */
export const MEETING_RECORD_KINDS = ["lead", "company", "contact", "ticket", "visit"] as const;
export type MeetingRecordKind = (typeof MEETING_RECORD_KINDS)[number];
export type MeetingRecordRef = { kind: MeetingRecordKind; id: string };
