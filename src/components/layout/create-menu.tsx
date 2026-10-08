"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  Building2,
  ChevronDown,
  FileText,
  MapPin,
  Plus,
  ShoppingCart,
  StickyNote,
  Target,
  Ticket,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { NoteDialog } from "@/components/notes/note-dialog";
import { useWording } from "@/components/terms/wording-provider";
import { slot, type TermKey } from "@/lib/terms/dictionary";
import { getModuleDefinition } from "@/lib/modules";
import { sectionPermission, type PermissionKey } from "@/lib/permissions";

/**
 * The header's "Create" button: one place to start any of the records somebody makes several times
 * a day, instead of navigating to a module first and hunting for its New button.
 *
 * Entries are hidden rather than disabled when the module is off or the permission is missing, for
 * the reason the comment on NavItem in src/lib/modules.ts gives for the sidebar: a module toggle
 * answers "does this company use the feature" and a permission answers "is it any use to this
 * person", and showing a greyed-out row for either one only advertises a door that will not open.
 *
 * This builds the trigger itself rather than using the shared Menu, whose button is deliberately a
 * bordered secondary one — this is the header's single primary action and restyling the shared
 * component to suit it would change every "More" menu in the app. The panel, the section labels and
 * the separators are still the shared pieces.
 */

type CreateEntry = {
  label: string;
  /** The word the label is built from, for a workspace with its own (src/lib/terms). */
  term?: { key: TermKey; template: string };
  icon: LucideIcon;
  /** Module key from src/lib/modules.ts that owns the destination route. */
  module: string;
  permission?: string;
  /** A destination, or the sticky-note dialog, which has no page of its own to link to. */
  href?: string;
};

const SECTIONS: { group: string; entries: CreateEntry[] }[] = [
  {
    group: "Sales",
    entries: [
      { label: "New lead", term: { key: "lead", template: "New {one:lower}" }, icon: Target, module: "companies", permission: "leads.view", href: "/leads/new" },
      // One entry, not two. There is no separate "customer" record to create: /customers lists
      // CLIENT companies that have bought something (`customerListWhere` in src/actions/company.ts
      // filters on `products: { some: {} }`), and a company becomes one by ordering, not by being
      // typed in differently. /companies/new takes no `stage` — it hardcodes the CLIENT track — so
      // a second "Add customer" row pointing at it with a query string appended would open the
      // identical blank form and quietly ignore the parameter.
      { label: "Add company", term: { key: "company", template: "Add {one:lower}" }, icon: Building2, module: "companies", href: "/companies/new" },
      // Proposals live under Sales Documents, which owns every trade document type; the blank form
      // is the shared /documents/new page narrowed by ?type=.
      { label: "New proposal", icon: FileText, module: "sales_documents", href: "/documents/new?type=PROPOSAL" },
      { label: "New order", term: { key: "order", template: "New {one:lower}" }, icon: ShoppingCart, module: "orders", href: "/orders/new" },
    ],
  },
  {
    group: "Support & field",
    entries: [
      { label: "New ticket", term: { key: "ticket", template: "New {one:lower}" }, icon: Ticket, module: "helpdesk", permission: "tickets.create", href: "/tickets/new" },
      { label: "New visit", term: { key: "visit", template: "New {one:lower}" }, icon: MapPin, module: "visits", href: "/visits/new" },
    ],
  },
  {
    group: "Finance",
    entries: [{ label: "New expense", icon: Wallet, module: "expenses", href: "/expenses/new" }],
  },
  {
    group: "My work",
    entries: [{ label: "New sticky note", icon: StickyNote, module: "notes" }],
  },
];

const itemClass =
  "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-text transition-colors hover:bg-surface-sunken";

