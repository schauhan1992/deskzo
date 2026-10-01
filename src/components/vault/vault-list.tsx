"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Copy, Eye, EyeOff, History, KeyRound, LifeBuoy, Pencil, Pin, PinOff, Plus, RefreshCw, Share2, Trash2, TriangleAlert } from "lucide-react";
import type { VaultAccessLevel, VaultField } from "@prisma/client";
import {
  credentialTrail,
  revealSecret,
  saveCredential,
  setCredentialPin,
  shareCredential,
  unshareCredential,
  type TrailEntry,
  type VaultRow,
} from "@/actions/vault";
import { accessLevelLabels, revealViaLabels } from "@/lib/vault/policy";
import {
  DEFAULT_PASSWORD_OPTIONS,
  MIN_LENGTH,
  generatePassword,
  strengthOf,
  type PasswordOptions,
} from "@/lib/vault/password";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { Avatar, AvatarStack } from "@/components/ui/avatar";
import { VaultTable, OwnershipBadge } from "@/components/vault/vault-table";
import { ArchiveDialog } from "@/components/vault/archive-dialog";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import type { ViewMode } from "@/lib/view-mode";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";
import { formatDate, formatDateTime } from "@/lib/utils";

type Options = {
  categories: { id: string; name: string }[];
  accessTypes: { id: string; name: string }[];
  users: { id: string; name: string; email: string | null; photoUpdatedAt: Date | string | null }[];
  departments: { id: string; name: string }[];
  companies: { id: string; name: string }[];
};

/**
 * The vault.
 *
 * No secret is on this page. Not in a hidden input, not in a data attribute, not behind a CSS
 * blur — it is not in the response at all. Opening one is a round trip that costs the viewer their
 * own password, and what comes back lives in component state until the box closes.
 *
 * Nothing is copied to the clipboard automatically. A clipboard is readable by every other page the
 * person has open, and a convenience that quietly broadcasts the registrar password is not one.
 */
