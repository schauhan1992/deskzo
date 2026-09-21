/**
 * Every form control in the app has a name a screen reader can read out.
 *
 * A control with no accessible name is announced as "edit text, blank" — or, for a select, just
 * "combo box". On the employee form, which has twenty-nine of them, that is a form nobody can fill
 * in without sight. Nothing about it looks wrong: the label is sitting right there on screen, it is
 * simply not connected to anything, and no amount of careful visual review finds that.
 *
 * Which is exactly why it is checked here rather than trusted. 289 controls were unnamed when this
 * was written, across 89 files, every one of them added by somebody who could see the label.
 *
 * ## The scanner is checked first, and that is not ceremony
 *
 * This suite is worth nothing if the scan under-reports. A scanner that quietly returns zero looks
 * identical to a codebase with no problems, and would let the whole thing rot while reporting green
 * every time. So the fixtures below assert both directions — that real names are recognised, and
 * that the specific ways a control can *look* named while being anonymous are caught.
 *
 *   npm run check:a11y
 */
import { scanFile, scanTree } from "./lib/a11y-scan";

let failures = 0;

function ok(label: string, pass: boolean, detail: string | number | null = "") {
  if (!pass) failures++;
  const mark = pass ? " ok  " : " FAIL";
  console.log(`${mark}  ${label}${detail === "" || detail === null ? "" : ` — ${detail}`}`);
}

function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

/** One fixture file, scanned. */
const scan = (source: string) => scanFile("fixture.tsx", source);
const unnamedCount = (source: string) => scan(source).unnamed.length;
const namedCount = (source: string) => scan(source).named.length;

section("The scanner recognises a real name");

ok(
  "an aria-label names a control",
  unnamedCount(`<Input aria-label="Billing address" value={v} />`) === 0,
);
ok(
  "so does aria-labelledby",
  unnamedCount(`<Select aria-labelledby={headingId}>{opts}</Select>`) === 0,
);
ok(
  "a Label htmlFor pointing at the control's id names it",
  unnamedCount(`<Label htmlFor="city">City</Label><Input id="city" />`) === 0,
);
ok(
  "  and it works through a braced expression on both sides",
  unnamedCount(`<Label htmlFor={cityId}>City</Label><Input id={cityId} />`) === 0,
);
ok(
  "a control wrapped inside a label is named by it",
  unnamedCount(`<label><input type="checkbox" checked={on} /> Active</label>`) === 0,
);
ok(
  "  which is how nearly every checkbox in this app is written",
  namedCount(`<label className="flex gap-2"><Input type="checkbox" /> Include cancelled</label>`) === 1,
);

section("And catches the ways one can look named without being named");

/**
 * The four that matter, because all four are invisible on screen and all four appear in this
 * codebase. Each of these renders identically to its correct version.
 */
ok(
  "an id with no label pointing at it names nothing",
  unnamedCount(`<Input id="city" />`) === 1,
);
ok(
  "a Label with no htmlFor is a caption, not a label",
  unnamedCount(`<Label>City</Label><Input id="city" />`) === 1,
);
ok(
  "  and the caption itself is reported",
  scan(`<Label>City</Label><Input id="city" />`).captionOnlyLabels.length === 1,
);
ok(
  "a htmlFor pointing at a different id names nothing",
  unnamedCount(`<Label htmlFor="town">City</Label><Input id="city" />`) === 1,
);
/**
 * Stricter than the browser, deliberately.
 *
 * Chrome will fall back to `placeholder` as a last-resort accessible name, so this control is not
 * *technically* nameless — checked against the real accessibility tree, not assumed. It is still
 * treated as a failure here, for two reasons that hold in this codebase: a placeholder disappears
 * the moment somebody types, taking the name with it at exactly the point they might want to
 * re-check what they are filling in; and half the placeholders here are format hints rather than
 * names — "27AABCW1234F1ZV" is not what anybody calls that field.
 *
 * Do not relax this to match the browser. The browser's fallback exists to salvage bad markup.
 */
