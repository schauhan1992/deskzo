"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { refreshDomainProfile, type listDomainProfiles } from "@/actions/domain";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useClock } from "@/components/time/clock-provider";
import { toDomain } from "@/lib/domain-intel/signatures";

type Row = Awaited<ReturnType<typeof listDomainProfiles>>["rows"][number];

/**
 * The prospecting list: every company with a website, and the two or three facts that decide
 * whether they're worth a call.
 *
 * Deliberately not every field — the columns here are the ones that change the answer to "who do I
 * ring today". The rest is on the company's own Details tab.
 */
export function DomainRows({ rows }: { rows: Row[] }) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2.5">Company</th>
            <th className="px-4 py-2.5">Email</th>
            <th className="px-4 py-2.5">Website</th>
            <th className="px-4 py-2.5">Protection</th>
            <th className="px-4 py-2.5">Registrar</th>
            <th className="px-4 py-2.5">Checked</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <DomainRow key={row.id} row={row} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-subtle">
                No companies match these filters. Only companies with a website on file appear here.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

function DomainRow({ row }: { row: Row }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const profile = row.domainProfile;

  function refresh() {
    setError(null);
    startTransition(async () => {
      const result = await refreshDomainProfile(row.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  // Both are openings, and both are worth seeing at a glance on a prospecting list.
  const spoofable = profile && (!profile.dmarcRecord || profile.dmarcPolicy === "none");
  const noSpf = profile && !profile.spfRecord;

  return (
    <tr className="border-b border-line last:border-0 hover:bg-surface-sunken">
      <td className="px-4 py-2.5">
        <Link href={`/companies/${row.id}`} className="font-medium text-text hover:underline">
          {row.name}
        </Link>
        <div className="mt-0.5 font-mono text-xs text-subtle">{toDomain(row.website) ?? row.website}</div>
        {error && <div className="mt-1 text-xs text-danger">{error}</div>}
      </td>
      <td className="px-4 py-2.5">
        {profile?.emailProvider ? (
          <>
            <span className="text-text">{profile.emailProvider}</span>
            {profile.emailSecurityProvider && (
              <div className="mt-0.5 text-xs text-subtle">via {profile.emailSecurityProvider}</div>
            )}
          </>
        ) : (
          <span className="text-subtle">—</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {profile?.platform ? (
          <>
            <span className="text-text">{profile.platform}</span>
            {profile.hostProvider && <div className="mt-0.5 text-xs text-subtle">{profile.hostProvider}</div>}
          </>
        ) : (
          <span className="text-subtle">—</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {!profile ? (
          <span className="text-subtle">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {noSpf && <Badge tone="amber">No SPF</Badge>}
            {spoofable && (
              <Badge tone="red">
                <ShieldAlert className="mr-1 inline h-3 w-3" />
                {profile.dmarcRecord ? "DMARC p=none" : "No DMARC"}
              </Badge>
            )}
            {!noSpf && !spoofable && <Badge tone="green">Protected</Badge>}
          </div>
        )}
      </td>
      <td className="px-4 py-2.5 text-muted">
        {profile?.registrar ?? "—"}
        {profile?.expiresOn && (
          <div className="mt-0.5 text-xs text-subtle">expires {clock.date(profile.expiresOn)}</div>
        )}
      </td>
      <td className="px-4 py-2.5 text-xs text-subtle">
        {profile?.fetchedAt ? clock.date(profile.fetchedAt) : "Never"}
      </td>
      <td className="px-4 py-2.5 text-right">
        <Button size="sm" variant="ghost" disabled={pending} onClick={refresh} title="Look this domain up now">
          <RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
        </Button>
      </td>
    </tr>
  );
}
