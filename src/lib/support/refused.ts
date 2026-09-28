/**
 * A refusal worth telling whoever asked — a file type that can't be attached, an attachment that
 * expired, too many requests — with the HTTP status the upload route answers it with. The workspace
 * action turns it into `{ ok: false, error }`; anything else thrown is a fault, logged, not shown.
 *
 * A file of its own, like src/lib/platform/refused.ts, so storage, the service and the route can all
 * throw it without importing each other.
 */
export class SupportRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SupportRefused";
  }
}

/** What a stale, foreign or unknown attachment id is told — the same words for each, so none is a probe. */
export const ATTACHMENT_EXPIRED = "That attachment has expired — please add it again.";
export const TYPE_REFUSED = "That file type can't be attached.";
