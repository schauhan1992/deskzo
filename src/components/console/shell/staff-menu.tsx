"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { useFormStatus } from "react-dom";
import { ChevronDown, Keyboard, LogOut, UserRound } from "lucide-react";
import { THEME_CHOICES, chooseTheme, useThemeChoice } from "@/components/layout/theme-toggle";
import { consoleSignOut } from "@/actions/platform/staff-auth";
import { RolePill } from "@/components/console/kit/status";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Avatar } from "@/components/ui/avatar";
import type { ConsoleRole } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable='true']";

// ─── Theme: light or dark, as menu radio items ─────────────────────────────────────────────────────
// The choice, its storage and its event are the toggle's (src/components/layout/theme-toggle.tsx);
// here they are menu items because a menu's items must be — the toggle's pressed buttons inside a
// role="menu" would be controls a screen reader cannot reach and the arrow keys skip.

// ─── Sign out ─────────────────────────────────────────────────────────────────────────────────────

/** Inside the form, so it can say the form is working. The redirect to /login ends the page. */
function SignOutItem({ className, onMouseMove }: { className: string; onMouseMove: (e: MouseEvent<HTMLElement>) => void }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={pending || undefined}
      // Once is enough; a second press while the first is on its way would only race it.
      onClick={(e) => {
        if (pending) e.preventDefault();
      }}
      onMouseMove={onMouseMove}
      className={className}
    >
      <LogOut aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
      <span className="min-w-0 flex-1 truncate">{pending ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}

/**
 * The staff member's own menu at the right of the top bar: who is signed in (name, email, role), My
 * account, the keyboard shortcuts, the theme below `lg` (the top bar has its own toggle from there up),
 * and signing out.
 *
 * Keyboard as `RowMenu` (src/components/console/kit/row-menu.tsx) and the WAI-ARIA menu button: Enter,
 * Space or ArrowDown on the button open it on the first item, ArrowUp on the last; in the menu the
 * arrows move (wrapping), Home/End jump, a letter jumps to the next item starting with it, Enter or
 * Space chooses, Escape or a click outside closes it and puts focus back on the button, and Tab closes
 * it and moves on. RowMenu itself does not fit: its trigger is a ⋮ icon, and it has no header or radio
 * items. The panel is `AnchoredPopover`, which draws nothing on the server.
 */
export function StaffMenu({ staff, onOpenShortcuts }: { staff: { name: string; email: string; role: ConsoleRole }; onOpenShortcuts: () => void }) {
  const baseId = useId();
  const menuId = `${baseId}-menu`;
  const headerId = `${baseId}-who`;
  const themeLabelId = `${baseId}-theme`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Where focus goes once the panel exists — it mounts a render after `open`, once positioned. */
  const focusOnOpen = useRef<"first" | "last" | null>(null);
  const [open, setOpen] = useState(false);
  const theme = useThemeChoice("system");

  // Only the items on screen: the theme row is `lg:hidden`, and a hidden item must not take focus.
  const menuItems = () =>
    Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []).filter((el) => el.getClientRects().length > 0);

  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (!node || !focusOnOpen.current) return;
    const all = Array.from(node.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((el) => el.getClientRects().length > 0);
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
      const target = e.target as Element | null;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      const hadFocus = !!panelRef.current?.contains(document.activeElement);
      focusOnOpen.current = null;
      setOpen(false);
      // Back to the button only when the click landed on nothing that takes focus itself.
      if (hadFocus && !target?.closest?.(FOCUSABLE)) {
        window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
      }
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
        // Focus back on the button and no preventDefault: the browser then moves on from the button.
        closeMenu(true);
        return;
      case "Enter":
        e.preventDefault();
        if (index >= 0) all[index]!.click();
        return;
      case " ":
        // Chosen on key-up, as a button would be (see RowMenu).
        e.preventDefault();
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.trim() !== "") {
          const letter = e.key.toLocaleLowerCase();
          for (let step = 1; step <= all.length; step++) {
            const candidate = all[(Math.max(index, 0) + step) % all.length]!;
            if ((candidate.textContent ?? "").trim().toLocaleLowerCase().startsWith(letter)) {
              next = all.indexOf(candidate);
              break;
            }
          }
        }
    }
    if (next === null) return;
    e.preventDefault();
    all[next]?.focus({ preventScroll: false });
  }

  function onMenuKeyUp(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== " ") return;
    e.preventDefault();
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active) && active.matches(ITEM_SELECTOR)) active.click();
  }

  // Pointer and keyboard share one highlight: hovering an item focuses it.
  const followPointer = (e: MouseEvent<HTMLElement>) => {
    if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
  };

  const itemClass =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-surface-sunken focus:bg-surface-sunken focus-visible:-outline-offset-2";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Your account menu, ${staff.name}`}
        onClick={() => (open ? closeMenu(false) : openMenu("first"))}
        onKeyDown={onTriggerKeyDown}
        className={cn("flex h-9 min-w-0 items-center gap-2 rounded-base px-1.5 transition-colors hover:bg-surface-sunken", open && "bg-surface-sunken")}
      >
        <Avatar user={{ id: staff.email, name: staff.name }} size="sm" />
        <span className="hidden min-w-0 items-center gap-2 sm:flex">
          <span className="max-w-[10rem] truncate text-[13px] font-medium text-text">{staff.name}</span>
          <RolePill role={staff.role} />
        </span>
        <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 text-subtle transition-transform", open && "rotate-180")} />
      </button>
      <AnchoredPopover anchorRef={triggerRef} open={open} width={264} maxHeight={480} align="end">
        <div ref={attachPanel} onKeyDown={onMenuKeyDown} onKeyUp={onMenuKeyUp}>
          <div id={headerId} className="border-b border-line px-3 py-2.5">
            <p className="truncate text-sm font-medium text-text">{staff.name}</p>
            <p translate="no" className="truncate text-xs text-muted">
              {staff.email}
            </p>
            <div className="mt-1.5">
              <RolePill role={staff.role} />
            </div>
          </div>
          <div id={menuId} role="menu" aria-label="Your account" aria-describedby={headerId} className="py-1">
            <Link
              href="/account"
              role="menuitem"
              tabIndex={-1}
              onClick={() => closeMenu(true)}
              onMouseMove={followPointer}
              className={itemClass}
            >
              <UserRound aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
              <span className="min-w-0 flex-1 truncate">My account</span>
            </Link>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                // Focus on the button first, so the dialog hands it back there when it closes.
                closeMenu(true);
                onOpenShortcuts();
              }}
              onMouseMove={followPointer}
              className={itemClass}
            >
              <Keyboard aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
              <span className="min-w-0 flex-1 truncate">Keyboard shortcuts</span>
            </button>

            <div role="separator" className="my-1 h-px bg-line lg:hidden" />
            <div role="group" aria-labelledby={themeLabelId} className="px-3 py-1.5 lg:hidden">
              <div id={themeLabelId} aria-hidden="true" className="mb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">
                Theme
              </div>
              <div className="flex gap-0.5 rounded-base border border-line bg-surface-sunken p-0.5">
                {THEME_CHOICES.map(({ value, label, Icon }) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={theme === value}
                    tabIndex={-1}
                    onClick={() => chooseTheme(value)}
                    onMouseMove={followPointer}
                    className={cn(
                      "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[6px] text-xs transition-colors",
                      theme === value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text focus:text-text",
                    )}
                  >
                    <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div role="separator" className="my-1 h-px bg-line" />
            <form action={consoleSignOut} role="none">
              <SignOutItem className={itemClass} onMouseMove={followPointer} />
            </form>
          </div>
        </div>
      </AnchoredPopover>
    </>
  );
}