export function CreateMenu({
  enabledKeys,
  permissions,
  canBroadcastNotes,
}: {
  enabledKeys: string[];
  permissions: string[];
  canBroadcastNotes: boolean;
}) {
  const wording = useWording();
  const labelOf = (entry: CreateEntry) => (entry.term ? slot(wording, entry.label, entry.term.key, entry.term.template) : entry.label);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (anchorRef.current?.contains(target)) return;
      // The panel is portalled to <body>, so it is not inside the anchor — without this, mousedown
      // on an item would close the menu and the click would never reach the item.
      if (target?.closest?.("[data-create-menu-panel]")) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Escape should leave the keyboard where it started, not adrift at the top of the document.
      anchorRef.current?.focus();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * Only what this person may open (owner, 8 Oct 2026): the module on, its section not unticked for
   * their role, its view permission held — as the sidebar decides — and the entry's own permission.
   */
  const mayOpen = (moduleKey: string) => {
    const def = getModuleDefinition(moduleKey);
    return (
      enabledKeys.includes(moduleKey) &&
      permissions.includes(sectionPermission(moduleKey) as PermissionKey) &&
      (!def?.viewPermission || permissions.includes(def.viewPermission))
    );
  };
  const sections = SECTIONS.map(({ group, entries }) => ({
    group,
    entries: entries.filter((e) => mayOpen(e.module) && (!e.permission || permissions.includes(e.permission))),
  })).filter((section) => section.entries.length > 0);

  const notesEnabled = mayOpen("notes");

  // Every module off and every permission missing leaves a button that opens an empty panel, which
  // reads as broken rather than as absent.
  if (sections.length === 0) return null;

  return (
    <>
      <Button
        ref={anchorRef}
        type="button"
        variant="primary"
        aria-label="Create"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // The header is tight on a phone, so the label and chevron drop away and the plus carries
        // the button on its own; the aria-label keeps its name either way.
        className="px-2.5 sm:px-3.5"
      >
        <Plus className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline">Create</span>
        <ChevronDown className={`hidden h-3.5 w-3.5 transition-transform sm:block ${open ? "rotate-180" : ""}`} />
      </Button>

      <AnchoredPopover anchorRef={anchorRef} open={open} width={232} maxHeight={480} align="end">
        <div role="menu" data-create-menu-panel className="py-1">
          {sections.map((section, index) => (
            <div key={section.group}>
              {index > 0 && <MenuSeparator />}
              <MenuLabel>{section.group}</MenuLabel>
              {section.entries.map((entry) => {
                const Icon = entry.icon;
                return entry.href ? (
                  <Link key={entry.label} href={entry.href} role="menuitem" className={itemClass} onClick={() => setOpen(false)}>
                    <Icon className="h-4 w-4 shrink-0 text-subtle" />
                    {labelOf(entry)}
                  </Link>
                ) : (
                  <button
                    key={entry.label}
                    type="button"
                    role="menuitem"
                    className={itemClass}
                    onClick={() => {
                      setOpen(false);
                      setNoteOpen(true);
                    }}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-subtle" />
                    {labelOf(entry)}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </AnchoredPopover>

      {/* Portalled to <body>, and this is not optional here.
       *
       * `Dialog` positions itself with `fixed inset-0 z-50` and renders in place. That works
       * everywhere else in the app because it is mounted inside <main>. This component lives in the
       * dashboard header, which carries `backdrop-blur-md` — and an element with a filter or
       * backdrop-filter becomes the containing block for its fixed-position descendants. Left where
       * it is, `inset-0` would resolve to the 56px header strip rather than the viewport, so the
       * composer would be squashed into the top bar and clipped by it.
       *
       * The header is also `sticky z-20`, which is its own stacking context, so the dialog's z-50
       * would only ever be z-50 *within the header* — the create menu's own panel, portalled to
       * <body> at z-50, would paint straight over the top of it.
       *
       * Mounted only while open, so `document` is never touched during SSR or hydration: `noteOpen`
       * starts false and can only be flipped by a click. */}
      {notesEnabled &&
        noteOpen &&
        createPortal(
          <NoteDialog open onClose={() => setNoteOpen(false)} canBroadcast={canBroadcastNotes} />,
          document.body,
        )}
    </>
  );
}
