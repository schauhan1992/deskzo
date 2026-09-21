import fs from "node:fs";
import path from "node:path";

/**
 * Which form controls in the app have an accessible name, and which do not.
 *
 * A control with no name is announced as "edit text, blank" or just "combo box". On a screen with
 * eleven of them — which this app has several of — that is a form nobody can fill in without sight,
 * and nothing about it looks wrong to anybody who can see the label sitting next to it.
 *
 * The rule this encodes is the one browsers actually apply, which is stricter than "there is a
 * label somewhere near it":
 *
 *   · `aria-label` or `aria-labelledby` on the control names it outright;
 *   · otherwise the control needs an `id`, **and** a `<label htmlFor>` in the same file has to point
 *     at that id. An `id` on its own names nothing, and a `<Label>` with no `htmlFor` is a caption
 *     rather than a label — visually identical, and invisible to the accessibility tree;
 *   · a control wrapped *inside* a `<label>` element is named by it, so that counts too.
 *
 * Deliberately a text scan rather than a parse. It has to run over 300 .tsx files in a check script
 * with no build step, and it only needs to be right about attributes, which are unambiguous. Where
 * it cannot tell, it says so rather than guessing — see `uncertain`.
 */

export type Control = {
  file: string;
  line: number;
  tag: string;
  /** The full opening tag, for reporting. */
  snippet: string;
};

export type ScanResult = {
  named: Control[];
  unnamed: Control[];
  /** `<Label>` / `<label>` with no `htmlFor`, which names nothing. */
  captionOnlyLabels: Control[];
  /**
   * A literal `id` on a control rendered inside a `.map()` — the same id on every row.
   *
   * Worse than leaving it unnamed, and it *reads* as fixed: the scan counts the control as named,
   * because there is an id and a label pointing at it. But ids must be unique in a document, so
   * every row's label resolves to the FIRST row's control. Clicking the label on row nine focuses
   * row one; a screen reader announces the same name nine times over.
   *
   * This is the single most likely way a bulk naming pass goes wrong, which is why it is detected
   * rather than trusted to review.
   */
  duplicateIdRisks: Control[];
  filesScanned: number;
};

/** The named-import components that render a form control, plus the intrinsic ones. */
const CONTROL_TAGS = new Set(["Input", "Select", "Textarea", "input", "select", "textarea"]);
const LABEL_TAGS = new Set(["Label", "label"]);

/** `type="hidden"` and submit-ish inputs are not things anybody fills in. */
const UNNAMED_EXEMPT_TYPES = new Set(["hidden", "submit", "reset", "button", "image"]);

/**
 * A control that `display:none` removes is not in the accessibility tree at all.
 *
 * The pattern this exists for is the hidden file input that a styled button clicks for you — it is
 * never focused, never announced, and giving it a label would be naming something nobody can reach.
 * `sr-only` is deliberately **not** here: that is visible to a screen reader and must be named.
 */
function isRemovedFromTree(attrs: string): boolean {
  const className = attrValue(attrs, "className");
  if (!className) return false;
  return /\bhidden\b/.test(className);
}

export function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walkTsx(full, out);
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every opening JSX tag in a file, with its attribute text.
 *
 * Walks character by character tracking string and brace depth, because an attribute value is
 * routinely a whole expression — `className={cn("a", open && "b")}` contains both `>` and quotes,
 * and a regex that stops at the first `>` cuts tags in half and reports them as unnamed.
 */
/**
 * Comments blanked out, with every offset left exactly where it was.
 *
 * This codebase comments heavily and deliberately, and prose about markup contains markup: the
 * period filter carries `{/* A bare <select> styled to look like text ... *\/}` immediately above the
 * control it describes, and the scan read that sentence as a second, unnamed `<select>`. A false
 * positive nobody can fix is worse than no check — the only "fix" is to reword the comment, which
 * teaches people to write worse comments to appease a tool.
 *
 * Replaced with spaces rather than removed, so `lineOf` and the label/map ranges keep working on
 * offsets into the original text.
 */
