"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, UserCog, X, Crown } from "lucide-react";
import { effectivePermissionsFor } from "@/actions/permission";
import { setUserPermission, clearUserPermission, setSuperAdmin, userPermissionOverrides } from "@/actions/access";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";

/**
 * One person's access, and why.
 *
 * "Why does she have this?" is the question an access review actually asks, and it had no answer:
 * the matrix showed role defaults while enforcement walked the management chain, so the screen and
 * the behaviour disagreed and there was no way to tell which was right. Both now read the same
 * resolver, and every row says where it came from — a role default, a personal grant, or a specific
 * report it was inherited through. Each has a different fix, which is why naming it matters.
 */

type Row = {
  key: string;
  label: string;
  group: string;
  tier: string;
  held: boolean;
  via: string;
  why: string;
};

type Loaded = {
  user: { id: string; name: string; email: string; role: string; active: boolean; isSuperAdmin: boolean };
  permissions: Row[];
};

const VIA_TONE: Record<string, "default" | "green" | "blue" | "amber" | "red" | "brand"> = {
  superAdmin: "brand",
  userGrant: "green",
  roleOverride: "amber",
  roleDefault: "blue",
  adminDefault: "blue",
  downline: "amber",
  inactive: "red",
  none: "default",
};

export function UserAccessDrawer({
  userId,
  userName,
  viewerIsSuperAdmin,
  mayManage = true,
}: {
  userId: string;
  userName: string;
  viewerIsSuperAdmin: boolean;
  /** Read-only for a reviewer who may see access but not change it. */
  mayManage?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [overrides, setOverrides] = useState<Awaited<ReturnType<typeof userPermissionOverrides>>>([]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([effectivePermissionsFor(userId), userPermissionOverrides(userId)]).then(([eff, ovr]) => {
      if (cancelled) return;
      setLoaded(eff as Loaded | null);
      setOverrides(ovr);
    });
    return () => {
      cancelled = true;
    };
  }, [open, userId, isPending]);

  const shown = loaded?.permissions.filter((p) => showAll || p.held) ?? [];

  return (
    <>
      <IconButton icon={UserCog} label={`Review ${userName}'s access`} onClick={() => setOpen(true)} />

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setOpen(false)}>
          <div
            className="h-full w-full max-w-2xl overflow-y-auto bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 flex items-center justify-between border-b border-line bg-surface px-5 py-3">
              <div>
                <h2 className="text-sm font-semibold text-text">{loaded?.user.name ?? userName}</h2>
                {loaded && (
                  <p className="text-xs text-muted">
                    {loaded.user.email} · {loaded.user.role}
                    {loaded.user.isSuperAdmin && " · super admin"}
                    {!loaded.user.active && " · deactivated"}
                  </p>
                )}
              </div>
              <IconButton icon={X} label="Close" onClick={() => setOpen(false)} />
            </div>

            <div className="space-y-4 p-5">
              {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

              {!loaded ? (
                <p className="py-8 text-sm text-subtle">Working out what they can do…</p>
              ) : (
                <>
                  {loaded.user.isSuperAdmin && (
                    <Card className="border-brand/40 bg-brand-subtle px-3 py-2.5">
                      <p className="flex items-center gap-2 text-sm font-medium text-brand">
                        <Crown className="h-4 w-4" />
                        Super admin — holds everything, unconditionally
                      </p>
                      <p className="mt-1 text-xs text-brand">
                        No permission row is consulted for this account, so nothing on this screen can restrict them.
                        They cannot be demoted, deactivated or impersonated by an ordinary admin, and the last one
                        cannot be removed at all.
                      </p>
                    </Card>
                  )}

                  {viewerIsSuperAdmin && !loaded.user.isSuperAdmin && loaded.user.active && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() => {
                        setError(null);
                        startTransition(async () => {
                          const result = await setSuperAdmin(userId, true);
                          if (!result.ok) setError(result.error);
                          else router.refresh();
                        });
                      }}
                    >
                      <Crown className="h-3.5 w-3.5" />
                      Make super admin
                    </Button>
                  )}
                  {viewerIsSuperAdmin && loaded.user.isSuperAdmin && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() => {
                        setError(null);
                        startTransition(async () => {
                          const result = await setSuperAdmin(userId, false);
                          if (!result.ok) setError(result.error);
                          else router.refresh();
                        });
                      }}
                    >
                      Remove super admin
                    </Button>
                  )}

                  {overrides.length > 0 && (
                    <Card className="px-3 py-2.5">
                      <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Personal exceptions</p>
                      <div className="mt-2 space-y-1.5">
                        {overrides.map((o) => (
                          <div
                            key={o.permission}
                            className={`flex items-start justify-between gap-2 text-sm${o.expired ? " opacity-60" : ""}`}
                          >
                            <div className="min-w-0">
                              {/*
                                A lapsed row is not a grant. This used to render in success-green
                                with a live Remove button, contradicting the resolved permission a
                                few inches below saying the person does not hold it.
                              */}
                              <span
                                className={o.expired ? "text-subtle" : o.allowed ? "text-success" : "text-danger"}
                              >
                                {o.expired ? "Lapsed" : o.allowed ? "Granted" : "Denied"}
                              </span>{" "}
                              <code className="font-mono text-xs text-muted">{o.permission}</code>
                              <div className="text-xs text-subtle">
                                {o.reason ? `${o.reason} · ` : ""}
                                {/* A null grantor is what the seeder writes, not a departed employee. */}
                                {o.grantedBy?.name ? `by ${o.grantedBy.name}` : "grantor not recorded"}
                                {o.createdAt && ` on ${new Date(o.createdAt).toLocaleDateString("en-IN")}`}
                                {o.expiresAt &&
                                  ` · ${o.expired ? "lapsed" : "until"} ${new Date(o.expiresAt).toLocaleDateString("en-IN")}`}
                              </div>
                            </div>
                            {mayManage && (<button
                              type="button"
                              className="shrink-0 text-xs font-medium text-muted hover:text-danger"
                              onClick={() => {
                                startTransition(async () => {
                                  const r = await clearUserPermission(userId, o.permission);
                                  if (!r.ok) setError(r.error);
                                  else router.refresh();
                                });
                              }}
                            >
                              Remove
                            </button>)}
                          </div>
                        ))}
                      </div>
                    </Card>
                  )}

                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-text">
                      {showAll ? "Every permission" : `Holds ${loaded.permissions.filter((p) => p.held).length}`}
                    </p>
                    <button
                      type="button"
                      className="text-xs font-medium text-brand hover:underline"
                      onClick={() => setShowAll((v) => !v)}
                    >
                      {showAll ? "Only what they hold" : "Show everything"}
                    </button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                    <div className="space-y-1.5">
                      <Label htmlFor="uad-reason" className="text-xs">
                        Reason for the next change
                      </Label>
                      <Input
                        id="uad-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="e.g. covering for Priya while she is on leave"
                        className="h-8 text-sm"
                      />
                      <p className="text-xs text-subtle">
                        Recorded with the grant. An exception nobody can explain later is one nobody dares remove.
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="uad-until" className="text-xs">
                        Until (optional)
                      </Label>
                      <Input
                        id="uad-until"
                        type="date"
                        value={until}
                        onChange={(e) => setUntil(e.target.value)}
                        className="h-8 text-sm"
                      />
                      <p className="max-w-52 text-xs text-subtle">
                        {/*
                          The field this screen has been implying since it was written: the reason box
                          suggested "until 30 Nov" and there was nowhere to put it, so every
                          cover-for-leave grant was permanent and the only trace of intent was prose.
                        */}
                        Lapses on its own. Leave blank for access that is meant to stay.
                      </p>
                    </div>
                  </div>

                  <div className="divide-y divide-line">
                    {shown.map((p) => (
                      <div key={p.key} className="flex items-start justify-between gap-3 py-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium text-text">{p.label}</span>
                            <Badge tone={VIA_TONE[p.via] ?? "default"}>{p.via.replace(/([a-z])([A-Z])/g, "$1 $2")}</Badge>
                            {p.tier === "critical" && <Badge tone="red">Critical</Badge>}
                          </div>
                          <p className="mt-0.5 text-xs text-muted">{p.why}</p>
                        </div>
                        {mayManage && !loaded.user.isSuperAdmin && (
                          <button
                            type="button"
                            disabled={isPending}
                            className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                              p.held
                                ? "border-line-strong text-muted hover:bg-danger-bg hover:text-danger"
                                : "border-line-strong text-muted hover:bg-success-bg hover:text-success"
                            }`}
                            onClick={() => {
                              setError(null);
                              startTransition(async () => {
                                const r = await setUserPermission({
                                  userId,
                                  permission: p.key,
                                  allowed: !p.held,
                                  reason: reason.trim() || undefined,
                                  // Only a grant can lapse. An expiring *denial* would restore access
                                  // on a date nobody is watching, which is the wrong way round.
                                  expiresAt: !p.held && until ? until : null,
                                });
                                if (!r.ok) setError(r.error);
                                else router.refresh();
                              });
                            }}
                          >
                            {p.held ? "Deny for this person" : "Grant to this person"}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  <p className="flex items-start gap-2 pt-2 text-xs text-subtle">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    A personal grant or denial outranks the role. Use it for the exception; change the role or its
                    preset when the exception turns out to be the rule.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
