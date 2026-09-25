/**
 * The fixed parts of an administrator lock — what src/lib/access/lock.ts and the lock settings
 * screen both need, kept apart from the queries so the client component can import them without
 * pulling the database into its bundle.
 */

export const DEFAULT_LOCK_MESSAGE = "Your access to the CRM has been paused by an administrator. Please contact them if you need anything in the meantime.";
export const LOCK_MESSAGE_MAX = 1000;
/** Typed to lock the whole company. */
export const COMPANY_LOCK_PHRASE = "LOCK";
