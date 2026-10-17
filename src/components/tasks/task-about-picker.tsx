"use client";

import { useEffect, useState } from "react";
import { Building2, LifeBuoy, Target, X } from "lucide-react";
import { searchRecords, searchScopesForMe } from "@/actions/search";
import { Input, Select } from "@/components/ui/input";

export type AboutKind = "company" | "lead" | "ticket";
export type About = { kind: AboutKind; id: string; label: string };

const KINDS: { kind: AboutKind; scope: string; label: string; icon: typeof Building2 }[] = [
  { kind: "company", scope: "companies", label: "Company", icon: Building2 },
  { kind: "lead", scope: "leads", label: "Lead", icon: Target },
  { kind: "ticket", scope: "tickets", label: "Ticket", icon: LifeBuoy },
];

/** The ids a task is linked by, from what was picked — none picked, all empty. */
export function aboutIds(about: About | null) {
  return { companyId: about?.kind === "company" ? about.id : "", leadId: about?.kind === "lead" ? about.id : "", ticketId: about?.kind === "ticket" ? about.id : "" };
}

/**
 * What a task is about (owner, 17 Oct 2026): a company, a lead or a ticket, found by the header search's
 * own scopes (src/actions/search.ts) — so only the kinds this person may search are offered, and only
 * records they can see come back. The server checks the pick again (src/actions/task.ts, aboutLink).
 */
export function TaskAboutPicker({ value, onChange, disabled }: { value: About | null; onChange: (about: About | null) => void; disabled?: boolean }) {
  // Null until known which kinds this person may search.
  const [kinds, setKinds] = useState<typeof KINDS | null>(null);
  const [kind, setKind] = useState<AboutKind>("company");
  const [query, setQuery] = useState("");
  // Results remember what they were for: while the box says something else, they're being looked up.
  const [found, setFound] = useState<{ key: string; hits: { id: string; title: string; subtitle: string | null }[] }>({ key: "", hits: [] });
  const key = `${kind}:${query.trim()}`;
  const searching = found.key !== key;
  const hits = searching ? [] : found.hits;

  useEffect(() => {
    let live = true;
    searchScopesForMe()
      .then((scopes) => {
        if (!live) return;
        const allowed = KINDS.filter((k) => scopes.some((s) => s.key === k.scope));
        setKinds(allowed);
        if (allowed[0] && !allowed.some((k) => k.kind === kind)) setKind(allowed[0].kind);
      })
      // Not known: nothing offered, rather than a broken form.
      .catch(() => {
        if (live) setKinds([]);
      });
    return () => {
      live = false;
    };
    // Once: which kinds this person may search doesn't change while the form is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let live = true;
    const scope = KINDS.find((k) => k.kind === kind)!.scope;
    const timer = setTimeout(() => {
      searchRecords(scope, q)
        .then((result) => {
          if (live) setFound({ key: `${kind}:${q}`, hits: result.ok ? result.hits.slice(0, 8) : [] });
        })
        .catch(() => {
          if (live) setFound({ key: `${kind}:${q}`, hits: [] });
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, kind]);

  if (value) {
    const Icon = KINDS.find((k) => k.kind === value.kind)!.icon;
    return (
      <div className="flex items-center gap-2 rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm">
        <Icon className="h-4 w-4 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 truncate text-text">{value.label}</span>
        <button type="button" aria-label="Not about this" onClick={() => onChange(null)} disabled={disabled} className="text-subtle hover:text-danger">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
  if (kinds === null) return <p className="text-sm text-subtle">Loading…</p>;
  if (kinds.length === 0) return <p className="text-sm text-subtle">Nothing you can link a task to.</p>;

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Select aria-label="About a" value={kind} onChange={(e) => setKind(e.target.value as AboutKind)} disabled={disabled} className="w-32 shrink-0">
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Search for it"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${KINDS.find((k) => k.kind === kind)!.label.toLowerCase()} by name or reference…`}
          disabled={disabled}
        />
      </div>
      {query.trim().length >= 2 && (
        <ul className="max-h-48 overflow-y-auto rounded-base border border-line">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-sunken"
                onClick={() => {
                  onChange({ kind, id: h.id, label: h.subtitle ? `${h.title} · ${h.subtitle}` : h.title });
                  setQuery("");
                }}
              >
                <span className="text-text">{h.title}</span>
                {h.subtitle && <span className="ml-2 text-xs text-subtle">{h.subtitle}</span>}
              </button>
            </li>
          ))}
          {hits.length === 0 && <li className="px-3 py-2 text-sm text-subtle">{searching ? "Searching…" : "Nothing found."}</li>}
        </ul>
      )}
    </div>
  );
}
