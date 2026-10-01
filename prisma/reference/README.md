# Reference data

Facts about the world rather than about any one business. Nothing here is created by using the app,
so nothing here is removed by resetting it — no seed, demo reset or cleanup script may delete from
these tables, and `npm run check:address` fails if one does. The rule and the table list live in
`src/lib/reference-data.ts`.

## One copy, shared by every workspace

The tables live in a database of their own — `schema.prisma` in this folder, at
`REFERENCE_DATABASE_URL` — not in any workspace's. A workspace's reset, restore, `migrate reset` or
backup never touches them, and only the platform may sync them (`src/lib/platform/shared-data.ts`).

| Command | What it does |
|---|---|
| `npm run reference:migrate` | Applies this folder's migrations to the reference database |
| `npm run reference:generate` | Its Prisma client, into `node_modules/@deskzo/reference-client` |
| `npm run reference:move` | Upgrading a database from before this: copies its reference tables here, checks the copy, empties them — then run `npx prisma migrate deploy` |

## The PIN directory

Every post office in India, from the Department of Posts' **All India Pincode Directory**, published
monthly on the Government's open-data platform under the Government Open Data Licence – India.

It drives the address forms: typing a PIN fills in the state and city, choosing a city offers its
PINs, and a PIN that belongs to a different state from the one chosen is flagged — which matters
because the state decides CGST + SGST against IGST.

### Loading or updating it — from Settings (the usual way)

**Settings → Lists & taxonomy → PIN directory.** Paste a data.gov.in API key once (it is stored
encrypted and never shown again), then press **Sync now**. The sync runs as a background process
(`sync-worker.ts`), so the page can be closed; it shows progress while open. Needs `settings.manage`.

### Loading or updating it — with an API key, from the command line

1. Get a free API key from **data.gov.in** (sign in → My Account → API key).
2. Add it to `.env` — which git ignores — never to a file that is committed:

   ```
   DATA_GOV_IN_API_KEY=your-key-here
   ```

3. Run:

   ```
   npm run db:reference:download
   ```

It fetches resource `5c2f62fe-5afa-4119-a499-fec9d604d5bd` page by page (~165,000 post offices, a
few minutes), refuses an incomplete run, then loads it exactly as a downloaded file would be. The key
is sent only to api.data.gov.in and never printed — not in progress lines, not in errors.

### Loading or updating it — by hand

1. Open **data.gov.in** and search for **All India Pincode Directory till last month**
   (Department of Posts).
2. Download it as **CSV** and save it into this folder (`prisma/reference/`).
3. Run:

   ```
   npm run db:reference
   ```

The loader checks the file, replaces the directory in one transaction, and saves a compressed copy
as `india-post-pincodes.csv.gz`. **Commit that `.gz` file** — it is what every other machine's first
seed loads from. The raw `.csv` is git-ignored and can
be deleted afterwards.

Running it again with the same file does nothing. A file with less than half the current number of
post offices is refused as probably truncated; `npm run db:reference -- <file> --force` overrides
that when the drop is genuine.

If the loader reports state names that did not resolve to a GST code, add each one to
`STATE_ALIASES` in `src/lib/gst-engine.ts` and reload with `--force`.

### When it is reloaded automatically

| Event | What happens |
|---|---|
| `npm run db:seed` | Loaded into the reference database if missing or changed; otherwise a no-op |
| `prisma migrate reset` of a workspace | Never touched — it is not in that database |
| Backup restore of a workspace | Never touched; an older backup's own copy is emptied after the restore |
| Demo seed `--reset`, any other seed | Never touched |

Country, state and city lists are not here: they live in code (`src/lib/geo/`), which no data
operation can touch.
