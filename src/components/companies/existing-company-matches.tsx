"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { findCompanyMatches, setCompanySecondRole, type CompanyMatch, type CompanyMatches } from "@/actions/company";
import type { CompanyRelationshipType } from "@prisma/client";
import { isVendorRelationshipType, relationshipTypeLabels } from "@/lib/validation/company";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

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
 *
 * `adding`: the kind being created (owner, 19 Oct 2026) — similar names are only of its side, so adding a
 * customer never lists vendors, nor a vendor customers. The same name is said whatever its kind: names
 * are one to a company, so saving would be refused.
 */
type ExistingCompany = { id: string; name: string; contacts: { id: string; name: string; designation: string }[] };

export function ExistingCompanyMatches({
  name,
  adding,
  onUseExisting,
}: {
  name: string;
  adding?: CompanyRelationshipType;
  /** Given the company once it has been made the side being added — the lead form picks it, rather than a new one. */
  onUseExisting?: (company: ExistingCompany) => void;
}) {
  const typed = name.trim();
  const [result, setResult] = useState<{ key: string; data: CompanyMatches } | null>(null);
  const [pending, startTransition] = useTransition();
  const [madeBoth, setMadeBoth] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const w = useWording();

  useEffect(() => {
    if (!typed) return;
    let live = true;
    const timer = setTimeout(() => {
      findCompanyMatches(typed, adding)
        .then((data) => {
          if (live) setResult({ key: typed, data });
        })
        .catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [typed, adding]);

  if (!typed || !result) return null;
  // The list may trail a keystroke behind — harmless. A duplicate claim may not: it is only shown
  // for the exact text in the box, never for what was there a moment ago.
  const current = result.key === typed;
  const { matches, duplicate } = result.data;
  // The same name on the other side (src/lib/companies/roles.ts): it can take the side being added as a second role.
  const wantSide = adding ? (isVendorRelationshipType(adding) ? "vendor" : "customer") : null;
  const otherSide = !!duplicate?.visible && !!wantSide && !(wantSide === "vendor" ? duplicate.vendor : duplicate.customer);
  const addRole = (companyId: string) => {
    if (!wantSide) return;
    setRoleError(null);
    startTransition(async () => {
      const done = await setCompanySecondRole({ companyId, side: wantSide, on: true });
      if (!done.ok) {
        setRoleError(done.error);
        return;
      }
      setMadeBoth(companyId);
      onUseExisting?.(done.data.company);
    });
  };

  return (
    <div className="space-y-2">
      {current && duplicate?.visible && (
        <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
          <span className="font-medium">{duplicate.match.name}</span>{" "}
          {madeBoth === duplicate.match.id
            ? `is a ${wantSide} too now — one company, both roles.`
            : otherSide
              ? `is already in the CRM as a ${isVendorRelationshipType(duplicate.match.relationshipType) ? "vendor" : relationshipTypeLabels[duplicate.match.relationshipType].toLowerCase()} — a name can only be used once, but it can be a ${wantSide} too.`
              : "is already in the CRM — open it instead of creating a duplicate."}{" "}
          {otherSide && madeBoth !== duplicate.match.id && (
            <button type="button" disabled={pending} onClick={() => addRole(duplicate.match.id)} className="mr-2 font-medium underline underline-offset-2">
              {wantSide === "vendor" ? "Add as a vendor too" : "Add as a customer too"}
            </button>
          )}
          <Link href={`/companies/${duplicate.match.ref}`} className="font-medium underline underline-offset-2">
            Open {duplicate.match.ref} →
          </Link>
          {roleError && <span className="block text-xs">{roleError}</span>}
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
            {slot(w, "Similar names already in the CRM — open one if it's the same company", "company", "Similar names already in the CRM — open one if it's the same {one:lower}")}
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
        current && !duplicate && <p className="text-xs text-subtle">{slot(w, "No matching companies — this will be a new one.", "company", "No matching {many:lower} — this will be a new one.")}</p>
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
