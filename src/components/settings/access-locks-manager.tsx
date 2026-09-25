"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Lock, Unlock } from "lucide-react";
import { lockCompany, lockUser, unlockCompany, unlockUser } from "@/actions/access-lock";
import { COMPANY_LOCK_PHRASE, DEFAULT_LOCK_MESSAGE, LOCK_MESSAGE_MAX } from "@/lib/access/lock-rules";
import { formatIstDateTime } from "@/lib/india-time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

export type AccessLocksView = {
  isSuperAdmin: boolean;
  company: { enabled: boolean; active: boolean; message: string | null; until: Date | null; lockedAt: Date | null; lockedBy: string | null } | null;
  people: {
    id: string;
    name: string;
    email: string;
    role: string;
    active: boolean;
    lockedAt: Date | null;
    lockedUntil: Date | null;
    lockMessage: string | null;
    lockedBy: string | null;
  }[];
  candidates: { id: string; name: string; email: string; role: string }[];
};

export function AccessLocksManager({ view }: { view: AccessLocksView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const [person, setPerson] = useState("");
  const [personMessage, setPersonMessage] = useState("");
  const [personUntil, setPersonUntil] = useState("");

  const [companyMessage, setCompanyMessage] = useState("");
  const [companyUntil, setCompanyUntil] = useState("");
  const [confirm, setConfirm] = useState("");

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string, reset?: () => void) {
    setNotice(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      reset?.();
      setNotice({ tone: "success", text: done });
      router.refresh();
    });
  }

  const companyActive = view.company?.active === true;
  const chosen = view.candidates.find((c) => c.id === person);

  return (
    <div className="space-y-4">
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

      <Card className={companyActive ? "border-danger/50" : ""}>
        <CardHeader className="flex items-center gap-2 text-sm font-semibold text-text">
          <Lock className="h-4 w-4" aria-hidden="true" /> Lock the whole company
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {companyActive ? (
            <div className="space-y-2">
              <p className="font-medium text-danger">The whole company is locked. Everybody but the super admin sees only the notice.</p>
              <p className="whitespace-pre-line rounded-base border border-line bg-surface-sunken px-3 py-2 text-text">{view.company?.message || DEFAULT_LOCK_MESSAGE}</p>
              <p className="text-xs text-subtle">
                Locked{view.company?.lockedBy ? ` by ${view.company.lockedBy}` : ""}
                {view.company?.lockedAt ? ` on ${formatIstDateTime(view.company.lockedAt)}` : ""}
                {view.company?.until ? ` · lifts itself ${formatIstDateTime(view.company.until)}` : " · until lifted"}
              </p>
              {view.isSuperAdmin && (
                <Button variant="secondary" disabled={pending} onClick={() => run(() => unlockCompany(), "The company lock is lifted — everybody can use the CRM again.")}>
                  <Unlock className="h-4 w-4" /> Lift the company lock
                </Button>
              )}
            </div>
          ) : view.isSuperAdmin ? (
            <div className="space-y-3">
              <p className="text-muted">
                Everybody except you can still sign in, and sees only this notice until you lift the lock or the time you set passes. Use it for a payment
                hold, an audit, or a pause while something is sorted out.
              </p>
              <div className="space-y-1">
                <Label htmlFor="company-message">Notice everybody sees</Label>
                <Textarea id="company-message" rows={3} maxLength={LOCK_MESSAGE_MAX} value={companyMessage} onChange={(e) => setCompanyMessage(e.target.value)} placeholder={DEFAULT_LOCK_MESSAGE} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="company-until">Lifts itself at (optional, India time)</Label>
                  <Input id="company-until" type="datetime-local" value={companyUntil} onChange={(e) => setCompanyUntil(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="company-confirm">Type {COMPANY_LOCK_PHRASE} to confirm</Label>
                  <Input id="company-confirm" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </div>
              </div>
              <Button
                variant="danger"
                disabled={pending || confirm.trim().toUpperCase() !== COMPANY_LOCK_PHRASE}
                onClick={() =>
                  run(
                    () => lockCompany({ message: companyMessage, until: companyUntil, confirm }),
                    "The whole company is locked. Everybody but you now sees only the notice.",
                    () => setConfirm(""),
                  )
                }
              >
                <Lock className="h-4 w-4" /> Lock the whole company
              </Button>
            </div>
          ) : (
            <p className="text-muted">Only the super admin can lock the whole company.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center gap-2 text-sm font-semibold text-text">
          <Lock className="h-4 w-4" aria-hidden="true" /> Lock one person
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted">They can still sign in, and see only your notice — every page, every action, every screen they had open.</p>
          <div className="space-y-1">
            <Label htmlFor="lock-person">Person</Label>
            <Select id="lock-person" value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">Choose somebody…</option>
              {view.candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.role.toLowerCase()} · {c.email}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lock-message">Notice they see</Label>
            <Textarea id="lock-message" rows={3} maxLength={LOCK_MESSAGE_MAX} value={personMessage} onChange={(e) => setPersonMessage(e.target.value)} placeholder={DEFAULT_LOCK_MESSAGE} />
          </div>
          <div className="max-w-xs space-y-1">
            <Label htmlFor="lock-until">Lifts itself at (optional, India time)</Label>
            <Input id="lock-until" type="datetime-local" value={personUntil} onChange={(e) => setPersonUntil(e.target.value)} />
          </div>
          <Button
            variant="danger"
            disabled={pending || !person}
            onClick={() =>
              run(
                () => lockUser({ userId: person, message: personMessage, until: personUntil }),
                `${chosen?.name ?? "They"} can no longer use the CRM — they see only your notice.`,
                () => {
                  setPerson("");
                  setPersonMessage("");
                  setPersonUntil("");
                },
              )
            }
          >
            <Lock className="h-4 w-4" /> Lock {chosen ? chosen.name : "them"}
          </Button>
        </CardContent>
      </Card>

      <Card className="overflow-x-auto p-0">
        <CardHeader className="text-sm font-semibold text-text">Locked people</CardHeader>
        {view.people.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">Nobody is locked.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-y border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Person</th>
                <th className="px-4 py-2">Notice</th>
                <th className="px-4 py-2">Since</th>
                <th className="px-4 py-2">Until</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {view.people.map((p) => (
                <tr key={p.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-2">
                    <p className="text-text">{p.name}</p>
                    <p className="text-xs text-subtle">{p.email}</p>
                    {!p.active && <p className="text-xs text-success">Lifted — the time passed</p>}
                  </td>
                  <td className="max-w-xs px-4 py-2 text-xs text-muted">{p.lockMessage || "The standard notice"}</td>
                  <td className="px-4 py-2 text-xs text-muted">
                    {p.lockedAt ? formatIstDateTime(p.lockedAt) : ""}
                    {p.lockedBy ? <span className="block">by {p.lockedBy}</span> : null}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted">{p.lockedUntil ? formatIstDateTime(p.lockedUntil) : "Until unlocked"}</td>
                  <td className="px-4 py-2 text-right">
                    <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => unlockUser(p.id), `${p.name} can use the CRM again.`)}>
                      <Unlock className="h-3.5 w-3.5" /> Unlock
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
