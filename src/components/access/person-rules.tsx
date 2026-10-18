"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { removePersonDeviceRule, savePersonDeviceRule, type DeviceSay, type PersonDeviceRule } from "@/actions/access-control";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";

type Kinds = PersonDeviceRule["own"];
type Kind = keyof Kinds;

const KINDS: { key: Kind; label: string }[] = [
  { key: "allowMobile", label: "Phone" },
  { key: "allowTablet", label: "Tablet" },
  { key: "allowComputer", label: "Laptop / desktop" },
];

const NONE: Kinds = { allowMobile: null, allowTablet: null, allowComputer: null };

/**
 * One person's own say on each kind of device, over their role's (owner, 18 Oct 2026): allowed, not allowed, or as
 * their role says — on the web and in the Deskzo app alike. A row is saved on its own, as a role's is.
 */
export function PersonRules({ rows, people }: { rows: PersonDeviceRule[]; people: PersonOption[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState<PersonOption | null>(null);
  const taken = new Set(rows.map((r) => r.userId));

  return (
    <div className="space-y-3">
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-3 py-2 font-medium">Person</th>
              {KINDS.map((k) => (
                <th key={k.key} className="px-2 py-2 font-medium">
                  {k.label}
                </th>
              ))}
              <th className="w-40" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <PersonRow key={row.userId} row={row} />
            ))}
            {adding && (
              <PersonRow
                key={`new-${adding.id}`}
                row={null}
                person={adding}
                onDone={() => {
                  setAdding(null);
                  router.refresh();
                }}
              />
            )}
            {rows.length === 0 && !adding && (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-muted">
                  Nobody has a rule of their own — everybody follows their role.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <div className="max-w-sm">
        <PersonCombobox
          people={people.filter((p) => !taken.has(p.id))}
          value={adding?.id ?? ""}
          onSelect={(p) => setAdding(p)}
          placeholder="Add a person — search by name or email…"
        />
      </div>
      <p className="text-[11px] text-subtle">
        A person&apos;s own rule wins over their role&apos;s, either way — allowed a phone their role isn&apos;t, or kept off one it is. It
        applies on the website and in the Deskzo app. The super admin is never held by one.
      </p>
    </div>
  );
}

function PersonRow({ row, person, onDone }: { row: PersonDeviceRule | null; person?: PersonOption; onDone?: () => void }) {
  const router = useRouter();
  const start = row?.own ?? NONE;
  const [own, setOwn] = useState<Kinds>(start);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const dirty = !row || JSON.stringify(own) !== JSON.stringify(start);
  const name = row?.name ?? person?.name ?? "";
  const userId = row?.userId ?? person?.id ?? "";

  const value = (v: DeviceSay) => (v === null ? "" : v ? "yes" : "no");
  const read = (v: string): DeviceSay => (v === "yes" ? true : v === "no" ? false : null);

  function run(work: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setNotice(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) setNotice({ tone: "error", text: result.error ?? "That didn't work." });
      else {
        setNotice({ tone: "success", text: done });
        if (onDone) onDone();
        else router.refresh();
      }
    });
  }

  return (
    <>
      <tr className="border-b border-line align-middle last:border-0">
        <td className="px-3 py-2">
          <div className="font-medium text-text">
            {name}
            {row && !row.active && <span className="ml-1 text-[11px] font-normal text-subtle">(deactivated)</span>}
          </div>
          <div className="text-[11px] text-subtle">
            {row ? `${row.email} · ${row.roleName}` : (person?.email ?? "")}
          </div>
        </td>
        {KINDS.map((k) => (
          <td key={k.key} className="px-2 py-2">
            <Select aria-label={`${k.label} — ${name}`} value={value(own[k.key])} onChange={(e) => setOwn((o) => ({ ...o, [k.key]: read(e.target.value) }))}>
              <option value="">{row ? `As role (${row.role[k.key] ? "allowed" : "not allowed"})` : "As role"}</option>
              <option value="yes">Allowed</option>
              <option value="no">Not allowed</option>
            </Select>
          </td>
        ))}
        <td className="space-x-1 px-3 py-2 text-right whitespace-nowrap">
          <Button size="sm" variant={dirty ? "primary" : "secondary"} disabled={!dirty || pending} onClick={() => run(() => savePersonDeviceRule(userId, own), `Saved for ${name}.`)}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {row ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => removePersonDeviceRule(userId), `${name} follows their role again.`)}>
              Remove
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={pending} onClick={onDone}>
              Cancel
            </Button>
          )}
        </td>
      </tr>
      {notice && (
        <tr>
          <td colSpan={5} className="px-3 pb-2">
            <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>
          </td>
        </tr>
      )}
    </>
  );
}
