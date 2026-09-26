"use server";

import { requireUser } from "@/lib/session";
import { lookupRate, type RateLookup } from "@/lib/finance/exchange-rate";

/**
 * What a currency was worth in rupees on a given day — for a document raised in another currency,
 * and the converter in the side rail. In every plan: the rate is published, and not the company's.
 *
 * A `"use server"` export, so it checks a session — but nothing stronger. The outbound call happens
 * here rather than in the browser; see lib/finance/exchange-rate.ts for why.
 */
export async function lookupExchangeRate(code: string, onDate: string): Promise<RateLookup> {
  await requireUser();
  return lookupRate(code, onDate);
}
