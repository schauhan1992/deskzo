/**
 * BUSY's shortcut keys in Deskzo (owner, 22 Oct 2026) — every entry of BUSY's own list
 * (src/lib/shortcuts/busy-reference.json, from busy.in's FAQ, guide and PDF) is either a key here or has a
 * written reason it can't be one, and `check:shortcuts` holds every one of them to that.
 *
 * Where BUSY's sources disagree on a key, the current official guide wins, and the other meaning is either
 * given its own key or noted. Where BUSY says "Alt/Ctrl", Deskzo takes both for the function keys and Alt
 * for the letters: Ctrl with a letter is the browser's and the text field's — find, select all, cut, copy,
 * a new tab — and Ctrl+N, Ctrl+T and Ctrl+W can't be taken from a browser at all.
 *
 * Three scopes, one key meaning one thing in each:
 *   · global — anywhere in the app: open a page, a menu, a picker, the calculator;
 *   · form — while a voucher or stock voucher is being written: save, repeat, delete a line, pick orders…;
 *   · record — on a voucher or stock voucher's own page: previous / next, modify, cancel, print, copy.
 * A form's or record's key is tried before a global one, so F12 copies the voucher on a voucher form.
 *
 * Pure: the provider (src/components/shortcuts) and the check read it. Opening a page through a key asks
 * nothing new — the page and its actions ask what they always ask; the key only isn't offered where the
 * person's own menu doesn't have the page.
 */

/** One key combination, matched on `KeyboardEvent.code` — the key's place, not the character it types. */
export type Combo = { code: string; alt?: boolean; ctrl?: boolean; shift?: boolean };

export type ShortcutScope = "global" | "form" | "record";

/** What the provider does for a global key. Form and record keys are the page's own (`useShortcuts`). */
export type ShortcutCommand =
  | "help-panel"
  | "shortcuts"
  | "calculator"
  | "notes-panel"
  | "print"
  | "sign-out"
  | "lock"
  | "pick-account-ledger"
  | "pick-item"
  | "pick-item-ledger"
  | "focus-menu-search"
  | `menu:${MenuKey}`;

export type MenuKey = "main" | "masters" | "administration" | "transactions" | "display" | "printing" | "help" | "favourites";

export type ShortcutTarget =
  | { kind: "go"; href: string; /** The menu link the person must have for the key to be theirs. */ needs: string | readonly string[] }
  | { kind: "command"; command: ShortcutCommand }
  /** The page's own handler, registered with `useShortcuts` while that page is open. */
  | { kind: "page" };

export type Shortcut = {
  id: string;
  keys: Combo[];
  /** What it does in Deskzo. */
  label: string;
  scope: ShortcutScope;
  category: "Create" | "Reports" | "Menus" | "Tools" | "Voucher entry" | "Records";
  target: ShortcutTarget;
  /** The BUSY entries (busy-reference.json ids) this key is. */
  busy: string[];
  /** Said in the shortcuts list: a browser it differs in, what it does instead of BUSY's other meaning. */
  note?: string;
  /** Asks first: it cancels, reverses or signs out. */
  confirms?: boolean;
};

const F = (n: number): Combo => ({ code: `F${n}` });
const altF = (n: number): Combo => ({ code: `F${n}`, alt: true });
const ctrlF = (n: number): Combo => ({ code: `F${n}`, ctrl: true });
const alt = (letter: string): Combo => ({ code: `Key${letter}`, alt: true });
const ctrl = (letter: string): Combo => ({ code: `Key${letter}`, ctrl: true });
const ctrlAlt = (letter: string): Combo => ({ code: `Key${letter}`, ctrl: true, alt: true });