ok(
  "a placeholder is not a name",
  unnamedCount(`<Input placeholder="Search companies…" />`) === 1,
);
ok(
  "  nor is a name attribute, which is for form submission",
  unnamedCount(`<input type="search" name="q" />`) === 1,
);
ok(
  "a bare Select is reported",
  unnamedCount(`<Select value={v} onChange={f}><option>A</option></Select>`) === 1,
);
ok(
  "a bare Textarea is reported",
  unnamedCount(`<Textarea value={v} onChange={f} />`) === 1,
);

section("And does not read prose as markup");

/**
 * This codebase comments heavily, and prose about markup contains markup — the period filter
 * describes itself as "a bare <select> styled to look like text" directly above the control. The
 * scan read that sentence as a second, unnamed select. The only way to satisfy a check like that is
 * to reword the comment, which is a tool teaching people to write worse comments.
 */
ok(
  "a tag named inside a JSX comment is not a control",
  unnamedCount(`{/* A bare <select> styled to look like text */}<select aria-label="Period">{o}</select>`) === 0,
);
ok(
  "  nor one in a line comment",
  unnamedCount(`// falls back to <Input /> when empty
<Input aria-label="Seats" />`) === 0,
);
ok(
  "  nor one in a block comment above the control",
  unnamedCount(`/** Renders an <Input> per row. */
<Input aria-label="Qty" />`) === 0,
);
ok(
  "but a real control after a comment is still seen",
  unnamedCount(`{/* the filter */}<Select value={v}>{o}</Select>`) === 1,
  "blanking must not swallow what follows it",
);
ok(
  "  and line numbers survive the blanking",
  scan(`// a comment mentioning <Input />

<Select value={v}>{o}</Select>`).unnamed[0]?.line === 3,
  "offsets are preserved, not removed",
);

section("And catches the fix that is worse than the problem");

/**
 * A hardcoded id inside a `.map()` is the way a bulk naming pass goes wrong.
 *
 * It reads as *more* correct than leaving the control unnamed — there is an id, there is a label
 * pointing at it, and the unnamed count goes down. But ids must be unique in a document, so every
 * row's label resolves to the first row's control: clicking the label on row nine focuses row one,
 * and a screen reader announces the same name nine times with no way to tell the rows apart. The
 * page looks unchanged, so nothing about it invites a second look.
 *
 * Reported separately from `unnamed` because it is a different mistake with a different remedy.
 */
ok(
  "a literal id inside a map is flagged",
  scan(`{rows.map((r) => (<div key={r.key}><Label htmlFor="debit">Debit</Label><Input id="debit" /></div>))}`).duplicateIdRisks.length === 1,
);
ok(
  "  and it still counts as named, so the two are told apart",
  scan(`{rows.map((r) => (<div key={r.key}><Label htmlFor="debit">Debit</Label><Input id="debit" /></div>))}`).unnamed.length === 0,
  "an id that resolves is not the same problem as no id at all",
);
ok(
  "an id derived from the row is not flagged",
  scan("{rows.map((r) => (<div key={r.key}><Label htmlFor={`debit-${r.key}`}>Debit</Label><Input id={`debit-${r.key}`} /></div>))}").duplicateIdRisks.length === 0,
  "which is the correct fix",
);
ok(
  "  nor is an aria-label that varies by row",
  scan("{rows.map((r, i) => (<Input aria-label={`Debit for line ${i + 1}`} />))}").duplicateIdRisks.length === 0,
);
ok(
  "a literal id OUTSIDE a map is fine",
  scan(`<Label htmlFor="city">City</Label><Input id="city" />`).duplicateIdRisks.length === 0,
  "a form that renders once has no duplicate to create",
);
ok(
  "  and flatMap counts as a map",
  scan(`{groups.flatMap((g) => (<Input id="qty" />))}`).duplicateIdRisks.length === 1,
);

section("And is not fooled by how the attributes are written");

/**
 * The tag walker has to survive real JSX, where an attribute value routinely contains the `>` and
 * the quotes that a naive regex would stop at. A scanner that cuts a tag in half reports the
 * remainder as a separate unnamed control, which is a false positive — and worse, it can lose the
 * `aria-label` that was on the far side of the cut, which is a false *negative*.
 */
