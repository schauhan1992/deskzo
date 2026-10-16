"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { accessPreview, type ModulePreview } from "@/actions/person-access";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import type { ModuleStanding } from "@/lib/staff/access-modules";

const TONE: Record<ModuleStanding, "green" | "amber" | "red"> = { full: "green", limited: "amber", none: "red" };
const WORDS: Record<ModuleStanding, string> = { full: "Full access", limited: "Limited", none: "No access" };

/**
 * "Permission preview": each module, and how much of it is had — by a role on its own, or by one of
 * its people as they actually resolve (their exceptions included). Read from the same resolver and
 * record engine every check uses (`accessPreview`).
 */
export function AccessPreview({
  title = "Permission preview",
  role,
  people,
  initial,
  fixedUserId,
}: {
  title?: string;
  /** A role: preview what it grants, or one of `people` holding it. */
  role?: string;
  people?: { id: string; name: string }[];
  initial: ModulePreview[] | null;
  /** One person, nothing to choose. */
  fixedUserId?: string;
}) {
  const [who, setWho] = useState<string>("");
  const [rows, setRows] = useState<ModulePreview[] | null>(initial);
  useEffect(() => {
    if (fixedUserId || !role) return;
    let live = true;
    accessPreview(who ? { userId: who } : { role }).then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, [who, role, fixedUserId]);

  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        <p className="mt-0.5 text-xs text-muted">{fixedUserId ? "What they can reach, module by module, from everything that applies to them." : "What this role can reach — or one of its people, exceptions included."}</p>
        {!fixedUserId && people && people.length > 0 && (
          <Select aria-label="Preview as" value={who} onChange={(e) => setWho(e.target.value)} className="mt-2 h-8 text-sm">
            <option value="">The role itself</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </CardHeader>
      <CardContent>
        {rows === null ? (
          <p className="text-sm text-subtle">Loading…</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.key} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-text">{r.label}</span>
                <Badge tone={TONE[r.standing]}>{WORDS[r.standing]}</Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 flex gap-1.5 text-[11px] text-subtle">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          Full: every action and record of the module. Limited: some. The plan and the company&apos;s module switches still decide what exists at all.
        </p>
      </CardContent>
    </Card>
  );
}
