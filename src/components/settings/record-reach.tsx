import type { PersonAccessCell } from "@/actions/access-levels";
import { Card } from "@/components/ui/card";
import { LEVEL_WORDS } from "@/lib/authz/level-order";

/**
 * Which records somebody reaches, and why — the record half of "what am I allowed to do", read from
 * the same engine every list and action asks (src/lib/authz/access.ts `explainAccess`). Each row says
 * where its View comes from; a cell whose reason differs carries its own as a tooltip.
 */
export function RecordReach({
  rows,
}: {
  rows: { key: string; label: string; cells: Record<"view" | "edit" | "delete" | "assign", PersonAccessCell> }[];
}) {
  const actions = [
    ["view", "View"],
    ["edit", "Edit"],
    ["delete", "Delete"],
    ["assign", "Assign"],
  ] as const;
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-text">Which records you reach</h2>
      <p className="mt-1 text-sm text-muted">
        &ldquo;Own&rdquo; is yours, &ldquo;Team&rdquo; adds everyone who reports to you, &ldquo;As the account&rdquo; means the
        customers and vendors you reach.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-medium text-muted">
              <th scope="col" className="py-2 pr-3">
                Records
              </th>
              {actions.map(([key, label]) => (
                <th key={key} scope="col" className="px-2 py-2">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-line align-top last:border-0">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <span className="block text-text">{row.label}</span>
                  <span className="block text-xs text-subtle">{row.cells.view.why}</span>
                </th>
                {actions.map(([key]) => {
                  const cell = row.cells[key];
                  const differs = key !== "view" && cell.why !== row.cells.view.why;
                  return (
                    <td key={key} className="px-2 py-2" title={cell.why}>
                      <span className={cell.level === "NONE" ? "text-subtle" : "text-text"}>{LEVEL_WORDS[cell.level]}</span>
                      {differs && <span className="block text-xs text-subtle">{cell.why}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
