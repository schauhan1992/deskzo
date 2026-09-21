"use client";

import { CircleAlert, CircleCheck, Info } from "lucide-react";

/**
 * What happened after somebody pressed a button.
 *
 * Two problems, one component.
 *
 * **It did not say whether it worked.** Screens up and down the app funnelled success and failure
 * into a single `notice` string and rendered it in the same muted grey: the permission matrix put
 * `Applied "Auditor": 40 granted, 12 revoked.` and `You can't change permissions.` through the same
 * `<p className="text-xs text-muted">`. An administrator who is told nothing went wrong, in the
 * voice used for telling them it went right, has no reason to look again — and the thing they
 * believe they changed is the thing deciding who can read payroll.
 *
 * **Nobody heard it.** A result that appears in a corner of the page is announced to a screen reader
 * only if it is in a live region. Without one the button is pressed, nothing is read out, and the
 * only way to discover the outcome is to go looking for text that may not have moved focus.
 *
 * So tone is a required argument rather than a default. `role="alert"` interrupts for a failure —
 * which is the one case worth interrupting for — and `role="status"` waits for a pause otherwise.
 */
export type NoticeTone = "success" | "error" | "info";

const STYLES: Record<NoticeTone, { className: string; Icon: typeof Info }> = {
  success: { className: "border-success/40 bg-success/5 text-success", Icon: CircleCheck },
  error: { className: "border-danger/40 bg-danger/5 text-danger", Icon: CircleAlert },
  info: { className: "border-line bg-surface-sunken text-muted", Icon: Info },
};

export function ActionNotice({
  tone,
  children,
  className = "",
}: {
  tone: NoticeTone;
  children: React.ReactNode;
  className?: string;
}) {
  const { className: toneClass, Icon } = STYLES[tone];

  return (
    <p
      // Assertive for a failure, polite otherwise — see the note above.
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-1.5 rounded-base border px-2.5 py-1.5 text-xs ${toneClass} ${className}`}
    >
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The empty wrapper that has to be on the page *before* the message is.
 *
 * A live region announces changes to a region the screen reader is already watching. Mount the
 * region and its first message together and there is nothing to change — many readers say nothing
 * at all. So where a result appears and disappears, render this always and let it hold the notice.
 */
export function ActionNoticeRegion({
  notice,
  className = "",
}: {
  notice: { tone: NoticeTone; message: string } | null;
  className?: string;
}) {
  return (
    <div aria-live="polite" aria-atomic="true" className={className}>
      {notice && <ActionNotice tone={notice.tone}>{notice.message}</ActionNotice>}
    </div>
  );
}
