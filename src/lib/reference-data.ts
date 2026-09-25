/**
 * The tables that hold facts about the world rather than about this business.
 *
 * ## The rule
 *
 * **No seed, reset, demo cleanup or script deletes from these.** Only their own loader may, and only
 * to replace the rows with a newer copy of the same source file.
 *
 * Everything else in the database was created by somebody using the app — or by a seed standing in
 * for somebody — so wiping it is a coherent thing to ask for. These were not. India's post offices
 * do not stop existing when the demo company is cleared out, and an address form that loses its PIN
 * lookup every time somebody resets test data is an address form nobody can rely on. So "remove all
 * the seed data", however broadly it is meant, never reaches them.
 *
 * Country, state and city lists are not here because they are not in the database at all: they
 * live in code (`src/lib/geo/`), which no data operation can touch. The PIN directory is ~165,000
 * rows and has to be a table.
 *
 * ## How it is held to
 *
 *   · `check:address` scans every seed, script and action for a delete — or raw SQL — against any
 *     table listed here, outside `prisma/reference/`, and fails naming the file.
 *   · `prisma migrate reset` is the one path that drops them anyway, because it drops the whole
 *     database. `prisma/seed.ts` runs straight after it and reloads them from the committed file.
 *
 * Adding a reference table means adding it here; the check then covers it with no other change.
 */
export const REFERENCE_TABLES = [
  { model: "postOffice", table: "post_offices", what: "India Post's PIN directory" },
  { model: "geoState", table: "geo_states", what: "GeoNames' states and provinces outside India" },
  { model: "geoCity", table: "geo_cities", what: "GeoNames' towns and cities outside India" },
  { model: "geoPostalCode", table: "geo_postal_codes", what: "GeoNames' postal codes outside India" },
  { model: "referenceDataset", table: "reference_datasets", what: "which file each reference table was loaded from" },
  // Configuration rather than facts, but it belongs to the directory: a reset that kept the post
  // offices and threw away the key that refreshes them would leave the next sync failing for no
  // reason anybody resetting test data would guess.
  { model: "referenceSync", table: "reference_syncs", what: "the data.gov.in API key and the state of the last sync" },
] as const;
