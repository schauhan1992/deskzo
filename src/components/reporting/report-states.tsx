"use client";

import { useState } from "react";
import Link from "next/link";
import { FileQuestion, Lock } from "lucide-react";
import { requestReportAccess } from "@/actions/reporting";
import { Button } from "@/components/ui/button";

/**
 * A report somebody can't see: not there (or not theirs — the same words, so an id can't be used to find out
 * which), or theirs to open but reading a source their role can't (design 1r) — where they can ask its owner.
 */
export function ReportUnavailable({ message }: { message: string }) {
  return (
    <Panel icon={<FileQuestion className="h-5 w-5" />} title="This report can't be opened" text={message}>
      <Link href="/reports/library" className="text-[13px] font-medium text-brand hover:underline">
        Go to your reports
      </Link>
    </Panel>
  );
}

export function SourceLocked({ reportId, reportName, sourceLabel, reason, owner, own }: { reportId: string; reportName: string; sourceLabel: string; reason: string; owner: string; own: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | { error: string }>("idle");
  return (
    <Panel
      icon={<Lock className="h-5 w-5" />}
      title={`You don't have access to ${sourceLabel.toLowerCase()}`}
      text={`“${reportName}” reads ${sourceLabel}, which your role can't open (${reason.toLowerCase()}). Sharing a report never widens what you can see — access comes from your role or permissions.`}
    >
      <div className="flex flex-wrap items-center justify-center gap-2">
        {!own && (
          <Button
            type="button"
            size="sm"
            disabled={state === "sending" || state === "sent"}
            onClick={async () => {
              setState("sending");
              try {
                const res = await requestReportAccess(reportId);
                setState(res.ok ? "sent" : { error: res.error });
              } catch {
                setState({ error: "Couldn't send the request. Try again." });
              }
            }}
          >
            {state === "sent" ? "Request sent" : state === "sending" ? "Sending…" : `Ask ${owner} for access`}
          </Button>
        )}
        <Link href="/reports/library" className="inline-flex h-8 items-center rounded-base px-3 text-[13px] font-medium text-muted hover:bg-surface-sunken hover:text-text">
          Back to reports
        </Link>
      </div>
      {typeof state === "object" && <p className="mt-2 text-[13px] text-danger">{state.error}</p>}
      {state === "sent" && <p className="mt-2 text-[13px] text-success">{owner} has been told. You&apos;ll see the report once your role allows it.</p>}
    </Panel>
  );
}

function Panel({ icon, title, text, children }: { icon: React.ReactNode; title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto mt-10 max-w-lg rounded-xl border border-line bg-surface px-6 py-10 text-center shadow-sm">
      <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-surface-sunken text-subtle">{icon}</span>
      <h1 className="mt-3 text-[17px] font-semibold text-text">{title}</h1>
      <p className="mx-auto mt-1.5 max-w-md text-[13.5px] text-muted">{text}</p>
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}
