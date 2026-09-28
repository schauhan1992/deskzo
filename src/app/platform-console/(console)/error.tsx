"use client";

import Link from "next/link";
import { CircleAlert, RotateCw } from "lucide-react";
import { Panel } from "@/components/console/kit/panel";
import { Button } from "@/components/ui/button";

/**
 * A console page that failed to render. The shell stays — sidebar, top bar, palette — so the way out is
 * where it always is. It never shows `error.message`: a server error's text can carry a query, a host
 * or a key, and the operator needs none of it. The digest is what matches the server's log line.
 */
export default function ConsoleError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <Panel>
      <div className="flex flex-col items-center gap-4 py-10 text-center">
        <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-full bg-danger-bg text-danger">
          <CircleAlert className="h-5 w-5" />
        </span>
        <div role="alert" className="space-y-1.5">
          <h1 className="text-base font-semibold text-text">Something went wrong loading this page.</h1>
          {error.digest && (
            <p className="text-xs text-muted">
              Reference:{" "}
              <span translate="no" className="font-mono text-text select-all">
                {error.digest}
              </span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={() => retry()}>
            <RotateCw aria-hidden="true" className="h-4 w-4" />
            Try again
          </Button>
          <Link
            href="/"
            className="inline-flex h-9 items-center justify-center rounded-base border border-line-strong bg-surface px-3.5 text-sm font-medium text-text shadow-sm transition-colors hover:bg-surface-sunken"
          >
            Go to Overview
          </Link>
        </div>
      </div>
    </Panel>
  );
}
