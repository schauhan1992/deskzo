/** When to call back, as the after-call card and sheet offer it (src/app/review/[id].tsx, src/app/after-call.tsx). */

const at = (hoursFromNow: number, hour?: number) => {
  const d = new Date(Date.now() + hoursFromNow * 3_600_000);
  if (hour !== undefined) d.setHours(hour, 0, 0, 0);
  return d;
};

export const CALLBACKS: { label: string; at: () => Date }[] = [
  { label: "In an hour", at: () => at(1) },
  { label: "Tomorrow 10:00", at: () => at(24, 10) },
  { label: "In 3 days", at: () => at(72, 10) },
  { label: "Next week", at: () => at(168, 10) },
];
