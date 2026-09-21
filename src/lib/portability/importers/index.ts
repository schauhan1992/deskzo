import type { Importer } from "./types";
import { companiesImporter } from "./companies";
import { contactsImporter } from "./contacts";
import { itemsImporter } from "./items";
import { ticketsImporter } from "./tickets";
import { suppressionImporter } from "./suppression";
import { visitsImporter } from "./visits";
import { assetsImporter } from "./assets";
import { workspaceImporter } from "./workspace";
import { expensesImporter } from "./expenses";
import { ledgerImporter } from "./ledger";
import { peopleImporter } from "./people";
import { hiringImporter } from "./hiring";
import { usersImporter } from "./users";

/**
 * Which importer serves which area.
 *
 * An area absent from this map has no importer, and the screen renders its Import button disabled
 * rather than letting somebody click it and be refused. `check:import` prints the outstanding list
 * on every run, so the gap is stated rather than discovered.
 *
 * The five party areas share one importer: they are the same table, and which kind of party a row
 * becomes is decided by the area it is imported into rather than by a column in the file.
 *
 * Three areas are deliberately missing and always will be — orders, renewals and payments. Each is
 * the record of a process that also wrote ledger entries, stock movements and audit rows, so an
 * imported one would exist without any of that. `areas.ts` carries the reasoning and the screen
 * shows it, so the absence reads as a decision rather than an oversight. Statements are missing for
 * a different reason: they are computed, so there is nothing to import into.
 */
export const IMPORTERS: Record<string, Importer> = {
  companies: companiesImporter,
  customers: companiesImporter,
  vendors: companiesImporter,
  resellers: companiesImporter,
  "commission-parties": companiesImporter,
  contacts: contactsImporter,
  items: itemsImporter,
  tickets: ticketsImporter,
  suppression: suppressionImporter,
  visits: visitsImporter,
  assets: assetsImporter,
  workspace: workspaceImporter,
  expenses: expensesImporter,
  ledger: ledgerImporter,
  people: peopleImporter,
  hiring: hiringImporter,
  users: usersImporter,
};

export function getImporter(area: string): Importer | undefined {
  return IMPORTERS[area];
}

export const IMPLEMENTED_IMPORTS = Object.keys(IMPORTERS);

export type { Importer };
