"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import type { AccountType } from "@prisma/client";
import { deleteAccount, saveAccount, type listAccounts } from "@/actions/ledger";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { accountTypeLabels } from "@/lib/ledger/chart";
import { accountTypeTone } from "@/components/accounting/report-chrome";

type Account = Awaited<ReturnType<typeof listAccounts>>[number];

const TYPES: AccountType[] = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

/**
 * The chart of accounts as a tree.
 *
 * Accounts the posting engine depends on are marked and can't be deleted or archived — renaming and
 * renumbering stay open, because those are the business's to choose, but removing the account an
 * invoice posts to would break every future posting silently.
 */
export function ChartManager({ accounts, canEdit }: { accounts: Account[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<Account | "new" | null>(null);

  const byParent = new Map<string | null, Account[]>();
  for (const a of accounts) {
    byParent.set(a.parentId, [...(byParent.get(a.parentId) ?? []), a]);
  }

  const rows: { account: Account; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const a of (byParent.get(parentId) ?? []).sort((x, y) => x.code.localeCompare(y.code))) {
      rows.push({ account: a, depth });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Chart of accounts</h1>
          <p className="mt-1 text-sm text-muted">
            {accounts.filter((a) => !a.isGroup).length} account(s) in {accounts.filter((a) => a.isGroup).length} group(s).
            Groups organise the statements; postings go to the accounts under them.
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => setEditing("new")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New account
          </Button>
        )}
      </div>

      <Card className="mt-5 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Account</th>
              <th className="px-4 py-2.5">Type</th>
              <th className="px-4 py-2.5">Notes</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ account, depth }) => (
              <tr
                key={account.id}
                className={`border-b border-line last:border-0 ${account.isGroup ? "bg-surface-sunken/60" : "hover:bg-surface-sunken"}`}
              >
                <td className="px-4 py-2" style={{ paddingLeft: `${16 + depth * 18}px` }}>
                  <span className="mr-2 font-mono text-xs text-subtle">{account.code}</span>
                  {account.isGroup ? (
                    <span className="font-medium text-text">{account.name}</span>
                  ) : (
                    <Link href={`/accounting/ledger/${account.id}`} className="text-text hover:underline">
                      {account.name}
                    </Link>
                  )}
                  {account.systemKey && (
                    <span title="Used by automatic postings" className="ml-2 inline-flex align-middle text-subtle">
                      <Lock className="h-3 w-3" />
                    </span>
                  )}
                  {!account.active && (
                    <Badge tone="default" className="ml-2">
                      Archived
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-2">
                  <Badge tone={accountTypeTone[account.type]}>{accountTypeLabels[account.type]}</Badge>
                </td>
                <td className="px-4 py-2 text-xs text-subtle">{account.description ?? "—"}</td>
                <td className="px-4 py-2 text-right">
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Edit ${account.name}`}
                      onClick={() => setEditing(account)}
                      className="rounded-base p-1 text-subtle hover:bg-surface-sunken hover:text-text"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {editing && (
        <AccountDialog
          account={editing === "new" ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function AccountDialog({
  account,
  accounts,
  onClose,
}: {
  account: Account | null;
  accounts: Account[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState(account?.code ?? "");
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "EXPENSE");
  const [parentId, setParentId] = useState(account?.parentId ?? "");
  const [isGroup, setIsGroup] = useState(account?.isGroup ?? false);
  const [description, setDescription] = useState(account?.description ?? "");
  const [active, setActive] = useState(account?.active ?? true);

  // An account can't be its own parent, and a group can't be moved under its own descendant.
  const descendants = new Set<string>();
  if (account) {
    const collect = (id: string) => {
      descendants.add(id);
      for (const a of accounts.filter((x) => x.parentId === id)) collect(a.id);
    };
    collect(account.id);
  }
  const parentOptions = accounts.filter((a) => a.isGroup && !descendants.has(a.id));

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveAccount({
        id: account?.id,
        code,
        name,
        type,
        parentId: parentId || undefined,
        isGroup,
        description,
        active,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function remove() {
    if (!account) return;
    if (!confirm(`Delete ${account.code} ${account.name}?`)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteAccount(account.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onClose={onClose} title={account ? `Edit ${account.code}` : "New account"}>
      <div className="space-y-4">
        {account?.systemKey && (
          <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
            Invoices, bills and payments post to this account automatically. You can rename and renumber it — that is
            yours to choose — but it can&apos;t be deleted or archived.
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="acCode">Code</Label>
            <Input id="acCode" value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" placeholder="5250" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="acName">Name</Label>
            <Input id="acName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing" />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="acType">Type</Label>
            <Select id="acType" value={type} onChange={(e) => setType(e.target.value as AccountType)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {accountTypeLabels[t]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acParent">Sits under</Label>
            <Select id="acParent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Top level</option>
              {parentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="acNotes">Notes</Label>
          <Input
            id="acNotes"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What belongs in this account"
          />
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={isGroup} onChange={(e) => setIsGroup(e.target.checked)} />
            This is a group — it organises other accounts and takes no postings
          </label>
          {account && !account.systemKey && (
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} />
              Archived
            </label>
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <Button disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {account && !account.systemKey && (
            <Button variant="ghost" disabled={pending} onClick={remove} className="ml-auto text-danger">
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
