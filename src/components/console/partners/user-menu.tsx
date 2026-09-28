"use client";

import { useState } from "react";
import { consoleDeactivatePartnerUser, consolePartnerUserLink, consoleReactivatePartnerUser, consoleResetPartnerUserTwoFactor } from "@/actions/platform/console-partners";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { useConsoleAction } from "@/components/console/kit/use-console-action";

/**
 * One partner user's actions (MANAGERS; spec §9.2 Users): a new set-password link (emailed to them,
 * never shown here), resetting a lost authenticator, switching them off or back on. Each is a T1
 * confirmation; the partner's last active admin can't be switched off (the item says why). Rendered
 * for MANAGERS only — the menu's items exist only while it is open.
 */

type Kind = "link" | "reset" | "off" | "on";
type UserRef = { id: string; name: string; email: string; active: boolean; twoFactor: boolean };

const COPY: Record<Kind, { title: string; confirm: string; tone: "primary" | "danger"; body: (u: UserRef) => string }> = {
  link: { title: "Send a new set-password link", confirm: "Send link", tone: "primary", body: (u) => `Emails ${u.email} a new one-time link to choose a password. Any earlier link stops working.` },
  reset: {
    title: "Reset two-factor",
    confirm: "Reset two-factor",
    tone: "danger",
    body: (u) => `Forgets ${u.name}'s authenticator and signs them out everywhere. They set up a new one at their next sign-in.`,
  },
  off: { title: "Switch off", confirm: "Switch off", tone: "danger", body: (u) => `${u.name} is signed out everywhere and can't sign in until switched back on.` },
  on: { title: "Switch back on", confirm: "Switch back on", tone: "primary", body: (u) => `${u.name} can sign in again. A new set-password link is emailed to ${u.email}.` },
};

export function PartnerUserMenu({ user, lastAdmin }: { user: UserRef; lastAdmin: boolean }) {
  const action = useConsoleAction<{ emailed: boolean } | null>();
  const [open, setOpen] = useState<Kind | null>(null);

  function ask(kind: Kind) {
    action.reset();
    setOpen(kind);
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(null);
  }

  function run(kind: Kind) {
    const work = { link: consolePartnerUserLink, reset: consoleResetPartnerUserTwoFactor, off: consoleDeactivatePartnerUser, on: consoleReactivatePartnerUser }[kind];
    action.run(() => work(user.id), {
      success: (d) => {
        const mailed = d && typeof d === "object" && "emailed" in d ? d.emailed : true;
        if (kind === "link") return mailed ? `New set-password link emailed to ${user.email}.` : "The link was made, but the email could not be sent — try again later.";
        if (kind === "reset") return `Two-factor reset for ${user.name}.`;
        if (kind === "off") return `${user.name} switched off.`;
        return mailed ? `${user.name} switched back on — a set-password link was emailed.` : `${user.name} switched back on, but the email could not be sent.`;
      },
      onDone: () => setOpen(null),
    });
  }

  const items: RowMenuItem[] = [];
  if (user.active) {
    items.push({ key: "link", label: "Send a new set-password link", onSelect: () => ask("link") });
    if (user.twoFactor) items.push({ key: "reset", label: "Reset two-factor", onSelect: () => ask("reset") });
    items.push({ key: "sep", separator: true });
    items.push(
      lastAdmin
        ? { key: "off", label: "Switch off — its last active admin", disabled: true }
        : { key: "off", label: "Switch off", danger: true, onSelect: () => ask("off") },
    );
  } else {
    items.push({ key: "on", label: "Switch back on", onSelect: () => ask("on") });
  }

  const copy = open ? COPY[open] : null;
  return (
    <>
      <RowMenu label={`Actions for ${user.name}`} items={items} />
      <ConfirmDialog
        open={open !== null}
        onClose={close}
        title={copy?.title ?? ""}
        confirmLabel={copy?.confirm ?? ""}
        tone={copy?.tone ?? "primary"}
        pending={action.pending}
        error={action.error}
        onConfirm={() => {
          if (open) run(open);
        }}
      >
        <p>{copy ? copy.body(user) : ""}</p>
      </ConfirmDialog>
    </>
  );
}
