"use client";

import { Fragment, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { ArrowUpRight, EllipsisVertical } from "lucide-react";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { IconButton } from "@/components/ui/icon-button";
import { OutboundLink } from "@/components/ui/outbound-link";
import { cn } from "@/lib/utils";

export type RowMenuItem =
  | { key: string; label: string; href?: string; external?: boolean; onSelect?: () => void; danger?: boolean; disabled?: boolean }
  | { key: string; separator: true }
  | { key: string; heading: string };

type ActionItem = Extract<RowMenuItem, { label: string }>;
type Section = { key: string; kind: "group"; heading: string | null; items: ActionItem[] } | { key: string; kind: "separator" };

const ITEM_SELECTOR = '[role="menuitem"]';
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable='true']";

/**
 * Items into what is drawn: runs of actions, each under its heading, with separators between them.
 * Callers build the list conditionally ("Migrate now" only when behind), so separators that end up
 * first, last or doubled, and headings left with nothing under them, are dropped here rather than
 * guarded at every call site.
 */
function sectionsOf(items: RowMenuItem[]): Section[] {
  const out: Section[] = [];
  let group: Extract<Section, { kind: "group" }> | null = null;
  for (const item of items) {
    if ("separator" in item) {
      group = null;
      if (out.length > 0 && out[out.length - 1]!.kind !== "separator") out.push({ key: item.key, kind: "separator" });
    } else if ("heading" in item) {
      group = { key: item.key, kind: "group", heading: item.heading, items: [] };
      out.push(group);
    } else {
      if (!group) {
        group = { key: `${item.key}-group`, kind: "group", heading: null, items: [] };
        out.push(group);
      }
      group.items.push(item);
    }
  }
  const kept = out.filter((s) => s.kind === "separator" || s.items.length > 0);
  // Dropping an empty group can leave two separators touching, or one at either end.
  return kept.filter((s, i) => s.kind !== "separator" || (i > 0 && i < kept.length - 1 && kept[i - 1]!.kind !== "separator"));
}

/**
 * A row's "more actions" menu (spec §1.8): an ⋮ button that opens a menu of links and actions.
 *
 * Keyboard per the WAI-ARIA menu button pattern. On the button, Enter, Space or ArrowDown opens the
 * menu on its first item and ArrowUp on its last. In the menu, ArrowUp/ArrowDown move (wrapping),
 * Home/End jump, a letter jumps to the next item starting with it, Enter or Space chooses, and Escape
 * or a click outside closes it and puts focus back on the button. Tab closes it too, and focus moves
 * on from the button as if the menu had never been open.
 *
 * Focus goes back to the button *before* an item's `onSelect` runs, so a dialog that item opens
 * returns focus there when it closes — not to a menu item that no longer exists.
 *
 * Disabled items stay in the menu and can be reached, as the pattern asks: an operator arrowing
 * through learns the action exists and is unavailable, rather than wondering where it went.
 *
 * The panel is `AnchoredPopover`, which draws nothing on the server — the menu's items never appear
 * in server-rendered markup, only the button does.
 */
export function RowMenu({ label, items, align = "end" }: { label: string; items: RowMenuItem[]; align?: "start" | "end" }) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Where focus goes once the panel exists — it mounts a render after `open`, once positioned. */
  const focusOnOpen = useRef<"first" | "last" | null>(null);
  const [open, setOpen] = useState(false);

  const sections = sectionsOf(items);
  const hasItems = sections.some((s) => s.kind === "group");

  const menuItems = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);

  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (!node || !focusOnOpen.current) return;
    const all = Array.from(node.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
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
      // Back to the button only when the click landed on nothing that takes focus itself; a click
      // into a search field must leave focus in the search field.
      if (hadFocus && !target?.closest?.(FOCUSABLE)) {
        window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  if (!hasItems) return null;

  function onTriggerClick() {
    if (open) closeMenu(false);
    else openMenu("first");
  }

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
        // preventDefault also tells a dialog around the menu that this Escape is spoken for.
        e.preventDefault();
        closeMenu(true);
        return;
      case "Tab":
        // Focus back on the button and no preventDefault: the browser then moves focus on from the
        // button, which is where Tab would have gone had the menu not been open.
        closeMenu(true);
        return;
      case "Enter":
        e.preventDefault();
        if (index >= 0) all[index]!.click();
        return;
      case " ":
        // Chosen on key-up, as a button would: acting on key-down puts focus back on the ⋮ button
        // in time for the key-up to press it, and the menu opens again.
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

  function choose(e: MouseEvent<HTMLElement>, item: ActionItem) {
    if (item.disabled) {
      e.preventDefault();
      return;
    }
    closeMenu(true);
    item.onSelect?.();
  }

  const itemClass = (item: ActionItem) =>
    cn(
      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors focus-visible:-outline-offset-2",
      item.disabled
        ? "cursor-not-allowed text-subtle"
        : item.danger
          ? "text-danger hover:bg-danger-bg focus:bg-danger-bg"
          : "text-text hover:bg-surface-sunken focus:bg-surface-sunken",
    );

  // Pointer and keyboard share one highlight: hovering an item focuses it, so the arrows carry on
  // from wherever the mouse left off.
  const followPointer = (e: MouseEvent<HTMLElement>) => {
    if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
  };

  function renderItem(item: ActionItem) {
    if (item.href && !item.disabled) {
      const common = {
        role: "menuitem",
        tabIndex: -1,
        className: itemClass(item),
        onClick: (e: MouseEvent<HTMLAnchorElement>) => choose(e, item),
        onMouseMove: followPointer,
      } as const;
      if (item.external) {
        return (
          <OutboundLink key={item.key} href={item.href} {...common}>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="sr-only"> (opens in a new tab)</span>
          </OutboundLink>
        );
      }
      return (
        <Link key={item.key} href={item.href} {...common}>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </Link>
      );
    }
    return (
      <button
        key={item.key}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled={item.disabled || undefined}
        onClick={(e) => choose(e, item)}
        onMouseMove={followPointer}
        className={itemClass(item)}
      >
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </button>
    );
  }

  return (
    <>
      <IconButton
        ref={triggerRef}
        icon={EllipsisVertical}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKeyDown}
        className={open ? "bg-surface-sunken text-text" : undefined}
      />
      <AnchoredPopover anchorRef={triggerRef} open={open} width={232} align={align}>
        <div ref={attachPanel} id={menuId} role="menu" aria-label={label} onKeyDown={onMenuKeyDown} onKeyUp={onMenuKeyUp} className="py-1">
          {sections.map((section) =>
            section.kind === "separator" ? (
              <div key={section.key} role="separator" className="my-1 h-px bg-line" />
            ) : section.heading ? (
              <div key={section.key} role="group" aria-labelledby={`${menuId}-${section.key}`}>
                <div id={`${menuId}-${section.key}`} aria-hidden="true" className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">
                  {section.heading}
                </div>
                {section.items.map(renderItem)}
              </div>
            ) : (
              <Fragment key={section.key}>{section.items.map(renderItem)}</Fragment>
            ),
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}