export const SHORTCUTS: Shortcut[] = [
  // ── Create ─────────────────────────────────────────────────────────────────────────────────────
  { id: "new-account", keys: [altF(1), ctrlF(1)], label: "New account in the chart of accounts", scope: "global", category: "Create", target: { kind: "go", href: "/accounting/accounts?new=1", needs: "/accounting/accounts" }, busy: ["add-account"] },
  { id: "new-item", keys: [altF(2), ctrlF(2)], label: "New item", scope: "global", category: "Create", target: { kind: "go", href: "/items/new", needs: "/items" }, busy: ["add-item"] },
  { id: "new-master", keys: [F(3)], label: "New master — account, item, customer or vendor, warehouse, unit", scope: "global", category: "Create", target: { kind: "command", command: "menu:masters" }, busy: ["add-master"], note: "F3 is the browser's find-next; Ctrl+F still finds." },
  { id: "new-voucher", keys: [altF(3), ctrlF(3)], label: "New voucher", scope: "global", category: "Create", target: { kind: "go", href: "/accounting/vouchers/new", needs: "/accounting/vouchers" }, busy: ["add-voucher"] },
  {
    id: "new-payment", keys: [altF(5), ctrlF(5)], label: "New payment voucher", scope: "global", category: "Create",
    target: { kind: "go", href: "/accounting/vouchers/new?type=PAYMENT", needs: "/accounting/vouchers" }, busy: ["add-payment", "payment-voucher-quick-tip"],
    note: "F5 alone stays the browser's reload (and the list of records on a voucher form); BUSY's quick-tip F5 for a payment is Alt+F5 here. Ctrl+F5 no longer hard-reloads on Deskzo's pages.",
  },
  { id: "new-receipt", keys: [altF(6), ctrlF(6)], label: "New receipt voucher", scope: "global", category: "Create", target: { kind: "go", href: "/accounting/vouchers/new?type=RECEIPT", needs: "/accounting/vouchers" }, busy: ["add-receipt"] },
  { id: "new-journal", keys: [altF(7), ctrlF(7)], label: "New journal voucher", scope: "global", category: "Create", target: { kind: "go", href: "/accounting/vouchers/new?type=JOURNAL", needs: "/accounting/vouchers" }, busy: ["add-journal"] },
  { id: "new-sales", keys: [altF(8), ctrlF(8)], label: "New tax invoice (sales)", scope: "global", category: "Create", target: { kind: "go", href: "/documents/new?type=INVOICE", needs: "/sales/invoices" }, busy: ["add-sales"] },
  { id: "new-purchase", keys: [altF(9), ctrlF(9)], label: "New vendor bill (purchase)", scope: "global", category: "Create", target: { kind: "go", href: "/documents/new?type=BILL", needs: "/purchase/bills" }, busy: ["add-purchase"] },

  // ── Reports ────────────────────────────────────────────────────────────────────────────────────
  { id: "balance-sheet", keys: [alt("B")], label: "Balance sheet", scope: "global", category: "Reports", target: { kind: "go", href: "/accounting/balance-sheet", needs: "/accounting/balance-sheet" }, busy: ["balance-sheet"] },
  { id: "trial-balance", keys: [alt("T")], label: "Trial balance", scope: "global", category: "Reports", target: { kind: "go", href: "/accounting/trial-balance", needs: "/accounting/trial-balance" }, busy: ["trial-balance"], note: "Ctrl+T opens a browser tab and can't be taken; Alt+T it is." },
  {
    id: "stock-status", keys: [alt("S")], label: "Stock status — every item on hand, by value", scope: "global", category: "Reports",
    target: { kind: "go", href: "/items/stock-reports?report=summary", needs: "/items/stock-reports" }, busy: ["stock-status", "call-search"],
    note: "BUSY's call search on Alt+S isn't a Deskzo screen: a call is found from the search box at the top (\"/\").",
  },
  { id: "account-summary", keys: [alt("A")], label: "Account summary — the Accounts overview", scope: "global", category: "Reports", target: { kind: "go", href: "/accounting", needs: "/accounting" }, busy: ["account-summary"] },
  { id: "account-ledger", keys: [alt("L")], label: "Account ledger — pick an account", scope: "global", category: "Reports", target: { kind: "command", command: "pick-account-ledger" }, busy: ["account-ledger"] },
  { id: "item-summary", keys: [alt("I")], label: "Item summary — pick an item: its stock by warehouse, batch and movement", scope: "global", category: "Reports", target: { kind: "command", command: "pick-item" }, busy: ["item-summary"] },
  {
    id: "stock-ledger", keys: [ctrl("D")], label: "Stock (item) ledger — pick an item", scope: "global", category: "Reports", target: { kind: "command", command: "pick-item-ledger" }, busy: ["stock-ledger", "item-ledger"],
    note: "Instead of the browser's bookmark. BUSY's older Alt+G for the item ledger is the GST summary here, as BUSY's own FAQ has it now.",
  },
  { id: "gst-summary", keys: [alt("G")], label: "GST summary — output against input tax", scope: "global", category: "Reports", target: { kind: "go", href: "/accounting/registers?register=gst", needs: "/accounting/registers" }, busy: ["gst-summary"] },
  { id: "vat-summary", keys: [alt("V")], label: "GST returns (VAT's successor) — GSTR-1 and GSTR-3B", scope: "global", category: "Reports", target: { kind: "go", href: "/accounting/gst", needs: "/accounting/gst" }, busy: ["vat-summary"] },
  { id: "query-transactions", keys: [alt("Q")], label: "Query on transactions — the day book, searchable", scope: "global", category: "Reports", target: { kind: "go", href: "/accounting/day-book", needs: "/accounting/day-book" }, busy: ["query-transactions"] },
  { id: "pending-orders", keys: [alt("O")], label: "Pending orders", scope: "global", category: "Reports", target: { kind: "go", href: "/orders", needs: "/orders" }, busy: ["pending-orders"], note: "On a goods receipt, Alt+O picks lines from an open purchase order instead." },
  { id: "pending-challans", keys: [alt("C")], label: "Delivery challans", scope: "global", category: "Reports", target: { kind: "go", href: "/sales/challans", needs: "/sales/challans" }, busy: ["pending-challans"] },

  // ── Tools ──────────────────────────────────────────────────────────────────────────────────────
  { id: "help", keys: [F(1)], label: "Help for this page", scope: "global", category: "Tools", target: { kind: "command", command: "help-panel" }, busy: ["help-online"] },
  { id: "shortcuts", keys: [{ code: "Slash", shift: true }], label: "This list of shortcut keys", scope: "global", category: "Tools", target: { kind: "command", command: "shortcuts" }, busy: [], note: "\"?\" — Deskzo's own, outside a text field." },
  { id: "calculator", keys: [F(10)], label: "Calculator", scope: "global", category: "Tools", target: { kind: "command", command: "calculator" }, busy: ["calculator"] },
  { id: "configuration", keys: [alt("F")], label: "Configuration — Accounts settings (or Settings)", scope: "global", category: "Tools", target: { kind: "go", href: "/items/settings", needs: ["/items/settings", "/settings"] }, busy: ["configuration"] },
  { id: "import-export", keys: [alt("E")], label: "Data import & export", scope: "global", category: "Tools", target: { kind: "go", href: "/settings/data", needs: "/settings/data" }, busy: ["data-import-export"] },
  { id: "notes", keys: [alt("N")], label: "Notes — your sticky notes", scope: "global", category: "Tools", target: { kind: "command", command: "notes-panel" }, busy: ["notes-manager"], note: "Ctrl+N opens a browser window and can't be taken; Alt+N it is." },
  { id: "implementation-notes", keys: [{ code: "KeyN", ctrl: true, alt: true, shift: true }], label: "Implementation notes — your sticky notes", scope: "global", category: "Tools", target: { kind: "command", command: "notes-panel" }, busy: ["implementation-notes"] },
  { id: "print", keys: [alt("P"), ctrl("P")], label: "Print this page or record", scope: "global", category: "Tools", target: { kind: "command", command: "print" }, busy: ["print-record", "print-voucher", "mrp-wise-stock"], note: "Deskzo keeps no MRP-wise stock, BUSY's older Alt+P; on a stock voucher's form Alt+P shows pending batches." },
  {
    id: "switch-user", keys: [alt("U"), { code: "KeyU", ctrl: true, alt: true }], label: "Switch user — sign out, to sign in as somebody else", scope: "global", category: "Tools", target: { kind: "command", command: "sign-out" }, busy: ["switch-user", "switch-user-old-pdf", "utilities"], confirms: true,
    note: "BUSY's older Utilities on Alt+U: Deskzo's utilities are the tools down the right-hand edge (GST & margin, pro-rata, currency, GSTIN check).",
  },
  { id: "lock", keys: [alt("K")], label: "Lock — sign out, leaving nothing open", scope: "global", category: "Tools", target: { kind: "command", command: "lock" }, busy: ["lock-program"], confirms: true },

  // ── Menus ──────────────────────────────────────────────────────────────────────────────────────
  { id: "main-menu", keys: [ctrlAlt("M")], label: "Main menu — find any page", scope: "global", category: "Menus", target: { kind: "command", command: "menu:main" }, busy: ["main-menu"] },
  { id: "administration-menu", keys: [ctrlAlt("A")], label: "Administration menu", scope: "global", category: "Menus", target: { kind: "command", command: "menu:administration" }, busy: ["administration-menu"] },
  { id: "transactions-menu", keys: [ctrlAlt("T")], label: "Transactions menu — every voucher and document to raise", scope: "global", category: "Menus", target: { kind: "command", command: "menu:transactions" }, busy: ["transactions-menu"], note: "On a Linux desktop Ctrl+Alt+T opens a terminal before the browser sees it." },
  {
    id: "display-menu", keys: [ctrlAlt("D")], label: "Display menu — every report", scope: "global", category: "Menus", target: { kind: "command", command: "menu:display" }, busy: ["display-menu", "batch-delete"],
    note: "Not BUSY's batch deletion: Deskzo never deletes vouchers or masters in bulk — each is cancelled or reversed on its own, and stays on record.",
  },
  { id: "printing-menu", keys: [ctrlAlt("P")], label: "Printing menu", scope: "global", category: "Menus", target: { kind: "command", command: "menu:printing" }, busy: ["printing-menu"] },
  { id: "help-menu", keys: [ctrlAlt("H")], label: "Help menu", scope: "global", category: "Menus", target: { kind: "command", command: "menu:help" }, busy: ["help-menu"] },
  { id: "favourites-menu", keys: [ctrlAlt("F")], label: "Favourites menu — the pages you starred", scope: "global", category: "Menus", target: { kind: "command", command: "menu:favourites" }, busy: ["favourites-menu"] },

  // ── Voucher entry (a voucher's or stock voucher's form) ───────────────────────────────────────
  { id: "save", keys: [F(2)], label: "Save", scope: "form", category: "Voucher entry", target: { kind: "page" }, busy: ["save-voucher"] },
  { id: "narration", keys: [F(4)], label: "Standard narration — pick one used before", scope: "form", category: "Voucher entry", target: { kind: "page" }, busy: ["narration-bom-help"], note: "Deskzo has no bills of material, BUSY's other F4." },
  { id: "record-list", keys: [F(5)], label: "List of records of this kind", scope: "form", category: "Voucher entry", target: { kind: "page" }, busy: ["record-list"] },
  { id: "change-type", keys: [F(6)], label: "Change voucher type", scope: "form", category: "Voucher entry", target: { kind: "page" }, busy: ["change-voucher-type"] },
  { id: "repeat", keys: [F(7), alt("R")], label: "Repeat the value above, in this column", scope: "form", category: "Voucher entry", target: { kind: "page" }, busy: ["repeat-last-value"] },
  { id: "delete-row", keys: [F(9)], label: "Delete this line", scope: "form", category: "Voucher entry", target: { kind: "page" }, busy: ["delete-grid-row"] },
  {
    id: "pick-orders", keys: [F(11), alt("O")], label: "Pick lines from a pending purchase order", scope: "form", category: "Voucher entry", target: { kind: "page" }, busy: ["pick-order-data", "change-financial-year"],
    note: "BUSY's quick-tip F11 changes the financial year; Deskzo's reports take any dates, so there's no year to switch.",
  },
  { id: "pending-batches", keys: [alt("P")], label: "Pending batches of this line's item", scope: "form", category: "Voucher entry", target: { kind: "page" }, busy: ["pending-batches"] },
  {
    id: "copy-voucher", keys: [F(12)], label: "Copy this voucher", scope: "form", category: "Voucher entry", target: { kind: "page" }, busy: ["copy-voucher", "switch-tax-type"],
    note: "Some browsers keep F12 for their developer tools. Deskzo works tax out from each document's place of supply, so BUSY's tax-type switch has nothing to switch.",
  },
  { id: "paste-voucher", keys: [altF(12)], label: "Fill this voucher from the one copied", scope: "form", category: "Voucher entry", target: { kind: "page" }, busy: ["paste-voucher"] },

  // ── Records (a voucher's or stock voucher's page) ─────────────────────────────────────────────
  { id: "previous-record", keys: [{ code: "PageUp" }], label: "Previous record", scope: "record", category: "Records", target: { kind: "page" }, busy: ["previous-record"] },
  { id: "next-record", keys: [{ code: "PageDown" }], label: "Next record", scope: "record", category: "Records", target: { kind: "page" }, busy: ["next-record"] },
  { id: "modify", keys: [alt("M")], label: "Modify (a draft)", scope: "record", category: "Records", target: { kind: "page" }, busy: ["modify-master"] },
  { id: "delete-record", keys: [F(8)], label: "Delete — a draft is cancelled, a posted one reversed, both kept on record", scope: "record", category: "Records", target: { kind: "page" }, busy: ["delete-master-voucher"], confirms: true },
  { id: "cancel-record", keys: [alt("X")], label: "Cancel voucher", scope: "record", category: "Records", target: { kind: "page" }, busy: ["cancel-activate-voucher"], confirms: true, note: "A cancelled voucher isn't brought back: write it again, or copy it (F12) into a new one." },
  { id: "copy-record", keys: [F(12)], label: "Copy this voucher, to paste into a new one", scope: "record", category: "Records", target: { kind: "page" }, busy: ["copy-voucher"] },
];

