"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { AlarmClock, Check, ChevronDown, RotateCcw } from "lucide-react";
import { consoleAckAlert, consoleUnackAlert } from "@/actions/platform/console-alerts";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * What a member of staff who changes things (WRITERS) can do about one alert on /alerts: acknowledge
 * it (an instance only — "this setup failed" can be settled; "the warm pool is low" cannot), put it off
 * for an hour, a day or a week, or — once handled — put it back on the open list. Each is a T1
 * confirmation with an optional note the rest of the team sees beside the name.
 *
 * The page renders this only for roles with `caps.ackAlerts`; the actions check the role again.
 */

const SNOOZES = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
] as const;

type Snooze = (typeof SNOOZES)[number];
type Ask = { kind: "ack" } | { kind: "snooze"; snooze: Snooze } | { kind: "unack" };
type AckResult = { snoozeUntil: string | null } | null;

/** The server takes up to 300 characters; the field stops there too. */
const NOTE = { label: "Note (optional)", minLength: 0, maxLength: 300, placeholder: "What is being done about it" };

function dialogText(ask: Ask): { title: string; confirmLabel: string; consequence: string } {
  switch (ask.kind) {
    case "ack":
      return {
        title: "Acknowledge alert",
        confirmLabel: "Acknowledge",
        consequence: "It leaves the open list for everyone, with your name on it. If it happens again, it comes back as a new alert.",
      };
    case "snooze":
      return {
        title: `Snooze for ${ask.snooze.label}`,
        confirmLabel: "Snooze",
        consequence: `It leaves the open list for ${ask.snooze.label}, with your name on it, and comes back then if it is still true.`,
      };
    default:
      return { title: "Unacknowledge alert", confirmLabel: "Unacknowledge", consequence: "It goes back on the open list now, if it is still true." };
  }
}

