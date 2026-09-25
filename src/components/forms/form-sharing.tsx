"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, UserRound, Users } from "lucide-react";
import type { getFormSharing } from "@/actions/forms";
import { saveFormSharing } from "@/actions/forms";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Select } from "@/components/ui/input";
import { PersonCombobox } from "@/components/ui/person-combobox";
import { ActionNotice } from "@/components/ui/action-notice";

type Sharing = NonNullable<Awaited<ReturnType<typeof getFormSharing>>>;
type Row = {
  userId: string | null;
  roleKey: string | null;
  label: string;
  hint: string | null;
  canEdit: boolean;
  canInvite: boolean;
  canViewResponses: boolean;
};

const SWITCHES = [
  { key: "canEdit", label: "Edit", hint: "Change the questions and settings; open and close it." },
  { key: "canInvite", label: "Invite", hint: "Send invitations to their own customers; record RSVPs." },
  { key: "canViewResponses", label: "See answers", hint: "Read every answer and the attendance register; export them." },
] as const;

/**
 * Who else has this form, and what each of them may do with it.
 *
 * A person or a whole role, one row each. Being on the list at all lets them see the form — its
 * questions, its link, how many have answered — and each switch adds one thing. The switches do not
 * imply one another, so "can build the questions but not read the answers" is one row with one tick.
 *
 * The whole list is saved at once, as it stands on screen.
 */
export function FormSharing({ formId, sharing }: { formId: string; sharing: Sharing }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [rows, setRows] = useState<Row[]>(() =>
    sharing.grants.map((g) => ({
      userId: g.userId,
      roleKey: g.roleKey,
      label: g.user?.name ?? g.role?.name ?? "—",
      hint: g.user ? (g.user.active ? g.user.email : "No longer active") : "Everybody with this role",
      canEdit: g.canEdit,
      canInvite: g.canInvite,
      canViewResponses: g.canViewResponses,
    })),
  );
  const [roleToAdd, setRoleToAdd] = useState("");

  const people = sharing.users.filter((u) => u.id !== sharing.owner?.id && !rows.some((r) => r.userId === u.id));
  const roles = sharing.roles.filter((r) => !rows.some((row) => row.roleKey === r.key));
  const setSwitch = (index: number, key: (typeof SWITCHES)[number]["key"], value: boolean) =>
    setRows((all) => all.map((r, i) => (i === index ? { ...r, [key]: value } : r)));

  const save = () => {
    setNotice(null);
    startTransition(async () => {
      const result = await saveFormSharing(
        formId,
        rows.map(({ userId, roleKey, canEdit, canInvite, canViewResponses }) => ({ userId, roleKey, canEdit, canInvite, canViewResponses })),
      );
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      setNotice({ tone: "success", text: result.data.count === 0 ? "Only you and form admins have this form now." : "Sharing saved." });
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">Who has this form</h2>
        <p className="text-xs text-subtle">
          {sharing.owner?.name ?? "The owner"} owns it and can do everything, as can anybody with &ldquo;Manage every
          form&rdquo;. Everybody listed here can see it; each tick adds one thing they may do.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">Person or role</th>
                <th className="px-2 py-2 text-center font-medium">See</th>
                {SWITCHES.map((s) => (
                  <th key={s.key} className="px-2 py-2 text-center font-medium" title={s.hint}>
                    {s.label}
                  </th>
                ))}
                {sharing.canShare && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line">
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2">
                    <UserRound className="h-3.5 w-3.5 text-muted" aria-hidden />
                    <span className="text-text">{sharing.owner?.name}</span>
                    <span className="text-xs text-subtle">owner</span>
                  </span>
                </td>
                <td colSpan={4} className="px-2 py-2 text-center text-xs text-subtle">
                  Everything
                </td>
                {sharing.canShare && <td />}
              </tr>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-xs text-subtle">
                    Not shared with anybody else.
                  </td>
                </tr>
              )}
              {rows.map((row, index) => (
                <tr key={row.userId ?? `role:${row.roleKey}`} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-2">
                      {row.roleKey ? <Users className="h-3.5 w-3.5 text-muted" aria-hidden /> : <UserRound className="h-3.5 w-3.5 text-muted" aria-hidden />}
                      <span className="min-w-0">
                        <span className="block text-text">{row.label}</span>
                        {row.hint && <span className="block truncate text-xs text-subtle">{row.hint}</span>}
                      </span>
                    </span>
                  </td>
                  <td className="px-2 py-2 text-center text-xs text-success">Yes</td>
                  {SWITCHES.map((s) => (
                    <td key={s.key} className="px-2 py-2 text-center">
                      <Checkbox
                        aria-label={`${s.label} — ${row.label}`}
                        checked={row[s.key]}
                        disabled={!sharing.canShare}
                        onChange={(e) => setSwitch(index, s.key, e.target.checked)}
                      />
                    </td>
                  ))}
                  {sharing.canShare && (
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        aria-label={`Remove ${row.label}`}
                        onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
                        className="rounded p-1 text-muted hover:bg-surface-sunken hover:text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {sharing.canShare ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted">Add a person</div>
                <PersonCombobox
                  people={people}
                  value=""
                  onSelect={(p) => {
                    if (!p) return;
                    setRows((all) => [
                      ...all,
                      { userId: p.id, roleKey: null, label: p.name, hint: p.email ?? null, canEdit: false, canInvite: false, canViewResponses: false },
                    ]);
                  }}
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted">Add everybody with a role</div>
                <Select
                  aria-label="Add everybody with a role"
                  value={roleToAdd}
                  onChange={(e) => {
                    const role = roles.find((r) => r.key === e.target.value);
                    setRoleToAdd("");
                    if (!role) return;
                    setRows((all) => [
                      ...all,
                      { userId: null, roleKey: role.key, label: role.name, hint: "Everybody with this role", canEdit: false, canInvite: false, canViewResponses: false },
                    ]);
                  }}
                >
                  <option value="">Choose a role…</option>
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <ul className="space-y-0.5 text-[11px] text-subtle">
              {SWITCHES.map((s) => (
                <li key={s.key}>
                  <span className="font-medium text-muted">{s.label}</span> — {s.hint}
                </li>
              ))}
            </ul>
            {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
            <div className="flex justify-end">
              <Button size="sm" onClick={save} disabled={pending}>
                {pending ? "Saving…" : "Save sharing"}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-xs text-subtle">Only the owner and form admins can change who has this form.</p>
        )}
      </CardContent>
    </Card>
  );
}
