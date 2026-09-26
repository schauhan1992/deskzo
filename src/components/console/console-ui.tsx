import type { ReactNode } from "react";
import { Badge, Card } from "@/components/ui/card";
import { formatIstDateTime } from "@/lib/india-time";
import { cn } from "@/lib/utils";

/** The console pages' shared pieces — plain server-rendered markup, nothing interactive. */

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      {children && <p className="mt-1 text-sm text-muted">{children}</p>}
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Card className="mb-6 hover:shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 className="text-sm font-medium text-text">{title}</h2>
        {aside}
      </div>
      <div className="px-5 py-4">{children}</div>
    </Card>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "danger" | "warning" }) {
  return (
    <Card className="px-4 py-3 hover:shadow-sm">
      <p className="text-xs text-muted">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text")}>{value}</p>
    </Card>
  );
}

/** A table that scrolls sideways inside its card on a narrow screen, never the page. */
export function DataTable({ head, children, empty }: { head: string[]; children: ReactNode; empty?: string }) {
  const rows = Array.isArray(children) ? children.flat().filter(Boolean) : children ? [children] : [];
  if (!rows.length) return <p className="text-sm text-muted">{empty ?? "Nothing yet."}</p>;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            {head.map((h) => (
              <th key={h} className="px-5 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn("px-5 py-2 align-top text-text", className)}>{children}</td>;
}

const STATUS_TONES = {
  ACTIVE: "green",
  SUCCEEDED: "green",
  PROVISIONING: "blue",
  RUNNING: "blue",
  PENDING: "default",
  MIGRATING: "amber",
  SUSPENDED: "amber",
  FAILED: "red",
  DEPROVISIONED: "default",
} as const;

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONES[status as keyof typeof STATUS_TONES] ?? "default";
  return <Badge tone={tone}>{status.toLowerCase()}</Badge>;
}

/** A moment, in India time — the platform's one clock (src/lib/india-time.ts). */
export function when(at: Date | string | null | undefined): string {
  return at ? formatIstDateTime(at) : "—";
}
