"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import { DatabaseZap, Play } from "lucide-react";
import { consoleApplyStanding, consoleMigrateWorkspace, consoleResume } from "@/actions/platform/console";
import { ActionButton } from "@/components/console/kit/action-button";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { useConsoleNotice } from "@/components/console/kit/notice";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import type { Caps } from "@/lib/console-shared/roles";
import type { TenantStatusKey } from "@/lib/console-shared/types";
import { EnterAsSupport } from "./enter-as-support";
import { HoldDialog } from "./hold-dialog";

/**
 * The action bar at the top of Workspace 360: the way in as support, reopening a held workspace,
 * migrating one that is behind, and a More menu for the rest (copying its id and address, its audit
 * trail, applying billing rules now, holding it).
 *
 * Drawn per role and never disabled for a role that cannot act: support staff see the way in and the
 * read-only menu items, nothing else. READONLY gets no action bar at all — the page leaves this out.
 * The menu is closed on the server and fills only when opened, so none of its wording is in the
 * page's first markup. The hold dialog here opens only on a click; the one that answers `?do=hold`
 * is the Danger zone's, so two never open at once.
 */

const APPLY_RESULTS: Record<string, string> = { none: "Nothing to do.", held: "Held.", lifted: "Hold lifted.", closed: "Closed." };

export function HeaderActions({
  tenant,
  caps,
  grantLive,
  migrate,
  gatewayPaying,
  hostUrl,
  isDefault = false,
}: {
  tenant: { id: string; slug: string; name: string; status: TenantStatusKey; suspendedFor: "STAFF" | "BILLING" | null };
  caps: Caps;
  grantLive: boolean;
  migrate: "migrate" | "retry" | null;
  gatewayPaying: boolean;
  hostUrl: string;
  /** The installation's own workspace: billing never touches it, so its menu does not offer billing rules. */
  isDefault?: boolean;
}) {
  const { show } = useConsoleNotice();
  const standing = useConsoleAction<string>();
  const [holdOpen, setHoldOpen] = useState(false);
  const [standingOpen, setStandingOpen] = useState(false);

  const active = tenant.status === "ACTIVE";
  const held = tenant.status === "SUSPENDED";
  // Open, or held for billing (a staff hold replaces it): the two a hold can be placed on.
  const canHold = caps.manage && (active || (held && tenant.suspendedFor === "BILLING"));
  const canApplyRules = caps.manage && !isDefault && (active || held);

  function copy(value: string, what: string) {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) {
      show("error", `Couldn't copy — select it by hand: ${value}`);
      return;
    }
    clipboard.writeText(value).then(
      () => show("success", `${what} copied.`),
      () => show("error", `Couldn't copy — select it by hand: ${value}`),
    );
  }

  const items: RowMenuItem[] = [
    { key: "copy-id", label: "Copy workspace ID", onSelect: () => copy(tenant.id, "Workspace ID") },
    { key: "copy-address", label: "Copy address", onSelect: () => copy(hostUrl, "Address") },
    { key: "audit", label: "View in audit log", href: `/audit?tenant=${encodeURIComponent(tenant.slug)}` },
  ];
  if (canApplyRules || canHold) items.push({ key: "sep-manage", separator: true });
  if (canApplyRules) {
    items.push({
      key: "standing",
      label: "Apply billing rules now",
      onSelect: () => {
        standing.reset();
        setStandingOpen(true);
      },
    });
  }
  if (canHold) items.push({ key: "hold", label: "Hold workspace…", danger: true, onSelect: () => setHoldOpen(true) });

  return (
    <>
      {caps.enter && grantLive && (active ? <EnterAsSupport tenantId={tenant.id} respondToParam /> : <span className="text-xs text-muted">Workspace is not open</span>)}

      {caps.manage && held && (
        <ActionButton
          action={consoleResume.bind(null, tenant.id)}
          label="Reopen workspace"
          icon={<Play aria-hidden="true" className="h-4 w-4" />}
          confirm={{
            title: "Reopen workspace",
            body:
              tenant.suspendedFor === "BILLING"
                ? "Its staff and users can sign in again at once. Billing holds it again at the next platform tick if it still has not paid."
                : "Its staff and users can sign in again at once.",
            confirmLabel: "Reopen workspace",
          }}
          success="Workspace reopened."
        />
      )}

      {caps.manage && migrate && (
        <ActionButton
          action={consoleMigrateWorkspace.bind(null, tenant.slug)}
          label={migrate === "retry" ? "Retry migration" : "Migrate now"}
          icon={<DatabaseZap aria-hidden="true" className="h-4 w-4" />}
          confirm={
            migrate === "retry"
              ? {
                  title: "Retry migration",
                  body: "Runs its workspace migrations again now. It opens again once they succeed; if one fails, it stays held and the output is under Operations.",
                  confirmLabel: "Retry migration",
                }
              : {
                  title: "Migrate now",
                  body: "Brings its database to the latest schema now, rather than at the next migration run. If a migration fails, it is held until one succeeds.",
                  confirmLabel: "Migrate now",
                }
          }
          success="Migrated — it is on the latest schema."
        />
      )}

      <RowMenu label="More actions" items={items} />

      {canHold && <HoldDialog open={holdOpen} onClose={() => setHoldOpen(false)} tenant={{ id: tenant.id, slug: tenant.slug, name: tenant.name }} gatewayPaying={gatewayPaying} />}

      {canApplyRules && (
        <ConfirmDialog
          open={standingOpen}
          onClose={() => {
            setStandingOpen(false);
            standing.reset();
          }}
          title="Apply billing rules now"
          confirmLabel="Apply rules"
          pending={standing.pending}
          error={standing.error}
          onConfirm={() =>
            standing.run(() => consoleApplyStanding(tenant.id), {
              success: (outcome) => APPLY_RESULTS[outcome] ?? "Billing rules applied.",
              onDone: () => setStandingOpen(false),
            })
          }
        >
          <p>
            Works out its standing and acts on it now rather than at the next platform tick: it can hold it, lift a billing hold, close it when auto-close is
            on, or email a reminder.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * A link to one of this page's tabs — from the summary strip, a banner, "See all activity". It
 * switches in place through the tab itself (`ws-tab-<key>`), so every switch goes one way: instant,
 * with the address following. Without the tab on the page (or with a modifier key held) it is an
 * ordinary link to the same `?tab=` address.
 */
export function TabLink({ tab, href, className, children }: { tab: string; href: string; className?: string; children: ReactNode }) {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // The tab bar's ids: ConsoleTabs with idPrefix "ws" (the page).
    const target = document.getElementById(`ws-tab-${tab}`);
    if (!target) return;
    e.preventDefault();
    target.click();
    target.focus({ preventScroll: true });
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }
  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
