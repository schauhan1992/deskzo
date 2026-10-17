/**
 * How many of a report's rows are drawn as rows — on screen, and on the printed sheet.
 *
 * The screen paints the first 200 (a breakdown by customer over a wide window is thousands, and every
 * one becomes a table row); the totals always cover every row. The printed sheet used to carry every
 * row, which made "Print or save as PDF" a way to take the whole list out of the building without the
 * export permission the CSV asks for (`data.exportCrm` / `data.exportFinance`). So the sheet shows
 * what the screen does, and every row only to somebody who may download them anyway. Pure.
 */
export const REPORT_ROWS_SHOWN = 200;

/** The rows to draw, and how many more there are: all of them when `mayExport`, else the first REPORT_ROWS_SHOWN. */
export function rowsShown<T>(rows: readonly T[], mayExport: boolean): { rows: T[]; hidden: number } {
  const list = Array.isArray(rows) ? rows : [];
  if (mayExport || list.length <= REPORT_ROWS_SHOWN) return { rows: [...list], hidden: 0 };
  return { rows: list.slice(0, REPORT_ROWS_SHOWN), hidden: list.length - REPORT_ROWS_SHOWN };
}
