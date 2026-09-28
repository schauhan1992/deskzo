import type { ReactNode } from "react";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";

/**
 * One platform announcement, as a workspace sees it — and as the console's editor previews it, which is
 * why this file is pure: no directive, no hooks, nothing from src/lib/platform. It renders the same on
 * the server and in a client component.
 *
 * The body is a text node and nothing else. React escapes it, `whitespace-pre-line` keeps the line
 * breaks, and there is deliberately no markdown and no turning URLs into links: a banner on every
 * customer's screen that could carry a link is a phishing page with our name on it.
 *
 * No live-region role here: the editor's preview changes on every keystroke, and a screen reader
 * would read each one out. The workspace side names its list as a region instead.
 */

type AnnouncementTone = "INFO" | "WARNING" | "CRITICAL";

const TONES: Record<AnnouncementTone, { classes: string; label: string; Icon: typeof Info }> = {
  INFO: { classes: "border-info/30 bg-info-bg text-info", label: "Announcement", Icon: Info },
  WARNING: { classes: "border-warning/40 bg-warning-bg text-warning", label: "Warning", Icon: TriangleAlert },
  CRITICAL: { classes: "border-danger/40 bg-danger-bg text-danger", label: "Important", Icon: CircleAlert },
};

export function AnnouncementBanner({ title, body, tone, dismissAction }: { title: string; body: string; tone: "INFO" | "WARNING" | "CRITICAL"; dismissAction?: ReactNode }) {
  const look = TONES[tone] ?? TONES.INFO;
  const Icon = look.Icon;
  return (
    <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${look.classes}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium break-words">
          <span className="sr-only">{look.label}: </span>
          {title}
        </p>
        {body ? <p className="mt-1 whitespace-pre-line break-words text-text">{body}</p> : null}
      </div>
      {dismissAction ? <div className="-my-1 -mr-2 shrink-0">{dismissAction}</div> : null}
    </div>
  );
}
