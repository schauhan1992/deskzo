"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { findCompanyMatches, type CompanyMatch, type CompanyMatches } from "@/actions/company";
import { relationshipTypeLabels } from "@/lib/validation/company";

/**
 * What is already in the CRM under the name being typed — under the name field, as it is typed.
 *
 * The same idea as the company picker on a new lead, turned round: there it lets you pick an
 * existing company, here it stops you making a second one. An exact match is the case that matters
 * most — saving it will be refused — so it is shown first and in red, with the way out: open the one
 * that exists.
 *
 * Inline rather than a floating dropdown. Nothing here needs to take focus, so the name field keeps
 * it, and a panel that sits in the page cannot end up swallowing keystrokes meant for the input.
 */
export function ExistingCompanyMatches({ name }: { name: string }) {
  const typed = name.trim();
  const [result, setResult] = useState<{ key: string; data: CompanyMatches } | null>(null);

  useEffect(() => {
    if (!typed) return;
    let live = true;
    const timer = setTimeout(() => {
      findCompanyMatches(typed)
        .then((data) => {
          if (live) setResult({ key: typed, data });
        })
        .catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [typed]);

  if (!typed || !result) return null;
  // The list may trail a keystroke behind — harmless. A duplicate claim may not: it is only shown
  // for the exact text in the box, never for what was there a moment ago.
  const current = result.key === typed;
  const { matches, duplicate } = result.data;

  return (
    <div className="space-y-2">
      {current && duplicate?.visible && (
        <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
          <span className="font-medium">{duplicate.match.name}</span> is already in the CRM — open it instead of creating a
          duplicate.{" "}
          <Link href={`/companies/${duplicate.match.ref}`} className="font-medium underline underline-offset-2">
            Open {duplicate.match.ref} →
          </Link>
        </div>
      )}
      {current && duplicate && !duplicate.visible && (
        <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
          A company with exactly this name already exists, assigned to somebody else — saving will be refused. Ask an
          admin to give you access to it instead of creating a second one.
        </div>
      )}

      {matches.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-line">
          <p className="bg-surface-sunken px-3 py-1.5 text-xs text-subtle">
            Similar names already in the CRM — open one if it&apos;s the same company
          </p>
          <ul className="divide-y divide-line">
            {matches.map((m) => (
              <li key={m.id}>
                <MatchRow match={m} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        current && !duplicate && <p className="text-xs text-subtle">No matching companies — this will be a new one.</p>
      )}
    </div>
  );
}

function MatchRow({ match }: { match: CompanyMatch }) {
  const detail = [match.city, relationshipTypeLabels[match.relationshipType], match.owner].filter(Boolean).join(" · ");
  return (
    <Link
      href={`/companies/${match.ref}`}
      className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm text-text hover:bg-surface-sunken"
    >
      <span className="min-w-0 truncate">{match.name}</span>
      <span className="shrink-0 text-xs text-subtle">
        {detail ? `${detail} · ` : ""}
        <span className="font-mono">{match.ref}</span>
      </span>
    </Link>
  );
}
