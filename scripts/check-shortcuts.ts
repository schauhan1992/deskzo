/**
 * check:shortcuts — BUSY's shortcut keys in Deskzo (owner, 22 Oct 2026).
 *
 *   · Every entry of BUSY's own list (src/lib/shortcuts/busy-reference.json) is a Deskzo key, or folded into
 *     one with its reason written down — none is quietly dropped.
 *   · One key means one thing in each scope; a voucher form's or page's own key may stand in for a global one.
 *   · Nothing binds a key the browser never gives up (Ctrl+N, Ctrl+T, Ctrl+W).
 *   · Every page a key opens is a page that exists, gated on a link the person's menu has; every page key
 *     ("save", "next-record"…) is handled by the screens it is for; signing out and cancelling ask first.
 *   · Keys match on the key's place (so Option+B on a Mac is Alt+B), and the calculator adds up.
 *
 * No database.
 *
 *   npm run check:shortcuts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import reference from "../src/lib/shortcuts/busy-reference.json";
import { MENU_ENTRIES, RESERVED, SHORTCUTS, comboLabel, matches, shortcutFor, typesText, type Combo } from "../src/lib/shortcuts/busy";
import { calculate } from "../src/lib/shortcuts/calc";
import { MODULE_REGISTRY } from "../src/lib/modules";
import { SYSTEM_NAV } from "../src/lib/navigation";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const same = (a: Combo, b: Combo) => a.code === b.code && !!a.alt === !!b.alt && !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift;

section("Every BUSY entry");
const busyIds = reference.shortcuts.map((s) => s.id);
const covered = new Set(SHORTCUTS.flatMap((s) => s.busy));
const missing = busyIds.filter((id) => !covered.has(id));
ok(`all ${busyIds.length} of BUSY's entries are a Deskzo key`, missing.length === 0 && busyIds.length === 62, missing);
const unknown = [...covered].filter((id) => !busyIds.includes(id));
ok("  and no key claims a BUSY entry that isn't on BUSY's list", unknown.length === 0, unknown);
const folded = SHORTCUTS.filter((s) => s.busy.length > 1);
ok("  where two of BUSY's meanings share one key here, the key says what became of the other", folded.every((s) => !!s.note || s.busy.every((id) => ["print-record", "print-voucher", "switch-user", "switch-user-old-pdf", "stock-ledger", "item-ledger"].includes(id))), folded.filter((s) => !s.note).map((s) => s.id));
const conflicting = reference.shortcuts.filter((s) => s.confidence === "conflicting-official-sources").map((s) => s.id);
ok(`  BUSY's ${conflicting.length} entries whose sources disagree are each placed`, conflicting.every((id) => covered.has(id)));

section("One meaning per key");
for (const scope of ["global", "form", "record"] as const) {
  const keys = SHORTCUTS.filter((s) => s.scope === scope).flatMap((s) => s.keys.map((k) => ({ id: s.id, k })));
  const clashes = keys.filter((a, i) => keys.some((b, j) => j !== i && same(a.k, b.k) && a.id !== b.id)).map((x) => `${comboLabel(x.k)} (${x.id})`);
  ok(`${scope}: no key does two things`, clashes.length === 0, clashes);
}
const overrides = SHORTCUTS.filter((s) => s.scope !== "global").flatMap((s) =>
  s.keys.filter((k) => SHORTCUTS.some((g) => g.scope === "global" && g.keys.some((gk) => same(gk, k)))).map((k) => `${comboLabel(k)}: ${s.id}`),
);
ok("a page's own key stands in for a global one only where meant (Alt+P, Alt+O)", overrides.sort().join(", ") === ["Alt + O: pick-orders", "Alt + P: pending-batches"].join(", "), overrides);
const reserved = SHORTCUTS.flatMap((s) => s.keys.filter((k) => RESERVED.some((r) => same(r, k))).map((k) => `${comboLabel(k)} (${s.id})`));
ok("nothing is bound to Ctrl+N, Ctrl+T, Ctrl+W or Ctrl+Tab, which no page can take", reserved.length === 0, reserved);
const ctrlLetters = SHORTCUTS.flatMap((s) => s.keys.filter((k) => k.ctrl && !k.alt && k.code.startsWith("Key")).map((k) => comboLabel(k)));
ok("  and Ctrl with a letter only where BUSY means Ctrl itself (Ctrl+D, Ctrl+P) — copy, cut, find stay the browser's", ctrlLetters.sort().join() === ["Ctrl + D", "Ctrl + P"].join(), ctrlLetters);

section("Where the keys lead");
const navHrefs = new Set([...MODULE_REGISTRY.flatMap((m) => m.navItems.map((i) => i.href)), ...SYSTEM_NAV.flatMap((s) => s.items.map((i) => i.href))]);
const pageFile = (href: string) => {
  const p = href.split("?")[0]!;
  return existsSync(path.join(process.cwd(), "src/app/(dashboard)", p, "page.tsx"));
};
const goes = SHORTCUTS.flatMap((s) => (s.target.kind === "go" ? [{ id: s.id, href: s.target.href, needs: (Array.isArray(s.target.needs) ? s.target.needs : [s.target.needs]) as string[] }] : []));
ok("every page a key opens exists", goes.every((g) => pageFile(g.href)), goes.filter((g) => !pageFile(g.href)).map((g) => g.href));
ok("  and is gated on a link a menu can have", goes.every((g) => g.needs.every((n) => navHrefs.has(n))), goes.filter((g) => !g.needs.every((n) => navHrefs.has(n))).map((g) => g.id));
const menuRows = Object.values(MENU_ENTRIES).flat();
ok("every menu entry opens a page that exists, gated on a menu link", menuRows.every((e) => pageFile(e.href) && navHrefs.has(e.needs)), menuRows.filter((e) => !pageFile(e.href) || !navHrefs.has(e.needs)).map((e) => e.href));
ok("signing out, locking, deleting and cancelling ask first", ["switch-user", "lock", "delete-record", "cancel-record"].every((id) => SHORTCUTS.find((s) => s.id === id)?.confirms));

section("Every key has something to do");
const provider = read("src/components/shortcuts/shortcuts-provider.tsx");
const commands = [...new Set(SHORTCUTS.flatMap((s) => (s.target.kind === "command" ? [s.target.command] : [])))];
const unhandled = commands.filter((c) => !(c.startsWith("menu:") ? provider.includes('command.startsWith("menu:")') : provider.includes(`case "${c}"`)));
ok("the provider carries out every command", unhandled.length === 0, unhandled);
const screens: Record<string, { file: string; scope: "form" | "record"; ids: string[] }> = {
  "voucher form": { file: "src/components/accounting/vouchers/voucher-form.tsx", scope: "form", ids: ["save", "narration", "record-list", "change-type", "repeat", "delete-row", "copy-voucher", "paste-voucher"] },
  "stock voucher form": { file: "src/components/inventory/stock-document-form.tsx", scope: "form", ids: ["save", "record-list", "repeat", "delete-row", "pick-orders", "pending-batches", "copy-voucher", "paste-voucher"] },
  "voucher page": { file: "src/components/accounting/vouchers/voucher-actions.tsx", scope: "record", ids: ["previous-record", "next-record", "modify", "delete-record", "cancel-record", "copy-record"] },
  "stock voucher page": { file: "src/components/inventory/stock-document-actions.tsx", scope: "record", ids: ["previous-record", "next-record", "modify", "delete-record", "cancel-record", "copy-record"] },
};
for (const [name, { file, scope, ids }] of Object.entries(screens)) {
  const source = read(file);
  const has = (id: string) => new RegExp(`["']${id}["']\\s*:|[\\s{,]${id.replace(/-/g, "\\-")}\\s*:`).test(source);
  const lacking = ids.filter((id) => !has(id));
  ok(`the ${name} handles its keys`, source.includes(`useShortcuts("${scope}"`) && lacking.length === 0, lacking);
}
const pageIds = SHORTCUTS.filter((s) => s.target.kind === "page").map((s) => s.id);
const handledSomewhere = new Set(Object.values(screens).flatMap((s) => s.ids));
ok("  and no page key is left with no screen", pageIds.every((id) => handledSomewhere.has(id)), pageIds.filter((id) => !handledSomewhere.has(id)));
const layout = read("src/app/(dashboard)/layout.tsx");
ok("the dashboard mounts the keys, and the sign-out they submit is there", layout.includes("<ShortcutsProvider navigation={navigation} />") && layout.includes('id="deskzo-sign-out"'));
ok("the pickers' actions are the modules they read", read("src/lib/module-actions.ts").includes('"quick-pick.ts": ["accounting", "items"]'));

section("Keys as typed");
const ev = (code: string, mods: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}, key = "") => ({ code, key, altKey: !!mods.alt, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift });
ok("Alt+B is the balance sheet", shortcutFor(ev("KeyB", { alt: true }, "b"), "global")?.id === "balance-sheet");
ok("  Option+B on a Mac types ∫, and is still Alt+B", shortcutFor(ev("KeyB", { alt: true }, "∫"), "global")?.id === "balance-sheet");
ok("⌘ counts as Ctrl: ⌘+D is the stock ledger", shortcutFor(ev("KeyD", { meta: true }), "global")?.id === "stock-ledger");
ok("Alt+Shift+B is nothing", shortcutFor(ev("KeyB", { alt: true, shift: true }), "global") === null);
ok("Ctrl+Alt+T is the transactions menu, Alt+T the trial balance", shortcutFor(ev("KeyT", { ctrl: true, alt: true }), "global")?.id === "transactions-menu" && shortcutFor(ev("KeyT", { alt: true }), "global")?.id === "trial-balance");
ok("F2 is save on a form, nothing globally", shortcutFor(ev("F2"), "form")?.id === "save" && shortcutFor(ev("F2"), "global") === null);
ok("Page Down is the next record on a voucher's page", shortcutFor(ev("PageDown"), "record")?.id === "next-record");
ok("typing: a letter or Page Down is the field's; F7 and Alt+R are shortcuts", typesText(ev("KeyA")) && typesText(ev("PageDown")) && !typesText(ev("F7")) && !typesText(ev("KeyR", { alt: true })));
ok("matches() needs the modifiers exactly", matches(ev("F5", { alt: true }), { code: "F5", alt: true }) && !matches(ev("F5"), { code: "F5", alt: true }));
ok("\"?\" is shown as ?", comboLabel({ code: "Slash", shift: true }) === "?");

section("The calculator");
const sums: [string, number | null][] = [
  ["1,25,000 × 18%", 22500],
  ["1000*18%", 180],
  ["(2+3)*4", 20],
  ["0.1+0.2", 0.3],
  ["-5+3", -2],
  ["100 ÷ 8", 12.5],
  ["2 * (3 + (4 - 1))", 12],
  ["10/0", null],
  ["2+", null],
  ["abc", null],
  ["(1+2", null],
  ["1.2.3", null],
];
for (const [expr, want] of sums) {
  const r = calculate(expr);
  ok(`${expr} ${want === null ? "is refused" : `= ${want}`}`, want === null ? !r.ok : r.ok && r.value === want, r);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
