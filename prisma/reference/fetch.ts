import Papa from "papaparse";
import { mapColumns } from "../../src/lib/geo/pincode";

/**
 * India Post's PIN directory, straight from the Government's open-data API.
 *
 * The same dataset a person gets from the Download button on data.gov.in — "All India Pincode
 * Directory till last month", published by the Department of Posts — fetched page by page with an
 * API key instead, and handed back as the CSV that `loadPincodes` already knows how to check and
 * load. Nothing about loading changes; this only replaces the manual download.
 *
 * ## The key
 *
 * Read from `DATA_GOV_IN_API_KEY` in `.env`, which git ignores. It travels in the query string —
 * that is how the API takes it — so no URL is ever logged or put in an error: every message is built
 * from the page offset, never from the request. It is sent to api.data.gov.in and nowhere else.
 */

export const PIN_RESOURCE_ID = "5c2f62fe-5afa-4119-a499-fec9d604d5bd";
const API_BASE = "https://api.data.gov.in/resource";

type Page = { total?: number | string; count?: number | string; records?: Record<string, unknown>[]; message?: string; status?: string };

export type FetchOptions = {
  apiKey: string;
  /** For the checks, which serve pages from a local server. Everything else uses the real API. */
  baseUrl?: string;
  resourceId?: string;
  /** Asked for per request. The API may return fewer; paging follows what it actually sent. */
  pageSize?: number;
  log?: (line: string) => void;
  /** Between requests — this is a public service, and a burst of 170 is not a polite way to use it. */
  pauseMs?: number;
  /** After every page — the settings screen shows a progress bar from this. */
  onProgress?: (fetched: number, total: number | null) => void | Promise<void>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One page, retried on the failures that are worth retrying.
 *
 * A timeout, a dropped connection, a 429 or a 5xx is the service being busy, and waiting fixes it.
 * A 401 or 403 is the key, and waiting does not — that stops at once with a message about the key.
 */
async function fetchPage(url: URL, offset: number): Promise<Page> {
  let lastProblem = "";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(90_000), headers: { accept: "application/json" } });
      if (response.status === 401 || response.status === 403) {
        // Worded for both places a key comes from — the Settings page and .env on the command line.
        throw new KeyError(`data.gov.in refused the API key (HTTP ${response.status}). Check it is copied exactly and still active in your data.gov.in account.`);
      }
      if (response.status === 429 || response.status >= 500) {
        lastProblem = `HTTP ${response.status}`;
      } else if (!response.ok) {
        throw new Error(`data.gov.in answered HTTP ${response.status} for the page at offset ${offset}.`);
      } else {
        const page = (await response.json()) as Page;
        // The API reports a bad key in the body with a 200 as often as with a status code.
        if (page.status === "error" || (!page.records && page.message)) {
          const message = String(page.message ?? "unknown error");
          if (/key/i.test(message)) throw new KeyError(`data.gov.in refused the API key: ${message}`);
          throw new Error(`data.gov.in returned an error for the page at offset ${offset}: ${message}`);
        }
        return page;
      }
    } catch (error) {
      if (error instanceof KeyError) throw error;
      if (error instanceof Error && /answered HTTP|returned an error/.test(error.message)) throw error;
      // Deliberately not `error.message` for network failures: undici puts the request URL, key and
      // all, into some of them.
      lastProblem = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "network error";
    }
    if (attempt < 4) await sleep(1000 * 2 ** attempt);
  }
  throw new Error(`Gave up on the page at offset ${offset} after 4 attempts (${lastProblem}).`);
}

class KeyError extends Error {}

/** The whole directory as CSV text, in the shape `loadPincodes` reads. */
export async function fetchDirectory(options: FetchOptions): Promise<{ csv: string; rows: number; total: number }> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("No API key — set DATA_GOV_IN_API_KEY in .env.");
  try {
    return await fetchAll(apiKey, options);
  } catch (error) {
    // The last line of defence: whatever the service or the network layer put in a message, the key
    // does not leave this function inside it.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.split(apiKey).join("«your key»"));
  }
}

async function fetchAll(apiKey: string, options: FetchOptions): Promise<{ csv: string; rows: number; total: number }> {
  const log = options.log ?? (() => {});
  const pageSize = options.pageSize ?? 5000;
  const base = `${options.baseUrl ?? API_BASE}/${options.resourceId ?? PIN_RESOURCE_ID}`;

  const rows: Record<string, unknown>[] = [];
  let total = Infinity;
  let offset = 0;

  while (offset < total) {
    const url = new URL(base);
    url.searchParams.set("api-key", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(pageSize));

    const page = await fetchPage(url, offset);
    const records = page.records ?? [];
    if (Number.isFinite(Number(page.total))) total = Number(page.total);

    if (offset === 0) {
      // Checked on the first page, before downloading the other hundred-odd: a wrong resource ID or
      // a changed dataset should cost one request, not the whole run.
      const columns = mapColumns(Object.keys(records[0] ?? {}));
      if (!columns.ok) {
        throw new Error(
          `That resource is not the PIN directory — it has no ${columns.missing.join(", ")} column ` +
            `(found: ${Object.keys(records[0] ?? {}).slice(0, 8).join(", ") || "no records at all"}).`,
        );
      }
      log(`  ${Number.isFinite(total) ? total.toLocaleString("en-IN") : "an unknown number of"} post offices to fetch`);
    }
    if (records.length === 0) break;

    rows.push(...records);
    offset += records.length;
    await options.onProgress?.(rows.length, Number.isFinite(total) ? total : null);
    if (rows.length % 25_000 < records.length || offset >= total) {
      log(`  ${rows.length.toLocaleString("en-IN")}${Number.isFinite(total) ? ` of ${total.toLocaleString("en-IN")}` : ""}`);
    }
    if (offset < total) await sleep(options.pauseMs ?? 250);
  }

  // Short is a failure, not a smaller directory. The loader would refuse it anyway if it were less
  // than half, but a directory missing a few thousand post offices should never be loaded quietly.
  if (Number.isFinite(total) && rows.length < total) {
    throw new Error(`Fetched ${rows.length.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} post offices — incomplete, so nothing was loaded.`);
  }

  // Written with the API's own field names, not renamed here: `mapColumns` in the loader already knows
  // every name each column has been published under, and a rename in this file would be a second
  // list that could disagree with it — a field it did not expect would come out blank on every row.
  const csv = Papa.unparse(rows, { columns: Object.keys(rows[0] ?? {}) });
  return { csv, rows: rows.length, total: Number.isFinite(total) ? total : rows.length };
}