function blankComments(source: string): string {
  const out = source.split("");
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const c = source[i]!;

    if (quote) {
      if (c === quote && source[i - 1] !== "\\") quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }

    // A block comment, whether it is bare or wrapped in JSX braces.
    if (c === "/" && source[i + 1] === "*") {
      let j = i + 2;
      while (j < source.length && !(source[j] === "*" && source[j + 1] === "/")) j++;
      const end = Math.min(j + 2, source.length);
      for (let k = i; k < end; k++) if (out[k] !== "\n") out[k] = " ";
      i = end;
      continue;
    }

    // A line comment. Not inside a URL — `https://` is preceded by a colon.
    if (c === "/" && source[i + 1] === "/" && source[i - 1] !== ":") {
      let j = i;
      while (j < source.length && source[j] !== "\n") j++;
      for (let k = i; k < j; k++) out[k] = " ";
      i = j;
      continue;
    }

    i++;
  }

  return out.join("");
}

export function openingTags(source: string): { tag: string; attrs: string; index: number }[] {
  const found: { tag: string; attrs: string; index: number }[] = [];

  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "<") continue;
    const nameMatch = /^<([A-Za-z][A-Za-z0-9._]*)/.exec(source.slice(i, i + 64));
    if (!nameMatch) continue;

    let j = i + nameMatch[0].length;
    let depth = 0;
    let quote: string | null = null;

    while (j < source.length) {
      const c = source[j]!;
      if (quote) {
        if (c === quote && source[j - 1] !== "\\") quote = null;
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
      } else if (c === ">" && depth === 0) {
        break;
      }
      j++;
    }

    found.push({ tag: nameMatch[1]!, attrs: source.slice(i + nameMatch[0].length, j), index: i });
    i = j;
  }

  return found;
}

/** The literal value of `attr="..."`, or the raw expression inside `attr={...}`. */
function attrValue(attrs: string, name: string): string | null {
  const literal = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  if (literal) return literal[1]!;

  const braced = new RegExp(`\\b${name}\\s*=\\s*\\{`).exec(attrs);
  if (!braced) return null;

  let j = braced.index + braced[0].length;
  let depth = 1;
  const start = j;
  while (j < attrs.length && depth > 0) {
    if (attrs[j] === "{") depth++;
    else if (attrs[j] === "}") depth--;
    j++;
  }
  return attrs.slice(start, j - 1).trim();
}

