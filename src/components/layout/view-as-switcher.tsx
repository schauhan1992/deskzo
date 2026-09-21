"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Eye, Search, X } from "lucide-react";
import type { Role } from "@prisma/client";
import { startViewingAs, stopViewingAs } from "@/actions/impersonation";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";

type Target = {
  id: string;
  name: string;
  email: string;
  role: Role;
  department: { name: string } | null;
};

/**
 * The top-right control for stepping into another user's account, and back out.
 *
 * Two states in one component on purpose. While viewing as someone, the only thing this offers is
 * the way back — no picker, because switching straight from one person to another hides the seam
 * between two sessions that the audit log has to keep separate.
 */
export function ViewAsSwitcher({
  targets,
  viewingAs,
}: {
  targets: Target[];
  /** Set only while an admin is inside someone else's account. */
  viewingAs: { userName: string; actorName: string } | null;
}) {
  const router = useRouter();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (anchorRef.current?.contains(target)) return;
      if (target?.closest?.("[data-menu-panel]")) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? targets.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.email.toLowerCase().includes(q) ||
            t.role.toLowerCase().includes(q) ||
            t.department?.name.toLowerCase().includes(q),
        )
      : targets;
    // Capped rather than scrolled forever: past a dozen names you are searching, not browsing.
    return rows.slice(0, 12);
  }, [targets, query]);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, destination?: string) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      setOpen(false);
      setQuery("");
      // Sent to the dashboard rather than left where they were: the current page may be one this
      // account has no access to, and landing on its "not allowed" screen reads as a broken switch.
      router.push(destination ?? "/dashboard");
      router.refresh();
    });
  }

  if (viewingAs) {
    return (
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => run(() => stopViewingAs())}
        title={`You are ${viewingAs.actorName}, viewing as ${viewingAs.userName}`}
      >
        <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" />
        {pending ? "Switching…" : `Back to ${viewingAs.actorName.split(" ")[0]}`}
      </Button>
    );
  }

  if (targets.length === 0) return null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="View the app as another user"
        aria-label="View the app as another user"
        className="rounded-base p-1.5 text-muted transition-colors hover:bg-surface-sunken hover:text-text"
      >
        <Eye className="h-4 w-4" />
      </button>

      <AnchoredPopover anchorRef={anchorRef} open={open} width={320} align="end" maxHeight={420}>
        <div data-menu-panel className="rounded-xl border border-line bg-surface p-3 shadow-lg">
          <div className="text-sm font-medium text-text">View as another user</div>
          <p className="mt-0.5 text-xs text-muted">
            You&apos;ll see exactly what they see. Anything you change is recorded against you.
          </p>

          <div className="relative mt-2.5">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, email, role or team"
              className="h-9 pl-8 text-sm"
              aria-label="Search users"
            />
          </div>

          {error && <p className="mt-2 text-xs text-danger">{error}</p>}

          <div className="mt-2 max-h-64 overflow-y-auto">
            {matches.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={pending}
                onClick={() => run(() => startViewingAs(t.id))}
                className="flex w-full items-center justify-between gap-2 rounded-base px-2 py-1.5 text-left hover:bg-surface-sunken disabled:opacity-60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-text">{t.name}</span>
                  <span className="block truncate text-[11px] text-subtle">
                    {t.department?.name ? `${t.department.name} · ` : ""}
                    {t.email}
                  </span>
                </span>
                <Badge tone={t.role === "ADMIN" ? "amber" : "default"}>{t.role}</Badge>
              </button>
            ))}
            {matches.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-subtle">Nobody matches that.</p>
            )}
          </div>

          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-2 flex w-full items-center justify-center gap-1 border-t border-line pt-2 text-xs text-subtle hover:text-text"
          >
            <X className="h-3 w-3" />
            Close
          </button>
        </div>
      </AnchoredPopover>
    </>
  );
}
