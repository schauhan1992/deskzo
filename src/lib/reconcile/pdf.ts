import { getDocumentProxy } from "unpdf";
import { guessMapping } from "@/lib/reconcile/mapping";

/**
 * A distributor's statement as a PDF (owner, 8 Oct 2026), read into the same rows a .csv or .xlsx
 * gives — keyed by the table's own column headings — so the column mapping, the preview and the saved
 * mapping per vendor all work as they do for a spreadsheet. Nothing leaves the server.
 *
 * A PDF has no table in it, only words placed on a page. The table is rebuilt from where they sit:
 *
 *   1. Words on one baseline are a line; words close together on a line are one cell ("Unit Price").
 *   2. The heading row is the first line whose cells name at least three of the statement's fields,
 *      by the same names the column guesser knows (src/lib/reconcile/mapping.ts) — so a letterhead,
 *      an address block or a summary above the table is passed over.
 *   3. Every later line puts each cell under the heading whose centre is nearest — numbers are often
 *      right-aligned under a left-aligned heading, so the column is the band between neighbouring
 *      headings' centres, not the heading's own width.
 *   4. A line with one cell continues the row above (a description wrapped onto a second line); the
 *      heading repeated on a later page is skipped.
 *
 * Only a PDF made by the vendor's system has words to read. A scan or a photo is an image of words:
 * it is refused, with a request for the statement as Excel or CSV, rather than guessed at — a digit
 * misread in a reconciliation is a false mismatch, or worse, a false match.
 */

export class PdfStatementRefused extends Error {}

/** More pages than a statement has: a 5 MB file of this many pages is not one. */
const MAX_PAGES = 200;

type Word = { text: string; x: number; y: number; right: number; size: number };
type Cell = { text: string; left: number; right: number };
type Line = { cells: Cell[]; y: number; size: number };

function linesOf(words: Word[]): Line[] {
  // Top of the page first; a baseline within a third of the text's height is the same line.
  const sorted = [...words].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Word[][] = [];
  for (const w of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(line[0]!.y - w.y) <= Math.max(1.5, w.size / 3)) line.push(w);
    else lines.push([w]);
  }
  return lines.map((line) => {
    const byX = line.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    for (const w of byX) {
      const last = cells.at(-1);
      // Closer than about two spaces: the same phrase. Columns stand further apart than that.
      if (last && w.x - last.right <= w.size * 0.6) {
        last.text = `${last.text} ${w.text}`;
        last.right = Math.max(last.right, w.right);
      } else {
        cells.push({ text: w.text, left: w.x, right: w.right });
      }
    }
    return { cells, y: byX[0]!.y, size: Math.max(...byX.map((w) => w.size)) };
  });
}

/** How many of the statement's fields these cells name, as the column guesser reads them. */
const fieldsNamed = (cells: Cell[]) => Object.keys(guessMapping(cells.map((c) => c.text))).length;

/** The PDF's rows, keyed by its headings. Throws `PdfStatementRefused` with words for the person. */
export async function parsePdfStatement(bytes: Uint8Array): Promise<Record<string, string>[]> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // Errors only: pdf.js otherwise warns into the server's log about every quirk of a vendor's PDF.
    pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  } catch {
    throw new PdfStatementRefused("That PDF couldn't be opened — it may be damaged or password-protected. Ask the vendor for the statement as Excel or CSV.");
  }
  if (pdf.numPages > MAX_PAGES) throw new PdfStatementRefused(`That PDF has ${pdf.numPages} pages — more than a statement. Split it, or ask for Excel or CSV.`);

  const pages: Line[][] = [];
  let anyText = false;
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const words: Word[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const text = item.str.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const [a = 1, b = 0, , , x = 0, y = 0] = item.transform as number[];
      const size = Math.hypot(a, b) || item.height || 10;
      words.push({ text, x, y, right: x + (item.width || text.length * size * 0.5), size });
    }
    if (words.length) anyText = true;
    pages.push(linesOf(words));
  }
  // Its worker-side state, let go of: the document is not used again.
  await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => {});
  if (!anyText) {
    throw new PdfStatementRefused("That PDF has no text in it — it looks like a scan or a photo of a statement. Ask the vendor for it as Excel or CSV, or as a PDF from their portal.");
  }

  // The heading row: the first line, on any page, that names three of the statement's fields.
  let heading: Cell[] | null = null;
  for (const lines of pages) {
    heading = lines.find((l) => l.cells.length >= 3 && fieldsNamed(l.cells) >= 3)?.cells ?? null;
    if (heading) break;
  }
  if (!heading) {
    throw new PdfStatementRefused("Couldn't find the table's column headings in that PDF (like SKU, Customer, Quantity). Ask the vendor for the statement as Excel or CSV.");
  }

  // Each heading's name, made unique, and the band of the page its column holds.
  const seen = new Map<string, number>();
  const names = heading.map((c) => {
    const n = (seen.get(c.text) ?? 0) + 1;
    seen.set(c.text, n);
    return n === 1 ? c.text : `${c.text} (${n})`;
  });
  const centres = heading.map((c) => (c.left + c.right) / 2);
  const columnOf = (cell: Cell) => {
    const mid = (cell.left + cell.right) / 2;
    let best = 0;
    for (let i = 1; i < centres.length; i++) if (Math.abs(centres[i]! - mid) < Math.abs(centres[best]! - mid)) best = i;
    return best;
  };
  const headingText = heading.map((c) => c.text).join("|");

  const rows: Record<string, string>[] = [];
  let started = false;
  for (const lines of pages) {
    // The row a wrapped line may continue: only on this page, and only the line just above it.
    let above: Line | null = null;
    for (const line of lines) {
      const cells = line.cells;
      if (cells.map((c) => c.text).join("|") === headingText) {
        started = true; // The heading itself, or repeated at the top of a later page.
        continue;
      }
      if (!started) continue;
      if (cells.length === 1) {
        // A wrapped description belongs to the row just above it, in its own column. Anything further
        // down — a page number, a note under the table — is not part of a row.
        const last = rows.at(-1);
        const wrapped: boolean = above !== null && above.y - line.y <= Math.max(above.size, line.size) * 1.8;
        above = wrapped ? line : null;
        if (last && wrapped) {
          const name = names[columnOf(cells[0]!)]!;
          last[name] = last[name] ? `${last[name]} ${cells[0]!.text}` : cells[0]!.text;
        }
        continue;
      }
      const row: Record<string, string> = Object.fromEntries(names.map((n) => [n, ""]));
      for (const cell of cells) {
        const name = names[columnOf(cell)]!;
        row[name] = row[name] ? `${row[name]} ${cell.text}` : cell.text;
      }
      rows.push(row);
      above = line;
    }
  }
  return rows;
}