export function VaultList({
  rows,
  options,
  pinnedCount,
  expiringCount,
  total,
  mode,
}: {
  rows: VaultRow[];
  options: Options;
  pinnedCount: number;
  expiringCount: number;
  total: number;
  mode: ViewMode;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<VaultRow | "new" | null>(null);
  const [opening, setOpening] = useState<{ row: VaultRow; field: VaultField } | null>(null);
  const [sharing, setSharing] = useState<VaultRow | null>(null);
  const [trailFor, setTrailFor] = useState<VaultRow | null>(null);
  const [deleting, setDeleting] = useState<VaultRow | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        {/* Why the order is what it is, said once, so nobody has to work it out from the rows. */}
        <p className="text-xs text-subtle">
          {total} record{total === 1 ? "" : "s"}
          {expiringCount > 0 && ` · ${expiringCount} expiring first`}
          {pinnedCount > 0 && ` · ${pinnedCount} pinned`}
        </p>
        <Button onClick={() => setEditing("new")}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add a credential
        </Button>
      </div>

      {mode === "list" ? (
        /* The same rows and the same dialogs — only the layout differs, so opening a password
           from the grid is the identical round trip it is from a card. */
        <VaultTable
          rows={rows}
          onOpen={(row, field) => setOpening({ row, field })}
          onShare={setSharing}
          onTrail={setTrailFor}
        />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">
            Nothing here yet — add your first login, or ask a colleague to share one with you.
          </CardContent>
        </Card>
      ) : (
        rows.map((r) => (
          <Card key={r.id}>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {/*
                      The pin replaces the key on a pinned row rather than sitting beside it. The
                      button in the action bar says what clicking does; this says what the row is,
                      and somebody scanning a page of twenty-five needs to see that without
                      reading the buttons.
                    */}
                    {r.expiringSoon ? (
                      <CalendarClock className="h-4 w-4 shrink-0 text-danger" aria-label="Billing expiring" />
                    ) : r.pinned ? (
                      <Pin className="h-4 w-4 shrink-0 fill-brand text-brand" aria-label="Pinned" />
                    ) : (
                      <KeyRound className="h-4 w-4 shrink-0 text-muted" />
                    )}
                    <span className="text-sm font-medium text-text">{r.loginName}</span>
                    {r.category && <Badge tone="blue">{r.category}</Badge>}
                    {r.accessType && <Badge tone="default">{r.accessType}</Badge>}
                    {/* Only when it is a client's. "Ours" is the overwhelming majority and a chip
                        on every row would say nothing while crowding out the ones that do. */}
                    <OwnershipBadge row={r} />
                    {/* Said on the card, not buried: somebody about to use an override should know
                        that is what they are doing before they do it. */}
                    {r.via === "ADMIN" && <Badge tone="amber">Admin override — the owner will be told</Badge>}
                  </div>

                  <div className="mt-1 space-y-0.5 text-xs text-muted">
                    {(r.username || r.email) && <div>{[r.username, r.email].filter(Boolean).join(" · ")}</div>}
                    {/* Shown, never linked. A stored URL is untrusted text as far as this page is
                        concerned, and one click is all a phishing target needs. */}
                    {r.loginUrl && <div className="break-all">{r.loginUrl}</div>}
                    {r.phone && <div>2FA to {r.phone}</div>}

                  </div>

                  {r.remarks && <p className="mt-1 text-xs text-subtle">{r.remarks}</p>}

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {r.rotation.state === "overdue" && (
                      <span className="flex items-center gap-1 text-danger">
                        <TriangleAlert className="h-3 w-3" />
                        Password {Math.abs(r.rotation.daysUntilDue!)} days overdue for a change
                      </span>
                    )}
                    {r.rotation.state === "due" && (
                      <span className="text-warning">Change due in {r.rotation.daysUntilDue} days</span>
                    )}
                    {r.rotation.state === "unknown" && <span className="text-subtle">Never changed here</span>}
                    {/* Why it is due, when something other than the standing policy decided. */}
                    {r.rotation.reason && <span className="text-warning">{r.rotation.reason}</span>}
                    {r.rotation.state === "fine" && r.passwordChangedAt && (
                      <span className="text-subtle">Changed {formatDate(new Date(r.passwordChangedAt))}</span>
                    )}
                    {r.daysToExpiry !== null && (
                      <span className={r.daysToExpiry < 30 ? "text-warning" : "text-subtle"}>
                        {/* Zero days is today, not "in 0d" — which is the day it matters most. */}
                        Billing{" "}
                        {r.daysToExpiry < 0
                          ? `expired ${Math.abs(r.daysToExpiry)} days ago`
                          : r.daysToExpiry === 0
                            ? "expires today"
                            : `expires in ${r.daysToExpiry} day${r.daysToExpiry === 1 ? "" : "s"}`}
                      </span>
                    )}
                    {r.reusedOn > 0 && (
                      <span className="text-warning">
                        Same password on {r.reusedOn} other record{r.reusedOn === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setOpening({ row: r, field: "PASSWORD" })}>
                    <Eye className="mr-1.5 h-3.5 w-3.5" />
                    Password
                  </Button>
                  {r.hasRecoveryKey && (
                    <Button size="sm" variant="ghost" onClick={() => setOpening({ row: r, field: "RECOVERY_KEY" })}>
                      <LifeBuoy className="mr-1.5 h-3.5 w-3.5" />
                      Recovery key
                    </Button>
                  )}
                  <IconButton
                    icon={r.pinned ? PinOff : Pin}
                    label={r.pinned ? "Unpin" : "Pin to the top"}
                    onClick={async () => {
                      const result = await setCredentialPin(r.id, !r.pinned);
                      if (!result.ok) alert(result.error);
                      router.refresh();
                    }}
                  />
                  {/*
                    Available to anybody who can see the record, not only to whoever manages it.
                    An override that only the overrider can review is not accountability.
                  */}
                  <IconButton icon={History} label="Who opened it" onClick={() => setTrailFor(r)} />
                  {r.canManage && (
                    <>
                      <IconButton icon={Share2} label="Share" onClick={() => setSharing(r)} />
                      <IconButton icon={Pencil} label="Edit" onClick={() => setEditing(r)} />
                    </>
                  )}
                  {/* An admin can delete somebody else's — the action has always allowed it and
                      the button had not caught up, which left an admin clearing out a departed
                      colleague's records with no way to do it from the screen. */}
                  {r.canDelete && (
                    <IconButton
                      icon={Trash2}
                      label="Delete"
                      tone="danger"
                      onClick={() => setDeleting(r)}
                    />
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-2 text-xs text-subtle">
                  {/* Beside the people it is shared with, because that is the same question. */}
                  <div className="flex items-center gap-2">
                    <span>{r.mine ? "Yours" : "Owner"}</span>
                    {!r.mine && (
                      <>
                        <Avatar size="sm" user={r.owner} />
                        <span className="text-muted">{r.owner.name}</span>
                      </>
                    )}
                  </div>
                  {r.shares.length > 0 && <SharedWith shares={r.shares} />}
                  {r.lastOpened.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setTrailFor(r)}
                      className="flex items-center gap-2 rounded-base text-left hover:text-text"
                    >
                      <span>Last opened</span>
                      <AvatarStack
                        size="sm"
                        users={r.lastOpened.map((v) => ({ id: v.userId, name: v.userName, photoUpdatedAt: v.photoUpdatedAt }))}
                      />
                      <span>
                        {formatDate(new Date(r.lastOpened[0]!.at))}
                        {r.openedCount > 1 && ` · ${r.openedCount} times`}
                      </span>
                    </button>
                  )}
              </div>
            </CardContent>
          </Card>
        ))
      )}

      {opening && <OpenDialog row={opening.row} field={opening.field} onClose={() => setOpening(null)} />}
      {editing && (
        <EditDialog
          row={editing === "new" ? null : editing}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
      {sharing && <ShareDialog row={sharing} options={options} onClose={() => setSharing(null)} />}
      {trailFor && <TrailDialog row={trailFor} onClose={() => setTrailFor(null)} />}
      {deleting && (
        <ArchiveDialog
          row={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function OpenDialog({ row, field, onClose }: { row: VaultRow; field: VaultField; onClose: () => void }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const what = field === "RECOVERY_KEY" ? "recovery key" : "password";

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await revealSecret(row.id, password, field);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSecret(result.data.secret);
      setPassword("");
      router.refresh();
    });
  }

  return (
    <Dialog open onClose={onClose} title={`${row.loginName} — ${what}`}>
      {secret === null ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Confirm it&apos;s you. This is recorded on the record
            {row.mine ? "." : `, and ${row.owner.name} will be told.`}
          </p>
          {row.via === "ADMIN" && (
            <p className="rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">
              This record isn&apos;t shared with you. Opening it uses your admin override, which is
              logged as an override and reported to {row.owner.name}.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="vault-confirm">Your password</Label>
            <Input
              id="vault-confirm"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !password}>
              {pending ? "Checking…" : `Show ${what}`}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {row.username && (
            <div className="space-y-1">
              <Label>Username</Label>
              <p className="break-all rounded-base bg-surface-sunken px-3 py-2 font-mono text-sm text-text">
                {row.username}
              </p>
            </div>
          )}
          <div className="space-y-1">
            <Label>{field === "RECOVERY_KEY" ? "Recovery key" : "Password"}</Label>
            <p className="break-all rounded-base bg-surface-sunken px-3 py-2 font-mono text-sm text-text">{secret}</p>
          </div>
          <p className="text-xs text-subtle">
            Close this when you&apos;re done — it isn&apos;t kept, and opening it again costs another password.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function EditDialog({
  row,
  options,
  onClose,
  onSaved,
}: {
  row: VaultRow | null;
  options: Options;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    loginName: row?.loginName ?? "",
    ownership: (row?.ownership ?? "OURS") as "OURS" | "CLIENT",
    companyId: row?.company?.id ?? "",
    categoryId: "",
    accessTypeId: "",
    username: row?.username ?? "",
    email: row?.email ?? "",
    loginUrl: row?.loginUrl ?? "",
    phone: row?.phone ?? "",
    secret: "",
    recoveryKey: "",
    remarks: row?.remarks ?? "",
    billingExpiry: row?.billingExpiry ? new Date(row.billingExpiry).toISOString().slice(0, 10) : "",
    rotateAfterDays: row?.rotateAfterDays != null ? String(row.rotateAfterDays) : "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (k: keyof typeof f, v: string) => setF((prev) => ({ ...prev, [k]: v }));

  return (
    <Dialog open onClose={onClose} title={row ? `Edit ${row.loginName}` : "Add a credential"}>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="v-name">What it opens</Label>
          <Input id="v-name" value={f.loginName} onChange={(e) => set("loginName", e.target.value)} placeholder="GoDaddy — acme.com" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="v-ownership">Whose account is it</Label>
          <Select
            id="v-ownership"
            value={f.ownership}
            onChange={(e) => {
              const next = e.target.value as "OURS" | "CLIENT";
              // The client is cleared as it flips, so a record cannot come out of this box marked
              // as ours while still carrying somebody's name into the save.
              setF((prev) => ({ ...prev, ownership: next, companyId: next === "CLIENT" ? prev.companyId : "" }));
            }}
          >
            <option value="OURS">Ours</option>
            <option value="CLIENT">A client&apos;s</option>
          </Select>
          {f.ownership === "CLIENT" && (
            <div className="space-y-1.5 pt-1.5">
              <Label htmlFor="v-company">Which client</Label>
              <CompanyCombobox
                id="v-company"
                companies={options.companies}
                value={f.companyId}
                onSelect={(company) => set("companyId", company?.id ?? "")}
                placeholder="Type to search customers…"
              />
              <p className="text-xs text-subtle">
                Optional — but it is what answers &ldquo;what does this customer still have access to&rdquo;
                on the day they leave.
              </p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="v-cat">Category</Label>
            <Select id="v-cat" value={f.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
              <option value="">Not set</option>
              {options.categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="v-type">Access type</Label>
            <Select id="v-type" value={f.accessTypeId} onChange={(e) => set("accessTypeId", e.target.value)}>
              <option value="">Not set</option>
              {options.accessTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="v-user">Username</Label>
            <Input id="v-user" value={f.username} onChange={(e) => set("username", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="v-email">Email</Label>
            <Input id="v-email" value={f.email} onChange={(e) => set("email", e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="v-url">Login URL</Label>
            <Input id="v-url" value={f.loginUrl} onChange={(e) => set("loginUrl", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="v-phone">Two-step goes to</Label>
            <Input id="v-phone" value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+91 98765 43210" />
          </div>
        </div>

        <SecretField
          id="v-secret"
          label={row ? "New password (blank keeps the current one)" : "Password"}
          value={f.secret}
          onChange={(v) => set("secret", v)}
        />

        <SecretField
          id="v-recovery"
          label={row ? "New recovery key (blank keeps it)" : "Recovery key"}
          value={f.recoveryKey}
          onChange={(v) => set("recoveryKey", v)}
          hint="Encrypted and opened separately from the password — it is the one that can take the account away from you."
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="v-expiry">Billing expires</Label>
            <Input id="v-expiry" type="date" value={f.billingExpiry} onChange={(e) => set("billingExpiry", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="v-rotate">Recommend a change after (days)</Label>
            <Input id="v-rotate" type="number" value={f.rotateAfterDays} onChange={(e) => set("rotateAfterDays", e.target.value)} placeholder="90" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="v-remarks">Remarks</Label>
          <Textarea id="v-remarks" rows={2} value={f.remarks} onChange={(e) => set("remarks", e.target.value)} />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            disabled={pending || !f.loginName.trim()}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await saveCredential({
                  id: row?.id,
                  ...f,
                  rotateAfterDays: f.rotateAfterDays ? Number(f.rotateAfterDays) : null,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                onSaved();
              })
            }
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ShareDialog({ row, options, onClose }: { row: VaultRow; options: Options; onClose: () => void }) {
  const router = useRouter();
  const [target, setTarget] = useState("");
  const [level, setLevel] = useState<VaultAccessLevel>("VIEW");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * People and teams in one list, keyed the way the action expects.
   *
   * The owner is left out: they already have it, and offering them is an invitation to a refusal.
   */
  const shareTargets: PersonOption[] = [
    ...options.users
      .filter((u) => u.id !== row.owner.id)
      .map((u) => ({ id: `u:${u.id}`, name: u.name, email: u.email, photoUpdatedAt: u.photoUpdatedAt })),
    ...options.departments.map((d) => ({ id: `d:${d.id}`, name: d.name, isGroup: true, hint: "team" })),
  ];

  return (
    <Dialog open onClose={onClose} title={`Share ${row.loginName}`}>
      <div className="space-y-3">
        {row.shares.length > 0 && (
          <div className="space-y-1.5">
            <Label>Already shared with</Label>
            {row.shares.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded-base bg-surface-sunken px-3 py-2">
                <div className="min-w-0 text-sm text-text">
                  {s.name}
                  {s.kind === "department" && <span className="text-muted"> (department)</span>}
                  <div className="text-xs text-subtle">
                    {accessLevelLabels[s.level]}
                    {s.expiresAt && ` · until ${formatDate(new Date(s.expiresAt))}`}
                  </div>
                </div>
                <IconButton
                  icon={Trash2}
                  label="Remove"
                  tone="danger"
                  onClick={async () => {
                    const result = await unshareCredential(s.id);
                    if (!result.ok) alert(result.error);
                    router.refresh();
                    onClose();
                  }}
                />
              </div>
            ))}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="share-with">Share with</Label>
          {/*
            Typed rather than scrolled. A hundred colleagues in a native dropdown is a scroll for a
            name you already know, and the address is often the only thing that tells two people
            with the same name apart — which matters more here than almost anywhere, because the
            cost of picking the wrong row is handing somebody the registrar password.
          */}
          <PersonCombobox
            id="share-with"
            people={shareTargets}
            value={target}
            onSelect={(person) => setTarget(person?.id ?? "")}
            placeholder="Search a colleague by name or email, or a team…"
            emptyText="Nobody and no team matches that."
          />
          {target.startsWith("d:") && (
            <p className="text-xs text-warning">
              A department share is standing — anybody who joins that team inherits it without anyone deciding again.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="share-level">They can</Label>
            <Select id="share-level" value={level} onChange={(e) => setLevel(e.target.value as VaultAccessLevel)}>
              {(Object.keys(accessLevelLabels) as VaultAccessLevel[]).map((l) => (
                <option key={l} value={l}>{accessLevelLabels[l]}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="share-until">Until (optional)</Label>
            <Input id="share-until" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-subtle">
          Access that lapses on its own is access nobody has to remember to take away.
        </p>

        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button
            disabled={pending || !target}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await shareCredential({
                  credentialId: row.id,
                  userId: target.startsWith("u:") ? target.slice(2) : undefined,
                  departmentId: target.startsWith("d:") ? target.slice(2) : undefined,
                  level,
                  expiresAt,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setTarget("");
                router.refresh();
                onClose();
              })
            }
          >
            {pending ? "Sharing…" : "Share"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}


/**
 * Who this is shared with, as faces.
 *
 * People get avatars; departments get a chip. That distinction is not decoration — a department
 * share means "whoever is in that team today", which is a different and larger promise than naming
 * four people, and drawing it as four faces would understate it.
 */
function SharedWith({ shares }: { shares: VaultRow["shares"] }) {
  const people = shares.filter((s) => s.kind === "user" && s.userId);
  const teams = shares.filter((s) => s.kind === "department");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>Shared with</span>
      {people.length > 0 && (
        <AvatarStack
          size="sm"
          users={people.map((s) => ({ id: s.userId!, name: s.name, photoUpdatedAt: s.photoUpdatedAt }))}
        />
      )}
      {teams.map((t) => (
        <Badge key={t.id} tone="default">
          {t.name} team
        </Badge>
      ))}
      {/* The faces carry names in a tooltip, which a screen reader does not read out. */}
      {people.length > 0 && <span className="sr-only">{people.map((p) => p.name).join(", ")}</span>}
    </div>
  );
}

/**
 * Every time this credential has been opened, and by whom.
 *
 * Fetched when the box opens rather than shipped with the list: a trail is long, most rows are
 * never asked about, and sending everybody's reading habits down with every page load would be
 * both slower and more than the page needs.
 *
 * An admin override is called out rather than sitting quietly among the rest. The entire point of
 * recording one is that somebody notices it.
 */
function TrailDialog({ row, onClose }: { row: VaultRow; onClose: () => void }) {
  const [entries, setEntries] = useState<TrailEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    credentialTrail(row.id).then((result) => {
      if (!live) return;
      if (result.ok) setEntries(result.data);
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, [row.id]);

  return (
    <Dialog open onClose={onClose} title={`Who opened ${row.loginName}`}>
      <div className="space-y-3">
        <p className="text-xs text-subtle">
          Every opening is recorded, including the owner&apos;s own. Reading this list is not itself an
          opening — checking who has seen your password does not notify you that you checked.
        </p>

        {error && <p className="text-sm text-danger">{error}</p>}
        {!entries && !error && <p className="text-sm text-muted">Loading…</p>}

        {entries?.length === 0 && (
          <p className="rounded-base border border-line bg-surface-sunken px-3 py-6 text-center text-sm text-muted">
            Nobody has opened this yet.
          </p>
        )}

        {entries && entries.length > 0 && (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center gap-3 rounded-base px-1 py-1.5">
                <Avatar size="sm" user={{ id: e.userId, name: e.userName, photoUpdatedAt: e.photoUpdatedAt }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-text">{e.userName}</div>
                  <div className="text-xs text-subtle">
                    {e.field === "RECOVERY_KEY" ? "Recovery key" : "Password"} ·{" "}
                    {revealViaLabels[e.via as keyof typeof revealViaLabels] ?? e.via}
                  </div>
                </div>
                {e.via === "ADMIN" && (
                  <Badge tone="amber">
                    <TriangleAlert className="mr-1 h-3 w-3" />
                    Override
                  </Badge>
                )}
                <span className="shrink-0 text-xs text-subtle">{formatDateTime(new Date(e.at))}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const STRENGTH_TONE = {
  weak: "bg-danger",
  fair: "bg-warning",
  good: "bg-brand",
  strong: "bg-success",
} as const;

const STRENGTH_WIDTH = { weak: "25%", fair: "50%", good: "75%", strong: "100%" } as const;

/**
 * The password box, with a way to stop choosing one.
 *
 * The generator sits here rather than on a page of its own because the moment somebody needs a
 * password is the moment they are typing one, and every extra step is a step back towards reusing
 * the old one. It runs in the browser: the value has to be posted to be saved, but there is no
 * reason for a round trip before that, and none for it to pass through a server log on the way.
 *
 * Shown in clear once generated. A password nobody can read is a password nobody can paste into
 * the system it belongs to, and dots here protect nothing — the person typing it is precisely the
 * person allowed to see it.
 */
function SecretField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [options, setOptions] = useState<PasswordOptions>(DEFAULT_PASSWORD_OPTIONS);
  const [tuning, setTuning] = useState(false);

  const strength = strengthOf(value);

  const generate = (next: PasswordOptions = options) => {
    onChange(generatePassword(next));
    setVisible(true);
    setCopied(false);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setTuning((t) => !t)}>
            {options.length} chars
          </Button>
          <Button size="sm" variant="secondary" onClick={() => generate()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Generate
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCopied(false);
          }}
          className={visible ? "font-mono" : undefined}
        />
        <IconButton
          icon={visible ? EyeOff : Eye}
          label={visible ? "Hide" : "Show"}
          onClick={() => setVisible((v) => !v)}
        />
        <IconButton
          icon={copied ? Check : Copy}
          label="Copy"
          disabled={!value}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        />
      </div>

      {tuning && (
        <div className="space-y-2 rounded-base border border-line bg-surface-sunken p-3">
          <div className="flex items-center gap-3">
            <Label htmlFor={`${id}-len`} className="shrink-0">
              Length
            </Label>
            <input
              id={`${id}-len`}
              type="range"
              min={MIN_LENGTH}
              max={64}
              value={options.length}
              onChange={(e) => {
                const next = { ...options, length: Number(e.target.value) };
                setOptions(next);
                // Re-rolled as the slider moves, but only once there is something to replace —
                // dragging it before generating anything should not put a password in an empty box.
                if (value) generate(next);
              }}
              className="flex-1 accent-[var(--brand)]"
            />
            <span className="w-8 text-right font-mono text-sm text-text">{options.length}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {(
              [
                ["upper", "A–Z"],
                ["digits", "0–9"],
                ["symbols", "Symbols"],
                ["avoidAmbiguous", "Skip lookalikes"],
              ] as const
            ).map(([key, text]) => (
              <label key={key} className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={options[key]}
                  onChange={(e) => {
                    const next = { ...options, [key]: e.target.checked };
                    setOptions(next);
                    if (value) generate(next);
                  }}
                  className="h-3.5 w-3.5 accent-[var(--brand)]"
                />
                {text}
              </label>
            ))}
          </div>
          <p className="text-xs text-subtle">
            Lookalikes are O/0 and l/1 — the characters that get read back wrong over the phone.
          </p>
        </div>
      )}

      {value && (
        <div className="space-y-1">
          <div className="h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
            <div
              className={`h-full rounded-full transition-all ${STRENGTH_TONE[strength.label]}`}
              style={{ width: STRENGTH_WIDTH[strength.label] }}
            />
          </div>
          <p className="text-xs text-subtle">
            <span className="capitalize text-muted">{strength.label}</span> · about {strength.bits} bits
            {strength.note ? ` · ${strength.note}` : ""}
          </p>
        </div>
      )}

      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}

/** Not used on the card, but kept so the reveal reason has a label wherever it is shown. */
export { revealViaLabels };
