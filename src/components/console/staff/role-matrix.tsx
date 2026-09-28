import { Check, ChevronRight, Minus } from "lucide-react";
import { RolePill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { ALL_ROLES, ENTER, MANAGERS, OWNERS, SELLERS, hasRole } from "@/lib/console-shared/roles";
import type { ConsoleRole } from "@/lib/console-shared/types";

/**
 * "What each role can do" (spec §3.16, wording from ia §7.16), folded away under the staff list and
 * open to everybody who can see the page. Each tick is read from the role sets in
 * src/lib/console-shared/roles.ts — the same sets the actions check — so the table cannot drift
 * from what the console actually allows.
 *
 * Shared text, so it is written in nouns: it never uses the wording kept for the roles allowed to
 * act ("Manage staff…", not the button's label). A native `<details>`, so it opens without
 * JavaScript and the browser's find reaches inside it.
 */

const CAPABILITIES: { key: string; label: string; roles: readonly ConsoleRole[] }[] = [
  { key: "view", label: "View workspaces, plans, operations, audit", roles: ALL_ROLES },
  { key: "enter", label: "Enter a workspace on its grant", roles: ENTER },
  { key: "lifecycle", label: "Hold, reopen or migrate a workspace", roles: MANAGERS },
  { key: "sell", label: "Change plans, limits, trials and prices", roles: SELLERS },
  { key: "overrides", label: "Module overrides, give plans free, apply billing rules", roles: MANAGERS },
  { key: "operations", label: "Invitations, terminals, reference data, warm pool", roles: MANAGERS },
  { key: "billing", label: "View billing", roles: SELLERS },
  { key: "close", label: "Close (deprovision) a workspace", roles: OWNERS },
  { key: "staff", label: "Manage staff, security policy and gateway keys", roles: OWNERS },
];

export function RoleMatrix() {
  return (
    <details className="group min-w-0 rounded-xl border border-line bg-surface shadow-sm">
      {/* A summary holds phrasing content and one heading — no wrapping div around the two lines. */}
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-0.5 rounded-xl px-5 py-3 hover:bg-surface-sunken/60 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle transition-transform duration-150 group-open:rotate-90" />
        <h2 className="text-sm font-semibold text-text">What each role can do</h2>
        <span className="w-full pl-7 text-xs text-muted sm:w-auto sm:pl-0">Five roles. Every action checks the role again on the server, whatever a page shows.</span>
      </summary>
      <div className="border-t border-line">
        <DataTable caption="What each role can do" minWidth={680}>
          <THead>
            <Th>Capability</Th>
            {ALL_ROLES.map((role) => (
              <Th key={role} className="text-center">
                <RolePill role={role} />
              </Th>
            ))}
          </THead>
          <TBody>
            {CAPABILITIES.map((capability) => (
              <Tr key={capability.key}>
                <Td>{capability.label}</Td>
                {ALL_ROLES.map((role) => (
                  <Td key={role} className="text-center">
                    {hasRole(role, capability.roles) ? (
                      <>
                        <Check aria-hidden="true" className="mx-auto h-4 w-4 text-success" />
                        <span className="sr-only">Yes</span>
                      </>
                    ) : (
                      <>
                        <Minus aria-hidden="true" className="mx-auto h-4 w-4 text-line-strong" />
                        <span className="sr-only">No</span>
                      </>
                    )}
                  </Td>
                ))}
              </Tr>
            ))}
          </TBody>
        </DataTable>
      </div>
      <p className="border-t border-line px-5 py-2.5 text-xs text-muted">
        Everybody manages their own sessions and preferences in My account. The first owner is made on the server with{" "}
        <code className="font-mono text-[11px] text-text">npm run platform:staff</code>.
      </p>
    </details>
  );
}
