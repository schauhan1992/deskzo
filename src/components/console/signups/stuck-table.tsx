import Link from "next/link";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { LabelPill, TenantStatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { JOB_STATUS, SIGNUP_STAGE } from "@/lib/console-shared/labels";
import { withParams } from "@/lib/console-shared/params";
import type { StuckRow } from "@/lib/platform/signups";
import { SIGNUP_BROWSER_MS } from "@/lib/console-shared/signup-browser";
import { ResendCode } from "./resend-code";
import { cn } from "@/lib/utils";

/**
 * Signups that stopped part-way (spec §3.6): the emailed code ran out before it was entered, the
 * workspace's setup stalled or failed, or the workspace is ready and its owner never came in. Each
 * row is somebody to follow up with, so the contact details lead.
 *
 * The address the signup came from is a column only for the staff allowed to see it (`showIp`, the
 * managers) — and the loader does not even read it for anybody else. A signup whose code never got
 * entered offers a new one (src/lib/platform/signup-code.ts). Server-safe.
 */
export function StuckTable({ rows, showIp }: { rows: StuckRow[]; showIp: boolean }) {
  return (
    <DataTable caption="Stuck signups" minWidth={showIp ? 1240 : 1120}>
      <THead>
        <Th>Company</Th>
        <Th>Email</Th>
        <Th>Address</Th>
        <Th>Country</Th>
        <Th>Started</Th>
        <Th>Stage</Th>
        <Th numeric>Code attempts</Th>
        <Th>Invited</Th>
        {showIp && <Th>IP address</Th>}
        <Th>Workspace</Th>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.id}>
            <Td>
              <div className="max-w-[16rem] min-w-36">
                <p className="truncate font-medium text-text" title={row.companyName}>
                  {row.companyName}
                </p>
                <p className="truncate text-xs text-muted" title={row.ownerName}>
                  {row.ownerName}
                </p>
              </div>
            </Td>
            <Td>
              <span className="block max-w-[16rem] truncate" title={row.email}>
                {row.email}
              </span>
            </Td>
            <Td mono muted nowrap>
              {row.slug}
            </Td>
            <Td mono muted nowrap>
              {row.country}
            </Td>
            <Td muted nowrap>
              <RelativeTime at={row.createdAt} />
            </Td>
            <Td nowrap>
              <LabelPill map={SIGNUP_STAGE} value={row.stage} />
              <StageDetail row={row} />
              {row.stage === "never-verified" && <ResendCode signupId={row.id} email={row.email} pageEndsAt={new Date(row.createdAt.getTime() + SIGNUP_BROWSER_MS)} />}
            </Td>
            <Td numeric muted={row.attempts === 0}>
              {row.attempts}
            </Td>
            <Td muted nowrap>
              {row.invited ? "Yes" : "No"}
            </Td>
            {showIp && (
              <Td mono muted nowrap>
                {row.ip || "—"}
              </Td>
            )}
            <Td nowrap>
              <WorkspaceCell row={row} />
            </Td>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}

/** One line under the stage pill saying what, exactly, is stuck. */
function StageDetail({ row }: { row: StuckRow }) {
  let text: string;
  let tone = "text-muted";
  let title: string | undefined;
  if (row.stage === "never-verified") {
    text = row.codeExpired ? "The emailed code ran out" : "Code not entered yet";
  } else if (row.stage === "setup-stuck") {
    if (row.job?.status === "FAILED") {
      text = `Failed at ${row.job.step}`;
      tone = "text-danger";
      title = row.job.error ?? undefined;
    } else if (row.job) {
      text = `${JOB_STATUS[row.job.status]?.label ?? row.job.status} · ${row.job.step}`;
    } else {
      text = "Setup has not started";
    }
  } else {
    text = "Ready — never signed in";
  }
  return (
    <p className={cn("mt-0.5 max-w-[14rem] truncate text-[11px]", tone)} title={title ?? text}>
      {text}
    </p>
  );
}

/** The workspace made for it, when there is one — and, for a setup that failed, the way to try it again. */
function WorkspaceCell({ row }: { row: StuckRow }) {
  if (!row.tenant) return <span className="text-subtle">—</span>;
  const failed = row.stage === "setup-stuck" && row.job?.status === "FAILED";
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-1.5">
        <Link href={`/workspaces/${row.tenant.slug}`} className="font-mono text-xs font-medium text-brand hover:underline">
          {row.tenant.slug}
        </Link>
        {row.tenant.status !== "ACTIVE" && <TenantStatusPill status={row.tenant.status} />}
      </div>
      {failed && (
        <Link href={withParams("/provisioning", {}, { filter: "attention", q: row.tenant.slug })} className="text-[11px] font-medium text-brand hover:underline">
          Open in Provisioning
        </Link>
      )}
    </div>
  );
}