ok(
  "an expression containing > does not cut the tag short",
  unnamedCount(`<Input aria-label="Seats" value={n > 0 ? n : ""} onChange={f} />`) === 0,
);
ok(
  "  nor does a nested object literal",
  unnamedCount(`<Select aria-label="Status" style={{ width: "10rem" }}>{o}</Select>`) === 0,
);
ok(
  "  nor a template string with braces in it",
  unnamedCount("<Input aria-label={`Debit for line ${i + 1}`} value={v} />") === 0,
);
ok(
  "attributes spread over many lines are read as one tag",
  unnamedCount(`<Input\n  id="city"\n  value={v}\n  onChange={f}\n/>\n<Label htmlFor="city">City</Label>`) === 0,
);
ok(
  "a label written after its control still counts",
  unnamedCount(`<Input id="pin" /><Label htmlFor="pin">PIN code</Label>`) === 0,
);

section("And leaves alone what is not a field");

ok("a hidden input is not a field anybody fills in", unnamedCount(`<input type="hidden" name="id" value={id} />`) === 0);
ok("  nor a submit button", unnamedCount(`<input type="submit" value="Save" />`) === 0);
ok(
  "a display:none file input is not in the accessibility tree",
  unnamedCount(`<input ref={r} type="file" accept=".csv" className="hidden" onChange={f} />`) === 0,
);
ok(
  "  but sr-only is, and must still be named",
  unnamedCount(`<input type="file" className="sr-only" onChange={f} />`) === 1,
  "sr-only is read aloud; hidden is not",
);

ok(
  "a primitive that forwards {...props} is not judged here",
  unnamedCount(`<input ref={ref} className={cn(f, className)} {...props} />`) === 0,
  "its name comes from the call site, and every call site is scanned",
);
ok(
  "  but a control with its own attributes and no spread still is",
  unnamedCount(`<input ref={ref} className={cn(f)} value={v} />`) === 1,
);

section("The app itself");

const tree = scanTree("src");

console.log(`  ${tree.filesScanned} files · ${tree.named.length} named · ${tree.unnamed.length} unnamed\n`);

/**
 * Zero, not a budget.
 *
 * A ratchet ("no worse than last time") sounds pragmatic and rots: it makes every new unnamed
 * control somebody else's problem, and the number never comes down. The work to get here was done
 * once; keeping it is one attribute per new field.
 */
ok("Every form control in the app has an accessible name", tree.unnamed.length === 0, `${tree.unnamed.length} unnamed`);

ok(
  "  and no control in a repeated row carries a fixed id",
  tree.duplicateIdRisks.length === 0,
  tree.duplicateIdRisks.length === 0
    ? "nothing shares an id across rows"
    : `${tree.duplicateIdRisks.length}: ${tree.duplicateIdRisks.slice(0, 6).map((c) => `${c.file}:${c.line}`).join(", ")}`,
);

if (tree.duplicateIdRisks.length > 0) {
  console.log("\n  Fixed ids inside a .map() — every row emits the same one:\n");
  for (const c of tree.duplicateIdRisks) console.log(`    ${c.file}:${c.line}  ${c.snippet}`);
  console.log("\n  Derive the id from the row, or use an aria-label that names the row.\n");
}

if (tree.unnamed.length > 0) {
  const byFile = new Map<string, typeof tree.unnamed>();
  for (const c of tree.unnamed) {
    const list = byFile.get(c.file) ?? [];
    list.push(c);
    byFile.set(c.file, list);
  }
  console.log("\n  Unnamed controls:\n");
  for (const [file, controls] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${file} (${controls.length})`);
    for (const c of controls.slice(0, 6)) console.log(`      :${c.line}  ${c.snippet}`);
    if (controls.length > 6) console.log(`      … and ${controls.length - 6} more`);
  }
  console.log(
    "\n  Give each an aria-label, or an id with a <Label htmlFor> pointing at it.\n" +
      "  Inside a .map(), derive the id from the row — a hardcoded one repeats on every row\n" +
      "  and every label then points at the first.\n",
  );
}

console.log(failures === 0 ? "\nAll accessibility checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
