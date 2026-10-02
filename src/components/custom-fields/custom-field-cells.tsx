/**
 * A list's custom-field columns (src/lib/custom-fields/server.ts `listColumns`): the header cells and
 * one row's cells, drawn from the same column list so the two can never disagree. A table with a
 * column picker narrows the list once — to the fields this person shows (`useColumns().showCustom`) —
 * and gives that one list to both; it adds the count to its own for an empty row's colSpan.
 */

export type CustomColumn = {
  key: string;
  label: string;
  numeric: boolean;
  /** A column unless somebody hides it — the field is marked "a column in the list". */
  default: boolean;
};

export function CustomFieldHeaderCells({ columns, className = "" }: { columns: CustomColumn[]; className?: string }) {
  return (
    <>
      {columns.map((c) => (
        <th key={c.key} scope="col" className={`${className} ${c.numeric ? "text-right" : ""}`}>
          {c.label}
        </th>
      ))}
    </>
  );
}

export function CustomFieldBodyCells({ columns, texts, className = "" }: { columns: CustomColumn[]; texts: Record<string, string> | undefined; className?: string }) {
  return (
    <>
      {columns.map((c) => (
        <td key={c.key} className={`${className} ${c.numeric ? "text-right tabular-nums" : ""}`}>
          {texts?.[c.key] || <span className="text-subtle">—</span>}
        </td>
      ))}
    </>
  );
}
