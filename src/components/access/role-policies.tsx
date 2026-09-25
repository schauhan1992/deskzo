"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { UnknownNetworkAction } from "@prisma/client";
import { saveRolePolicy } from "@/actions/access-control";
import type { RolePolicy } from "@/lib/access/decide";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

type Row = { roleKey: string; name: string; people: number; policy: RolePolicy };

const NETWORK: { key: UnknownNetworkAction; label: string; hint: string }[] = [
  { key: "ALLOW", label: "Allow", hint: "Let them in; the address is recorded." },
  { key: "ALERT", label: "Allow and tell me", hint: "Let them in; security admins are told the first time an address is seen." },
  { key: "HOLD", label: "Hold for approval", hint: "Stop them until an admin allows the address." },
  { key: "BLOCK", label: "Approved networks only", hint: "Only addresses with an allow rule. Nothing to approve — add a rule." },
];

/**
 * The rules, one row per role. Saved a row at a time, because each row is a different set of people
 * and "saved" should mean the row you just changed.
 */
export function RolePolicies({ rows }: { rows: Row[] }) {
  return (
    <div className="space-y-3">
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-2 py-2 text-center font-medium">Phone</th>
              <th className="px-2 py-2 text-center font-medium">Tablet</th>
              <th className="px-2 py-2 text-center font-medium">Laptop / desktop</th>
              <th className="px-2 py-2 text-center font-medium">New devices need approval</th>
              <th className="px-2 py-2 font-medium">Unknown network</th>
              <th className="px-2 py-2 text-center font-medium">Location at sign-in</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <PolicyRow key={row.roleKey} row={row} />
            ))}
          </tbody>
        </table>
      </Card>
      <ul className="space-y-0.5 text-[11px] text-subtle">
        {NETWORK.map((n) => (
          <li key={n.key}>
            <span className="font-medium text-muted">{n.label}</span> — {n.hint}
          </li>
        ))}
        <li>
          <span className="font-medium text-muted">Device type</span> is what the browser says it is. That holds for normal use; a
          determined person can make a phone claim to be a laptop. Approval is the control that doesn&apos;t rely on the browser&apos;s word.
        </li>
        <li>
          <span className="font-medium text-muted">Location</span> is asked for once at each sign-in, from the device, and a
          determined person can fake it too — it is a record, not proof.
        </li>
      </ul>
    </div>
  );
}

function PolicyRow({ row }: { row: Row }) {
  const router = useRouter();
  const [policy, setPolicy] = useState<RolePolicy>(row.policy);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const dirty = JSON.stringify(policy) !== JSON.stringify(row.policy);
  const set = <K extends keyof RolePolicy>(key: K, value: RolePolicy[K]) => setPolicy((p) => ({ ...p, [key]: value }));
  const box = (key: "allowMobile" | "allowTablet" | "allowComputer" | "requireDeviceApproval" | "requireLocation", label: string) => (
    <td className="px-2 py-2 text-center">
      <Checkbox aria-label={`${label} — ${row.name}`} checked={policy[key]} onChange={(e) => set(key, e.target.checked)} />
    </td>
  );

  return (
    <>
      <tr className="border-b border-line align-middle last:border-0">
        <td className="px-3 py-2">
          <div className="font-medium text-text">{row.name}</div>
          <div className="text-[11px] text-subtle">
            {row.people} {row.people === 1 ? "person" : "people"}
          </div>
        </td>
        {box("allowMobile", "Phone")}
        {box("allowTablet", "Tablet")}
        {box("allowComputer", "Laptop or desktop")}
        {box("requireDeviceApproval", "New devices need approval")}
        <td className="px-2 py-2">
          <Select aria-label={`Unknown network — ${row.name}`} value={policy.unknownNetwork} onChange={(e) => set("unknownNetwork", e.target.value as UnknownNetworkAction)}>
            {NETWORK.map((n) => (
              <option key={n.key} value={n.key}>
                {n.label}
              </option>
            ))}
          </Select>
        </td>
        {box("requireLocation", "Location at sign-in")}
        <td className="px-3 py-2 text-right">
          <Button
            size="sm"
            variant={dirty ? "primary" : "secondary"}
            disabled={!dirty || pending}
            onClick={() => {
              setNotice(null);
              startTransition(async () => {
                const result = await saveRolePolicy(row.roleKey, policy);
                if (!result.ok) setNotice({ tone: "error", text: result.error });
                else {
                  setNotice({ tone: "success", text: `Saved for ${row.name}.` });
                  router.refresh();
                }
              });
            }}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </td>
      </tr>
      {notice && (
        <tr>
          <td colSpan={8} className="px-3 pb-2">
            <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>
          </td>
        </tr>
      )}
    </>
  );
}
