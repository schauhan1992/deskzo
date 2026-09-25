export type RenewalStatusKey = "unscheduled" | "expired" | "expiring" | "active";

export type RenewalStatus = {
  key: RenewalStatusKey;
  label: string;
  tone: "default" | "red" | "amber" | "green";
};

/** Days remaining until `endDate`, ceiling-rounded so "later today" still reads as 0, not -1. */
export function daysUntil(endDate: Date, now: Date = new Date()) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.ceil((endDate.getTime() - now.getTime()) / msPerDay);
}

export function getRenewalStatus(
  endDate: Date | string | null,
  now: Date = new Date(),
  expiringWithinDays = 30,
): RenewalStatus {
  if (!endDate) return { key: "unscheduled", label: "No expiry set", tone: "default" };
  const days = daysUntil(new Date(endDate), now);
  if (days < 0) return { key: "expired", label: "Expired", tone: "red" };
  if (days <= expiringWithinDays) return { key: "expiring", label: `Expires in ${days}d`, tone: "amber" };
  return { key: "active", label: "Active", tone: "green" };
}

// ─── How far along the renewal is ─────────────────────────────────────────────

/**
 * Where a renewal has got to.
 *
 * Distinct from the status above, which is only "how long is left" — a clock, not progress. Two
 * subscriptions both expiring in nine days are the same status and completely different situations
 * if one has been quoted and the other has not been touched.
 *
 * ## Derived, with room for the part that cannot be
 *
 * Most of this comes free, because the work leaves traces: a call logged against the order, a
 * proposal quoting it, the renewal order itself. Those are facts, they are already recorded, and a
 * stage computed from them cannot drift out of date the way a field somebody has to remember to
 * update always does.
 *
 * But "we are negotiating", "they have gone quiet", "we lost this on price" leave no trace at all,
 * and they are the stages a salesperson most wants to record. So a stage can also be pinned by
 * hand, and a pinned stage wins — with exactly one exception, below.
 */
export type RenewalStageKey =
  | "NOT_STARTED"
  | "TASK_RAISED"
  | "CONTACTED"
  | "QUOTED"
  | "NEGOTIATING"
  | "ON_HOLD"
  | "LOST"
  | "RENEWED";

export type RenewalStageTone = "default" | "blue" | "amber" | "red" | "green";

export type RenewalStageMeta = {
  key: RenewalStageKey;
  label: string;
  tone: RenewalStageTone;
  /**
   * Whether this stage can only ever be set by a person.
   *
   * The others are inferred, so offering them in the picker would invite somebody to pin a stage
   * that the evidence already says — and then to wonder why it stopped moving on its own.
   */
  manualOnly: boolean;
  hint: string;
};

/** In pipeline order, which is the order they are offered in and the order they sort in. */
export const RENEWAL_STAGES: RenewalStageMeta[] = [
  {
    key: "NOT_STARTED",
    label: "Not started",
    tone: "default",
    manualOnly: false,
    hint: "Nothing has happened against this renewal yet.",
  },
  {
    key: "TASK_RAISED",
    label: "Task raised",
    tone: "default",
    manualOnly: false,
    hint: "Somebody has been asked to chase it.",
  },
  {
    key: "CONTACTED",
    label: "Contacted",
    tone: "blue",
    manualOnly: false,
    hint: "A call has been logged against this subscription.",
  },
  {
    key: "QUOTED",
    label: "Quoted",
    tone: "blue",
    manualOnly: false,
    hint: "A proposal has been raised for the next term.",
  },
  {
    key: "NEGOTIATING",
    label: "Negotiating",
    tone: "amber",
    manualOnly: true,
    hint: "They are talking about price or terms. Nothing in the data shows this, so it is set by hand.",
  },
  {
    key: "ON_HOLD",
    label: "On hold",
    tone: "amber",
    manualOnly: true,
    hint: "Parked — a budget freeze, a reorganisation, a decision waiting on somebody else.",
  },
  {
    key: "LOST",
    label: "Lost",
    tone: "red",
    manualOnly: true,
    hint: "Not renewing. Worth saying why, because that is the part worth reading back later.",
  },
  {
    key: "RENEWED",
    label: "Renewed",
    tone: "green",
    manualOnly: false,
    hint: "The renewal order has been punched.",
  },
];

const STAGE_BY_KEY = new Map(RENEWAL_STAGES.map((s) => [s.key, s]));

export function renewalStageMeta(key: RenewalStageKey): RenewalStageMeta {
  // Every key in the type is in the list above, so this cannot miss — the fallback is for a value
  // read back from the database that predates a rename.
  return STAGE_BY_KEY.get(key) ?? RENEWAL_STAGES[0];
}

/** The stages a person may pin. Everything else is inferred and would go stale the moment it was set. */
export const SETTABLE_RENEWAL_STAGES = RENEWAL_STAGES.filter((s) => s.manualOnly);

/** What the record already knows, without anybody having to say it. */
export type RenewalSignals = {
  /** A renewal order exists and has not been cancelled. */
  renewed: boolean;
  /** A proposal, proforma or invoice quotes this subscription's next term. */
  quoted: boolean;
  /** A call has been logged against this subscription. */
  contacted: boolean;
  /** An open renewal task names it. */
  taskRaised: boolean;
};

/**
 * The furthest thing that has actually happened.
 *
 * Highest wins rather than most recent: a call logged after the quote went out does not put the
 * renewal back to "Contacted". Progress here is a high-water mark, because that is how somebody
 * reading the column uses it — "how far has this got", not "what happened last".
 */
export function deriveRenewalStage(signals: RenewalSignals): RenewalStageKey {
  if (signals.renewed) return "RENEWED";
  if (signals.quoted) return "QUOTED";
  if (signals.contacted) return "CONTACTED";
  if (signals.taskRaised) return "TASK_RAISED";
  return "NOT_STARTED";
}

export type ResolvedRenewalStage = RenewalStageMeta & {
  /** Where the answer came from, so the screen can say "set by Priya" rather than implying the app knew. */
  source: "auto" | "manual";
  /**
   * Set when a pinned stage was ignored because the renewal has since been punched, so the screen
   * can explain the discrepancy instead of silently contradicting what somebody typed.
   */
  supersededManual?: RenewalStageKey;
};

/**
 * The stage to show.
 *
 * A pinned stage wins over the derived one — that is the entire point of being able to pin it.
 *
 * The one exception is a renewal that has actually been punched. An order existing is a fact; "Lost"
 * is somebody's opinion recorded at a moment that has since been overtaken. Showing Lost beside a
 * live renewal order would be the column telling a straightforward lie, and the person who set it is
 * usually not the person who later punched the order. So the fact wins, and the screen says the
 * pinned value was overtaken rather than quietly dropping it.
 */
export function resolveRenewalStage(params: {
  override: RenewalStageKey | null | undefined;
  signals: RenewalSignals;
}): ResolvedRenewalStage {
  const derived = deriveRenewalStage(params.signals);

  if (params.override && params.override !== derived) {
    if (derived === "RENEWED") {
      return { ...renewalStageMeta("RENEWED"), source: "auto", supersededManual: params.override };
    }
    return { ...renewalStageMeta(params.override), source: "manual" };
  }

  // A pin that agrees with the evidence is reported as derived: it is no longer doing any work, and
  // calling it manual would attribute to a person something the record says anyway.
  return { ...renewalStageMeta(derived), source: "auto" };
}