/** The browser's own, which no page can take — never bound, so a key is never promised and then lost. */
export const RESERVED: Combo[] = [ctrl("N"), ctrl("T"), ctrl("W"), { code: "Tab", ctrl: true }];

// ─── Matching ────────────────────────────────────────────────────────────────────────────────────

type KeyEventLike = { code: string; key?: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/** Whether a key event is this combination. Command (⌘) on a Mac counts as Ctrl. */
export function matches(event: KeyEventLike, combo: Combo): boolean {
  const ctrlDown = event.ctrlKey || event.metaKey;
  return event.code === combo.code && event.altKey === !!combo.alt && ctrlDown === !!combo.ctrl && event.shiftKey === !!combo.shift;
}

/** The shortcut a key event is, in a scope, if any. */
export function shortcutFor(event: KeyEventLike, scope: ShortcutScope, list: readonly Shortcut[] = SHORTCUTS): Shortcut | null {
  return list.find((s) => s.scope === scope && s.keys.some((k) => matches(event, k))) ?? null;
}

/** "Alt + F5", "Ctrl + Alt + T", "?" — as the list shows a key. */
export function comboLabel(combo: Combo): string {
  if (combo.code === "Slash" && combo.shift && !combo.alt && !combo.ctrl) return "?";
  const key = combo.code.startsWith("Key") ? combo.code.slice(3) : combo.code === "PageUp" ? "Page Up" : combo.code === "PageDown" ? "Page Down" : combo.code;
  return [combo.ctrl && "Ctrl", combo.alt && "Alt", combo.shift && "Shift", key].filter(Boolean).join(" + ");
}

/**
 * Whether a key is one to leave alone while somebody types: a plain character, or Shift with one. Function
 * keys and Alt or Ctrl combinations are shortcuts in a field too — that is where F2 saves and F7 repeats.
 */
export function typesText(event: KeyEventLike): boolean {
  if (/^F\d+$/.test(event.code)) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return true;
}

/** The shortcut with this id. */
export function shortcut(id: string): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

// ─── The menus (Ctrl + Alt + …) ──────────────────────────────────────────────────────────────────

export type MenuEntry = { label: string; href: string; /** Hidden unless the person's menu has this link. */ needs: string; hint?: string };

/** What each menu lists beyond the person's own menu links (the main menu is all of those). */
export const MENU_ENTRIES: Record<Exclude<MenuKey, "main" | "favourites" | "display" | "administration">, MenuEntry[]> = {
  masters: [
    { label: "New account", href: "/accounting/accounts?new=1", needs: "/accounting/accounts", hint: "Chart of accounts" },
    { label: "New item", href: "/items/new", needs: "/items" },
    { label: "New customer or vendor", href: "/companies/new", needs: "/companies" },
    { label: "New warehouse", href: "/items/warehouses?new=1", needs: "/items/warehouses" },
    { label: "New unit of measure", href: "/items/units?new=1", needs: "/items/units" },
    { label: "New brand or family", href: "/items/brands", needs: "/items/brands" },
  ],
  transactions: [
    { label: "Payment voucher", href: "/accounting/vouchers/new?type=PAYMENT", needs: "/accounting/vouchers" },
    { label: "Receipt voucher", href: "/accounting/vouchers/new?type=RECEIPT", needs: "/accounting/vouchers" },
    { label: "Contra voucher", href: "/accounting/vouchers/new?type=CONTRA", needs: "/accounting/vouchers" },
    { label: "Journal voucher", href: "/accounting/vouchers/new?type=JOURNAL", needs: "/accounting/vouchers" },
    { label: "Tax invoice", href: "/documents/new?type=INVOICE", needs: "/sales/invoices" },
    { label: "Proforma invoice", href: "/documents/new?type=PROFORMA", needs: "/sales/proformas" },
    { label: "Proposal", href: "/documents/new?type=PROPOSAL", needs: "/sales/proposals" },
    { label: "Credit note", href: "/documents/new?type=CREDIT_NOTE", needs: "/sales/credit-notes" },
    { label: "Delivery challan", href: "/documents/new?type=DELIVERY_CHALLAN", needs: "/sales/challans" },
    { label: "Purchase order", href: "/documents/new?type=PURCHASE_ORDER", needs: "/purchase/orders" },
    { label: "Vendor bill", href: "/documents/new?type=BILL", needs: "/purchase/bills" },
    { label: "Goods receipt (GRN)", href: "/items/stock/new?type=GRN", needs: "/items/receipts" },
    { label: "Stock transfer", href: "/items/stock/new?type=TRANSFER", needs: "/items/stock" },
    { label: "Stock adjustment", href: "/items/stock/new?type=ADJUSTMENT", needs: "/items/stock" },
    { label: "Physical stock count", href: "/items/stock/new?type=PHYSICAL_COUNT", needs: "/items/stock" },
    { label: "Purchase return", href: "/items/stock/new?type=PURCHASE_RETURN", needs: "/items/stock" },
    { label: "Journal entry", href: "/accounting/journal", needs: "/accounting/journal" },
  ],
  printing: [
    { label: "Tax invoices — open one to print or download it", href: "/sales/invoices", needs: "/sales/invoices" },
    { label: "Delivery challans", href: "/sales/challans", needs: "/sales/challans" },
    { label: "Purchase orders", href: "/purchase/orders", needs: "/purchase/orders" },
    { label: "Vouchers", href: "/accounting/vouchers", needs: "/accounting/vouchers" },
    { label: "Stock vouchers", href: "/items/stock", needs: "/items/stock" },
    { label: "Registers — export as CSV", href: "/accounting/registers", needs: "/accounting/registers" },
  ],
  help: [],
};

/** Favourites are kept in this browser, per person's own use of it — a convenience, not a record. */
export const FAVOURITES_STORAGE_KEY = "deskzo.shortcuts.favourites";
/** "off" turns BUSY's keys off in this browser ("?" still opens the list, where they are turned back on). */
export const SHORTCUTS_STORAGE_KEY = "deskzo.shortcuts";
