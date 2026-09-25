"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ArrowLeftRight, CircleAlert } from "lucide-react";
import { findCompanyMatches, type CompanyMatch } from "@/actions/company";
import { mergeCompanies, type MergeScreen } from "@/actions/company-merge";
import { relationshipTypeLabels } from "@/lib/validation/company";
import { normalizeCompanyName } from "@/lib/company-name";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

type Plan = MergeScreen["plan"];
type Side = Plan["keep"];

/** Needs a right of its own to take from the duplicate — see mergeCompanies. */
const NEEDS_REASSIGN = new Set(["ownerUserId", "assignedToUserId"]);

/**
 * The merge screen: which company stays, which details to keep from which, which people to combine,
 * everything that will move — and the duplicate's name typed before anything does.
 */
export function MergeWizard({ screen }: { screen: MergeScreen }) {
  const { plan, may } = screen;
  const router = useRouter();
  const [choices, setChoices] = useState<Record<string, "keep" | "drop">>(() =>
    Object.fromEntries(plan.fields.map((f) => [f.key, allowed(f.key) ? f.suggested : "keep"])),
  );
  const [combine, setCombine] = useState<Set<string>>(() => new Set(plan.contactPairs.map((p) => p.id)));
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function allowed(key: string) {
    if (NEEDS_REASSIGN.has(key)) return may.reassign;
    if (key === "creditLimit") return may.overrideCredit;
    return true;
  }

  const blocked = plan.blockers.length > 0;
  const confirmed = normalizeCompanyName(confirm) === normalizeCompanyName(plan.drop.name) && confirm.trim() !== "";
  const finalName = choices.name === "drop" ? plan.drop.name : plan.keep.name;
  const renamed = finalName === plan.keep.name ? plan.drop : plan.keep;
  const contactName = (s: Side, id: string) => s.contacts.find((c) => c.id === id);
  const moving = plan.moves.reduce((t, m) => t + m.count, 0);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await mergeCompanies({ keepId: plan.keep.id, dropId: plan.drop.id, choices, combine: [...combine], confirmName: confirm });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/companies/${result.data.ref}?merged=${plan.drop.ref}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr]">
        <SideCard side={plan.keep} role="Stays" />
        <div className="flex items-center justify-center">
          <Link
            href={`/companies/merge?keep=${plan.drop.ref}&drop=${plan.keep.ref}`}
            className="inline-flex items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 py-1.5 text-xs text-text hover:bg-surface-sunken"
            title="Keep the other one instead"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />
            Swap
          </Link>
        </div>
        <SideCard side={plan.drop} role="Merged in and removed" />
      </div>

      {blocked ? (
        <div className="space-y-2">
          {plan.blockers.map((b) => (
            <ActionNotice key={b} tone="error">
              {b}
            </ActionNotice>
          ))}
        </div>
      ) : (
        <>
          <Card>
            <CardHeader className="text-sm font-semibold text-text">Details — pick which to keep</CardHeader>
            <CardContent className="space-y-2">
              {plan.fields.length === 0 ? (
                <p className="text-sm text-muted">Every detail is the same on both.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th className="py-1.5 pr-3 font-medium">Detail</th>
                        <th className="py-1.5 pr-3 font-medium">{plan.keep.ref}</th>
                        <th className="py-1.5 font-medium">{plan.drop.ref}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.fields.map((f) => (
                        <tr key={f.key} className="border-t border-line align-top">
                          <td className="py-2 pr-3 text-muted">{f.label}</td>
                          {(["keep", "drop"] as const).map((s) => {
                            const disabled = s === "drop" && !allowed(f.key);
                            return (
                              <td key={s} className="py-2 pr-3">
                                <label className={`flex items-start gap-2 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
                                  <input
                                    type="radio"
                                    name={`field-${f.key}`}
                                    className="mt-1"
                                    checked={choices[f.key] === s}
                                    disabled={disabled}
                                    onChange={() => setChoices((c) => ({ ...c, [f.key]: s }))}
                                  />
                                  <span className={f[s] ? "text-text" : "text-subtle"}>{f[s] ?? "—"}</span>
                                </label>
                                {disabled && (
                                  <p className="ml-5 mt-0.5 text-xs text-subtle">
                                    {f.key === "creditLimit" ? "Needs the right to set credit limits." : "Needs the right to reassign accounts."}
                                  </p>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-subtle">
                Tags from both are kept. Longer payment terms than the credit record supports are checked as they are when editing.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-semibold text-text">People in both</CardHeader>
            <CardContent className="space-y-2">
              {plan.contactPairs.length === 0 ? (
                <p className="text-sm text-muted">
                  Nobody appears under both. All {plan.drop.contacts.length} of {plan.drop.ref}&apos;s contacts move across as they are.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted">
                    Combined into one contact under {plan.keep.ref}: their calls, visits, tickets, leads and consent move to it, and an unsubscribe on
                    either side stays. Untick anybody who is really two people.
                  </p>
                  <ul className="divide-y divide-line rounded-base border border-line">
                    {plan.contactPairs.map((p) => {
                      const a = contactName(plan.keep, p.keepId);
                      const b = contactName(plan.drop, p.dropId);
                      return (
                        <li key={p.id}>
                          <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 text-sm">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={combine.has(p.id)}
                              onChange={(e) =>
                                setCombine((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(p.id);
                                  else next.delete(p.id);
                                  return next;
                                })
                              }
                            />
                            <span className="min-w-0">
                              <span className="font-medium text-text">{a?.name}</span>
                              <span className="text-subtle"> and </span>
                              <span className="font-medium text-text">{b?.name}</span>
                              <span className="block text-xs text-subtle">
                                {p.reason}
                                {a?.email || a?.phone ? ` · ${[a?.email, a?.phone].filter(Boolean).join(" · ")}` : ""}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-semibold text-text">What moves to {plan.keep.ref}</CardHeader>
            <CardContent className="space-y-3">
              {plan.moves.length === 0 ? (
                <p className="text-sm text-muted">Nothing is recorded under {plan.drop.ref} — only the company itself is removed.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {plan.moves.map((m) => (
                    <li key={m.key} className="rounded-full border border-line bg-surface-sunken px-2.5 py-0.5 text-xs text-text">
                      {m.label} <span className="font-semibold tabular-nums">{m.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              {plan.clashes.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Where only one can stay</p>
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted">
                    {plan.clashes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
              {renamed.issuedDocuments > 0 && (
                <p className="text-sm text-muted">
                  {renamed.issuedDocuments} quote{renamed.issuedDocuments === 1 ? "" : "s"} and invoice{renamed.issuedDocuments === 1 ? "" : "s"} already issued
                  to &ldquo;{renamed.name}&rdquo; keep printing that name — an issued invoice stays the invoice that was sent.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="border-danger/40">
            <CardContent className="space-y-3 pt-4">
              <p className="flex items-start gap-2 text-sm text-text">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                <span>
                  {moving > 0 ? `${moving} record${moving === 1 ? "" : "s"} move` : "Nothing moves"} and {plan.drop.ref} {plan.drop.name} is removed.
                  Its old links will open {finalName}. <strong>This can&apos;t be undone.</strong>
                </span>
              </p>
              <div className="max-w-md space-y-1">
                <Label htmlFor="merge-confirm">Type &ldquo;{plan.drop.name}&rdquo; to confirm</Label>
                <Input id="merge-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
              </div>
              {error && <ActionNotice tone="error">{error}</ActionNotice>}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="danger" disabled={!confirmed || pending} onClick={submit}>
                  {pending ? "Merging…" : `Merge into ${plan.keep.ref}`}
                </Button>
                <Link href={`/companies/${plan.keep.ref}`} className="text-sm text-muted hover:text-text">
                  Cancel
                </Link>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function SideCard({ side, role }: { side: Side; role: string }) {
  const stays = role === "Stays";
  return (
    <Card className={stays ? "border-success/40" : "border-danger/30"}>
      <CardContent className="space-y-1 pt-4">
        <p className={`text-xs font-semibold uppercase tracking-wide ${stays ? "text-success" : "text-danger"}`}>{role}</p>
        <Link href={`/companies/${side.ref}`} className="block text-base font-semibold text-text hover:underline">
          {side.name}
        </Link>
        <p className="text-xs text-muted">
          <span className="font-mono">{side.ref}</span> · {side.kind}
          {side.place ? ` · ${side.place}` : ""}
        </p>
        <p className="text-xs text-muted">
          {side.accountManager ? `Account manager ${side.accountManager}` : "No account manager"} · {side.contacts.length} contact
          {side.contacts.length === 1 ? "" : "s"}
        </p>
        {side.gstins.length > 0 && <p className="font-mono text-xs text-subtle">GSTIN {side.gstins.join(", ")}</p>}
      </CardContent>
    </Card>
  );
}

/** Picking the other company, when the merge was started from one company's page. */
export function MergePartnerPicker({ keepRef, keepName, keepId }: { keepRef: string; keepName: string; keepId: string }) {
  const [typed, setTyped] = useState("");
  const [matches, setMatches] = useState<{ key: string; list: CompanyMatch[] } | null>(null);
  const query = typed.trim();

  useEffect(() => {
    if (!query) return;
    let live = true;
    const timer = setTimeout(() => {
      findCompanyMatches(query)
        .then((data) => {
          if (live) setMatches({ key: query, list: data.matches.filter((m) => m.id !== keepId) });
        })
        .catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, keepId]);

  const list = query && matches ? matches.list : [];
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <p className="text-sm text-text">
          Which company is a duplicate of <span className="font-semibold">{keepName}</span>? It will be merged into {keepRef} and removed — you&apos;ll see
          everything that moves before anything does.
        </p>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type part of the duplicate's name…" autoFocus />
        {list.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-base border border-line">
            {list.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/companies/merge?keep=${keepRef}&drop=${m.ref}`}
                  className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm text-text hover:bg-surface-sunken"
                >
                  <span className="min-w-0 truncate">{m.name}</span>
                  <span className="shrink-0 text-xs text-subtle">
                    {[m.city, relationshipTypeLabels[m.relationshipType], m.owner].filter(Boolean).join(" · ")} · <span className="font-mono">{m.ref}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {query && matches?.key === query && list.length === 0 && <p className="text-xs text-subtle">No other company you can see has a name like that.</p>}
      </CardContent>
    </Card>
  );
}