export function AlertActions({ alertKey, instance, acked, title }: { alertKey: string; instance: boolean; acked: boolean; title: string }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const action = useConsoleAction<AckResult>();

  function open(next: Ask) {
    action.reset();
    setAsk(next);
  }

  function close() {
    setAsk(null);
    action.reset();
  }

  function confirm({ reason }: { typed: string; reason: string }) {
    if (!ask) return;
    const note = reason || undefined;
    const onDone = () => setAsk(null);
    if (ask.kind === "unack") {
      action.run(() => consoleUnackAlert(alertKey), { success: "Alert reopened.", onDone });
    } else if (ask.kind === "ack") {
      action.run(() => consoleAckAlert(alertKey, { note }), { success: "Alert acknowledged.", onDone });
    } else {
      const { hours, label } = ask.snooze;
      action.run(() => consoleAckAlert(alertKey, { snoozeHours: hours, note }), { success: `Alert snoozed for ${label}.`, onDone });
    }
  }

  const text = ask ? dialogText(ask) : null;

  return (
    <>
      {acked ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => open({ kind: "unack" })}>
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
          Unacknowledge<span className="sr-only">{`: ${title}`}</span>
        </Button>
      ) : (
        <>
          {instance && (
            <Button type="button" variant="ghost" size="sm" onClick={() => open({ kind: "ack" })}>
              <Check aria-hidden="true" className="h-4 w-4" />
              Acknowledge<span className="sr-only">{`: ${title}`}</span>
            </Button>
          )}
          <SnoozeMenu title={title} onChoose={(snooze) => open({ kind: "snooze", snooze })} />
        </>
      )}

      <ConfirmDialog
        open={ask !== null}
        onClose={close}
        title={text?.title ?? "Acknowledge alert"}
        confirmLabel={text?.confirmLabel ?? "Acknowledge"}
        reason={ask && ask.kind !== "unack" ? NOTE : undefined}
        pending={action.pending}
        error={action.error}
        onConfirm={confirm}
      >
        {text && (
          <>
            <p className="rounded-lg border border-line bg-surface-sunken px-3 py-2 font-medium break-words">{title}</p>
            <p>{text.consequence}</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

const ITEM = '[role="menuitem"]';

/**
 * "Snooze ▾": a menu button (WAI-ARIA pattern) offering the three lengths. ArrowDown/ArrowUp open it
 * on the first or last item; in it the arrows move (wrapping), Home/End jump, Enter or Space choose,
 * Escape or a click outside close it and put focus back on the button, and Tab closes it and moves on.
 *
 * Focus returns to the button before the choice opens its dialog, so the dialog hands focus back
 * there when it closes. The panel is `AnchoredPopover`, which renders nothing on the server.
 */
function SnoozeMenu({ title, onChoose }: { title: string; onChoose: (snooze: Snooze) => void }) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** The panel mounts a render after `open` (once it is positioned); focus waits for it. */
  const focusOnOpen = useRef<"first" | "last" | null>(null);
  const [open, setOpen] = useState(false);

  const menuItems = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? []);

  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (!node || !focusOnOpen.current) return;
    const all = Array.from(node.querySelectorAll<HTMLElement>(ITEM));
    const target = focusOnOpen.current === "last" ? all[all.length - 1] : all[0];
    focusOnOpen.current = null;
    target?.focus({ preventScroll: true });
  }, []);

  function openMenu(focus: "first" | "last") {
    if (open) {
      const all = menuItems();
      (focus === "last" ? all[all.length - 1] : all[0])?.focus({ preventScroll: true });
      return;
    }
    focusOnOpen.current = focus;
    setOpen(true);
  }

  function closeMenu(returnFocus: boolean) {
    focusOnOpen.current = null;
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: globalThis.MouseEvent) {
      const target = e.target as Node | null;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      focusOnOpen.current = null;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu(e.key === "ArrowUp" ? "last" : "first");
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      closeMenu(true);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const all = menuItems();
    if (all.length === 0) return;
    const index = all.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    switch (e.key) {
      case "ArrowDown":
        next = index < 0 ? 0 : (index + 1) % all.length;
        break;
      case "ArrowUp":
        next = index <= 0 ? all.length - 1 : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = all.length - 1;
        break;
      case "Escape":
        e.preventDefault();
        closeMenu(true);
        return;
      case "Tab":
        // Back on the button without preventDefault: the browser then moves on from there.
        closeMenu(true);
        return;
      case "Enter":
        e.preventDefault();
        if (index >= 0) all[index]!.click();
        return;
      case " ":
        // Chosen on key-up, as a button is — choosing on key-down would let the key-up press the
        // Snooze button that focus has just returned to, and open the menu again.
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    all[next]?.focus();
  }

  function onMenuKeyUp(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== " ") return;
    e.preventDefault();
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active) && active.matches(ITEM)) active.click();
  }

  function choose(snooze: Snooze) {
    closeMenu(true);
    onChoose(snooze);
  }

  // Pointer and keyboard share one highlight: hovering an item focuses it.
  const followPointer = (e: MouseEvent<HTMLElement>) => {
    if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
  };

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? closeMenu(false) : openMenu("first"))}
        onKeyDown={onTriggerKeyDown}
        className={open ? "bg-surface-sunken text-text" : undefined}
      >
        <AlarmClock aria-hidden="true" className="h-4 w-4" />
        Snooze<span className="sr-only">{`: ${title}`}</span>
        <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </Button>
      <AnchoredPopover anchorRef={triggerRef} open={open} width={176} align="end">
        <div ref={attachPanel} id={menuId} role="menu" aria-label="Snooze for" onKeyDown={onMenuKeyDown} onKeyUp={onMenuKeyUp} className="py-1">
          {SNOOZES.map((snooze) => (
            <button
              key={snooze.hours}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => choose(snooze)}
              onMouseMove={followPointer}
              className="flex w-full items-center px-3 py-2 text-left text-sm text-text transition-colors hover:bg-surface-sunken focus:bg-surface-sunken focus-visible:-outline-offset-2"
            >
              {`For ${snooze.label}`}
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </>
  );
}
