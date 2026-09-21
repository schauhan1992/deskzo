import type { Exporter } from "./types";
import {
  companiesExporter,
  customersExporter,
  vendorsExporter,
  resellersExporter,
  commissionPartiesExporter,
  contactsExporter,
  ticketsExporter,
  suppressionExporter,
} from "./crm";
import { itemsExporter, ordersExporter, renewalsExporter, paymentsExporter } from "./trade";
import { statementsExporter } from "./statements";
import { visitsExporter } from "./visits";
import { assetsExporter } from "./assets";
import { workspaceExporter } from "./workspace";
import { expensesExporter } from "./expenses";
import { ledgerExporter } from "./ledger";
import { peopleExporter } from "./people";
import { hiringExporter } from "./hiring";
import { usersExporter } from "./users";

/**
 * Which exporter serves which area.
 *
 * Every key in `PORTABLE_AREAS` must appear here — an area with no exporter downloads an empty file
 * that looks like "you have no data" rather than "this was never built", which is the worst of both
 * because nobody reports it as a bug. `check:portability` asserts the coverage.
 */
export const EXPORTERS: Record<string, Exporter> = {
  companies: companiesExporter,
  customers: customersExporter,
  vendors: vendorsExporter,
  resellers: resellersExporter,
  "commission-parties": commissionPartiesExporter,
  contacts: contactsExporter,
  tickets: ticketsExporter,
  suppression: suppressionExporter,
  items: itemsExporter,
  orders: ordersExporter,
  renewals: renewalsExporter,
  payments: paymentsExporter,
  statements: statementsExporter,
  visits: visitsExporter,
  assets: assetsExporter,
  workspace: workspaceExporter,
  expenses: expensesExporter,
  ledger: ledgerExporter,
  people: peopleExporter,
  hiring: hiringExporter,
  users: usersExporter,
};

export function getExporter(area: string): Exporter | undefined {
  return EXPORTERS[area];
}

export const IMPLEMENTED_EXPORTS = Object.keys(EXPORTERS);

export type { Exporter, ExportScope } from "./types";