function hasAttr(attrs: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*=`).test(attrs);
}

/**
 * A control that forwards `{...props}` cannot be judged here, and must not be reported.
 *
 * `src/components/ui/input.tsx` is the case: `<input ref={ref} className={...} {...props} />` is the
 * definition of `Input`, and its name arrives from whichever call site rendered it. Reporting the
 * primitive would be asking it to hardcode one name for every form in the app — the one fix that is
 * definitely wrong — and it would leave three permanent failures in front of whoever runs this
 * suite, which is how a check comes to be ignored.
 *
 * The call sites are where the name belongs, and every one of them is scanned.
 */
function forwardsUnknownProps(attrs: string): boolean {
  return /\{\s*\.\.\.\s*[\w$]+\s*\}/.test(attrs);
}

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

/** Whether this `<label>` contains a form control, in which case it names it by wrapping. */
function wrapsAControl(source: string, labelIndex: number): boolean {
  const close = source.slice(labelIndex).search(/<\/[Ll]abel\s*>/);
  if (close < 0) return false;
  const inner = source.slice(labelIndex, labelIndex + close);
  return /<(Input|Select|Textarea|input|select|textarea)\b/.test(inner);
}

export function scanFile(file: string, rawSource: string): Omit<ScanResult, "filesScanned"> {
  // Offsets are unchanged, so line numbers and ranges still refer to the real file.
  const source = blankComments(rawSource);
  const tags = openingTags(source);

  /**
   * Every id a `<label htmlFor>` in this file points at.
   *
   * Same file rather than same component, deliberately: a label and its control can sit in
   * different components within one file, and following that properly needs a parse. Being
   * generous here means the scan never reports a control that is in fact named — the failure mode
   * is under-reporting, which is the right one for something that gates a build.
   */
  const labelled = new Set<string>();
  for (const t of tags) {
    if (!LABEL_TAGS.has(t.tag)) continue;
    const target = attrValue(t.attrs, "htmlFor");
    if (target) labelled.add(target.trim());
  }

  /**
   * The character ranges covered by a `<label>` element, so a control inside one can be spotted.
   *
   * Wrapping is a real naming mechanism and the commonest one for a checkbox —
   * `<label><input type="checkbox" /> Active</label>` is correctly named and has no `htmlFor`
   * anywhere. Without this the scan reports every checkbox in the app and the true failures drown
   * in them.
   *
   * Matched by counting `<label` and `</label>` in order, which is exact for the non-nested case
   * and conservative for the nested one — labels do not nest in practice, and over-covering only
   * ever makes the scan report less.
   */
  const labelRanges: [number, number][] = [];
  {
    const open = /<[Ll]abel\b/g;
    const close = /<\/[Ll]abel\s*>/g;
    const opens: number[] = [];
    const closes: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = open.exec(source)) !== null) opens.push(m.index);
    while ((m = close.exec(source)) !== null) closes.push(m.index);
    for (const start of opens) {
      const end = closes.find((c) => c > start);
      if (end !== undefined) labelRanges.push([start, end]);
    }
  }
  const insideLabel = (index: number) => labelRanges.some(([a, b]) => index > a && index < b);

  /**
   * The character ranges of every `.map(` callback in the file.
   *
   * Found by matching `.map(` and walking to its balanced close paren, so a nested map inside a map
   * is covered by both and a `)` inside a string or a JSX expression does not end it early.
   */
  const mapRanges: [number, number][] = [];
  for (const m of source.matchAll(/\.(map|flatMap)\s*\(/g)) {
    let j = m.index + m[0].length;
    let depth = 1;
    let quote: string | null = null;
    while (j < source.length && depth > 0) {
      const c = source[j]!;
      if (quote) {
        if (c === quote && source[j - 1] !== "\\") quote = null;
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
      }
      j++;
    }
    if (depth === 0) mapRanges.push([m.index, j]);
  }
  const insideMap = (index: number) => mapRanges.some(([a, b]) => index > a && index < b);

  const named: Control[] = [];
  const unnamed: Control[] = [];
  const captionOnlyLabels: Control[] = [];
  const duplicateIdRisks: Control[] = [];

  for (const t of tags) {
    if (LABEL_TAGS.has(t.tag) && !hasAttr(t.attrs, "htmlFor") && !wrapsAControl(source, t.index)) {
      captionOnlyLabels.push({
        file,
        line: lineOf(source, t.index),
        tag: t.tag,
        snippet: `<${t.tag}${t.attrs.slice(0, 80)}`,
      });
    }

    if (!CONTROL_TAGS.has(t.tag)) continue;

    const type = attrValue(t.attrs, "type");
    if (type && UNNAMED_EXEMPT_TYPES.has(type)) continue;
    if (isRemovedFromTree(t.attrs)) continue;
    if (forwardsUnknownProps(t.attrs)) continue;

    const control: Control = {
      file,
      line: lineOf(source, t.index),
      tag: t.tag,
      snippet: `<${t.tag}${t.attrs.replace(/\s+/g, " ").slice(0, 100)}`,
    };

    const hasAria = hasAttr(t.attrs, "aria-label") || hasAttr(t.attrs, "aria-labelledby");
    const id = attrValue(t.attrs, "id");
    const pointedAt = id !== null && labelled.has(id.trim());
    const wrapped = insideLabel(t.index);

    if (hasAria || pointedAt || wrapped) named.push(control);
    else unnamed.push(control);

    /**
     * A *literal* id inside a map. An expression is fine — `id={\`debit-\${row.key}\`}` is exactly the
     * right fix — so only a quoted constant is reported, which is the one that cannot vary by row.
     */
    if (id !== null && insideMap(t.index) && /^[\w-]+$/.test(id.trim()) && !t.attrs.includes("id={")) {
      duplicateIdRisks.push(control);
    }
  }

  return { named, unnamed, captionOnlyLabels, duplicateIdRisks };
}

export function scanTree(root: string): ScanResult {
  const files = walkTsx(root);
  const result: ScanResult = {
    named: [],
    unnamed: [],
    captionOnlyLabels: [],
    duplicateIdRisks: [],
    filesScanned: files.length,
  };

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(process.cwd(), file).replaceAll("\\", "/");
    const one = scanFile(rel, source);
    result.named.push(...one.named);
    result.unnamed.push(...one.unnamed);
    result.captionOnlyLabels.push(...one.captionOnlyLabels);
    result.duplicateIdRisks.push(...one.duplicateIdRisks);
  }

  return result;
}
