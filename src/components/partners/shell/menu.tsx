"use client";

import { Fragment, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { cn } from "@/lib/utils";

export type ShellMenuItem =
  | { kind: "item"; key: string; label: string; description?: string; icon?: LucideIcon; href?: string; onSelect?: () => void; danger?: boolean; busy?: boolean; keepOpen?: boolean; className?: string }
  | { kind: "separator"; key: string; className?: string }
  | {
      kind: "radios";
      key: string;
      label: string;
      className?: string;
      options: { value: string; label: string; icon: LucideIcon; checked: boolean; onSelect: () => void }[];
    };

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable='true']";

/**
 * A menu button for the partner portal's top bar — the user menu — copied from the CMS's
 * (src/components/cms/shell/menu.tsx) so the portal does not depend on another app's internals. Per
 * the WAI-ARIA menu button pattern, as the console's staff menu and row menu are: Enter, Space or ArrowDown on the
 * button open it on the first item, ArrowUp on the last; in the menu the arrows move (wrapping),
 * Home/End jump, a letter jumps to the next item starting with it, Enter or Space chooses, and Escape,
 * Tab or a click outside closes it with focus back on the button. Hidden items (a `lg:hidden` theme
 * row on a wide screen) are skipped. The panel is `AnchoredPopover`, portalled and drawn nothing on the
 * server, so nothing `fixed` hangs off the top bar's blur.
 *
 * Focus goes back to the button *before* an item's `onSelect` runs, so a dialog that item opens hands
 * focus back to the button when it closes.
 */
export function ShellMenu({
  label,
  trigger,
  triggerClassName,
  header,
  items,
  width = 248,
  align = "end",
}: {
  /** The button's accessible name. */
  label: string;
  trigger: (open: boolean) => ReactNode;
  triggerClassName?: string | ((open: boolean) => string);
  header?: ReactNode;
  items: ShellMenuItem[];
  width?: number;
  align?: "start" | "end";
}) {
  const baseId = useId();
  const menuId = `${baseId}-menu`;
  const headerId = `${baseId}-header`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const focusOnOpen = useRef<"first" | "last" | null>(null);
  const [open, setOpen] = useState(false);

  const visibleItems = (root: HTMLElement | null) => Array.from(root?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []).filter((el) => el.getClientRects().length > 0);

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
      const all = visibleItems(panelRef.current);
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
      if (hadFocus && !target?.closest?.(FOCUSABLE)) window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
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
    const all = visibleItems(panelRef.current);
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
        closeMenu(true);
        return;
      case "Enter":
        e.preventDefault();
        if (index >= 0) all[index]!.click();
        return;
      case " ":
        e.preventDefault();
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.trim() !== "") {
          const letter = e.key.toLocaleLowerCase();
          for (let step = 1; step <= all.length; step++) {
            const candidate = all[(Math.max(index, 0) + step) % all.length]!;
            if ((candidate.dataset.menuText ?? candidate.textContent ?? "").trim().toLocaleLowerCase().startsWith(letter)) {
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

  const followPointer = (e: MouseEvent<HTMLElement>) => {
    if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
  };

  const itemClass = "flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-surface-sunken focus:bg-surface-sunken focus-visible:-outline-offset-2";

  function renderItem(item: Extract<ShellMenuItem, { kind: "item" }>) {
    const Icon = item.icon;
    const body = (
      <>
        {Icon && <Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", item.danger ? "text-danger" : "text-subtle")} />}
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate", item.danger && "text-danger")}>{item.label}</span>
          {item.description && <span className="mt-0.5 block text-xs text-muted">{item.description}</span>}
        </span>
      </>
    );
    if (item.href) {
      return (
        <Link
          key={item.key}
          href={item.href}
          role="menuitem"
          tabIndex={-1}
          data-menu-text={item.label}
          onClick={() => closeMenu(true)}
          onMouseMove={followPointer}
          className={cn(itemClass, item.className)}
        >
          {body}
        </Link>
      );
    }
    return (
      <button
        key={item.key}
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-menu-text={item.label}
        aria-disabled={item.busy || undefined}
        onClick={() => {
          if (item.busy) return;
          // "Sign out" stays open to say it is working; the page it leads to replaces the menu.
          if (!item.keepOpen) closeMenu(true);
          item.onSelect?.();
        }}
        onMouseMove={followPointer}
        className={cn(itemClass, item.busy && "cursor-wait opacity-70", item.className)}
      >
        {body}
      </button>
    );
  }

  const triggerClasses = typeof triggerClassName === "function" ? triggerClassName(open) : triggerClassName;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => (open ? closeMenu(false) : openMenu("first"))}
        onKeyDown={onTriggerKeyDown}
        className={triggerClasses}
      >
        {trigger(open)}
      </button>
      <AnchoredPopover anchorRef={triggerRef} open={open} width={width} maxHeight={520} align={align}>
        <div ref={attachPanel} onKeyDown={onMenuKeyDown} onKeyUp={onMenuKeyUp}>
          {header && (
            <div id={headerId} className="border-b border-line px-3 py-2.5">
              {header}
            </div>
          )}
          <div id={menuId} role="menu" aria-label={label} aria-describedby={header ? headerId : undefined} className="py-1">
            {items.map((item) => {
              if (item.kind === "separator") return <div key={item.key} role="separator" className={cn("my-1 h-px bg-line", item.className)} />;
              if (item.kind === "radios") {
                const groupLabelId = `${baseId}-${item.key}`;
                return (
                  <div key={item.key} role="group" aria-labelledby={groupLabelId} className={cn("px-3 py-1.5", item.className)}>
                    <div id={groupLabelId} aria-hidden="true" className="mb-1.5 text-[11px] font-semibold tracking-wide text-subtle uppercase">
                      {item.label}
                    </div>
                    <div className="flex gap-0.5 rounded-base border border-line bg-surface-sunken p-0.5">
                      {item.options.map((option) => {
                        const Icon = option.icon;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={option.checked}
                            tabIndex={-1}
                            data-menu-text={option.label}
                            onClick={option.onSelect}
                            onMouseMove={followPointer}
                            className={cn(
                              "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[6px] text-xs transition-colors",
                              option.checked ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text focus:text-text",
                            )}
                          >
                            <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              }
              return <Fragment key={item.key}>{renderItem(item)}</Fragment>;
            })}
          </div>
        </div>
      </AnchoredPopover>
    </>
  );
}
