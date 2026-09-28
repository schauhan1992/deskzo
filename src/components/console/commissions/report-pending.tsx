"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Panel } from "@/components/console/kit/panel";

/**
 * The Reports tab before it is opened. The report adds up every partner's and every country's MRR,
 * so the page works it out only when Reports is the tab asked for — not on every visit to Review,
 * nor on the refresh after every void or payment.
 *
 * Opening the tab flips this panel visible (the tab bar does it by hand, and puts `?tab=reports` in
 * the address), which this notices and answers with a refresh: the server then renders the page with
 * Reports open and its figures in. The link is the way there without script.
 */
export function ReportPending({ href }: { href: string }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const panel = ref.current?.closest<HTMLElement>('[role="tabpanel"]');
    if (!panel) return;
    let asked = false;
    let timer: number | undefined;
    const ask = () => {
      if (asked || panel.hidden) return;
      asked = true;
      // After the tab bar's own handler has put the new address in place.
      timer = window.setTimeout(() => router.refresh(), 0);
    };
    const observer = new MutationObserver(ask);
    observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    ask();
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [router]);

  return (
    <Panel>
      <div ref={ref} className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <LoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin text-subtle" />
        <p className="text-sm font-medium text-text">Working out the report…</p>
        <p className="max-w-sm text-xs text-muted">Partner and country figures are added up when this tab is opened.</p>
        <Link href={href} className="text-sm font-medium text-brand hover:underline">
          Open the report
        </Link>
      </div>
    </Panel>
  );
}
