/**
 * The rules that decide who gets contacted, when, and with what.
 *
 * Every failure in this module is a quiet one. Nothing throws when a campaign reaches a reseller's
 * end customer, or lands at two in the morning, or greets two hundred people as "Hi ,". It sends
 * perfectly and the damage is entirely external — which is exactly why the arithmetic is checked
 * here rather than trusted.
 *
 *   npm run check:marketing
 */
import {
  canSend,
  suppressionReasons,
  summariseSuppressions,
  type RecipientState,
  type SendContext,
} from "../src/lib/marketing/suppression";
import {
  allowedBlocks,
  formatMinute,
  isSendableNow,
  nextSendTime,
  withinFrequencyCap,
  type ScheduleRules,
} from "../src/lib/marketing/schedule";
import { fieldsUsed, render, requiredFields } from "../src/lib/marketing/merge";
import {
  advance,
  enrolmentKey,
  firstStep,
  mayReEnrol,
  parseExitConditions,
  shouldExit,
  NO_SIGNALS,
} from "../src/lib/marketing/journey";
import { TRIGGERS, daysToFinancialYearEnd, triggerByKey } from "../src/lib/marketing/triggers";
import { capPerCompany, describeContactFilters, parseContactFilters } from "../src/lib/marketing/audience";
import {
  DEFAULT_FIELDS,
  parseFields,
  summariseAnswers,
  validateAnswers,
} from "../src/lib/marketing/form-fields";
import { formatRegisteredAddress, postalAddressFor } from "../src/lib/marketing/footer";
import {
  FULFILMENT_NOTICE,
  NOTICE_MESSAGE_CLASS,
  RENEWAL_NOTICE,
  canAnnounceFulfilment,
  daysLeftPhrase,
} from "../src/lib/marketing/customer-notices";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
function eq(label: string, actual: unknown, expected: unknown, why = "") {
  const pass = actual === expected;
  console.log(
    `${pass ? "  ok  " : " FAIL "} ${label} — ${String(actual)}${pass ? "" : ` (expected ${String(expected)})`}${why ? ` · ${why}` : ""}`,
  );
  if (!pass) failures += 1;
}
const iso = (d: Date) => d.toISOString();

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CLEAN: RecipientState = {
  company: { managedByResellerId: null },
  contact: {
    email: "rajesh@vertex.co.in",
    phone: "9820000000",
    emailStatus: "VALID",
    emailCheckedValue: "rajesh@vertex.co.in",
  },
  suppressions: [],
  consent: { status: "SUBSCRIBED" },
  signals: { unansweredFeedback: 0, daysOverdue: null, breachedTickets: 0, sentInLastWeek: 0 },
};

const MARKETING: SendContext = {
  messageClass: "MARKETING",
  channel: "EMAIL",
  topic: "RENEWALS",
  limits: { maxPerContactPerWeek: 2, overdueDaysBlock: 60, requireVerifiedAddress: true },
};
const TRANSACTIONAL: SendContext = { ...MARKETING, messageClass: "TRANSACTIONAL" };

const withState = (patch: Partial<RecipientState>): RecipientState => ({ ...CLEAN, ...patch });
const withSignals = (patch: Partial<RecipientState["signals"]>): RecipientState => ({
  ...CLEAN,
  signals: { ...CLEAN.signals, ...patch },
});

console.log("\n— The rule everything else defers to —\n");

const reseller = withState({ company: { managedByResellerId: "rsl_1" } });
const resellerVerdict = canSend(reseller, MARKETING);
ok("A reseller's end customer is never marketable", !resellerVerdict.ok);
eq("  and that is the reason given", resellerVerdict.ok ? "" : resellerVerdict.reason, "RESELLER_MANAGED");
ok(
  "  it outranks everything else, whatever else is wrong",
  suppressionReasons({ ...reseller, consent: null, suppressions: [{ reason: "UNSUBSCRIBED" }] }, MARKETING)[0].key ===
    "RESELLER_MANAGED",
  "the first reason is the one somebody acts on",
);
ok(
  "  and a transactional message does not get round it",
  !canSend(reseller, TRANSACTIONAL).ok,
  "if their reseller needs to tell them something, the reseller tells them",
);
ok("  it is a hard block", suppressionReasons(reseller, MARKETING)[0].hard);

console.log("\n— Clean contacts go through —\n");

ok("A verified, consented, quiet contact is sendable", canSend(CLEAN, MARKETING).ok);
eq("  with no findings at all", canSend(CLEAN, MARKETING).findings.length, 0);

console.log("\n— Hard blocks —\n");

ok("No address, nothing to send to", !canSend(withState({ contact: { ...CLEAN.contact, email: null } }), MARKETING).ok);
ok(
  "  and that's true of a transactional message too",
  !canSend(withState({ contact: { ...CLEAN.contact, email: null } }), TRANSACTIONAL).ok,
);
ok(
  "A checked, invalid address is blocked",
  !canSend(withState({ contact: { ...CLEAN.contact, emailStatus: "INVALID" } }), MARKETING).ok,
);
ok(
  "A bounce blocks a transactional message too",
  !canSend(withState({ suppressions: [{ reason: "HARD_BOUNCE" }] }), TRANSACTIONAL).ok,
  "the address doesn't work, whatever we want to tell them",
);
ok(
  "A spam complaint blocks everything",
  !canSend(withState({ suppressions: [{ reason: "COMPLAINT" }] }), TRANSACTIONAL).ok,
);

console.log("\n— Soft blocks: marketing only —\n");

const unsub = withState({ suppressions: [{ reason: "UNSUBSCRIBED" }] });
ok("An unsubscribe blocks marketing", !canSend(unsub, MARKETING).ok);
ok(
  "  but not their invoice",
  canSend(unsub, TRANSACTIONAL).ok,
  "unsubscribing from offers is not unsubscribing from being a customer",
);

const noConsent = withState({ consent: null });
const noConsentVerdict = canSend(noConsent, MARKETING);
ok("No recorded consent blocks marketing", !noConsentVerdict.ok);
eq("  and says so", noConsentVerdict.ok ? "" : noConsentVerdict.reason, "NO_CONSENT");
ok("  but not a transactional message", canSend(noConsent, TRANSACTIONAL).ok);

const stale = withState({ contact: { ...CLEAN.contact, emailCheckedValue: "old@vertex.co.in" } });
ok(
  "A verdict against a different address doesn't count",
  !canSend(stale, MARKETING).ok,
  "they changed their address since it was checked",
);
ok(
  "  unless verification isn't required",
  canSend(stale, { ...MARKETING, limits: { ...MARKETING.limits, requireVerifiedAddress: false } }).ok,
);
ok(
  "A risky address is held back from marketing",
  !canSend(withState({ contact: { ...CLEAN.contact, emailStatus: "RISKY" } }), MARKETING).ok,
  "a shared inbox reaches someone, but not reliably them",
);

console.log("\n— Don't sell to somebody you've let down —\n");

ok(
  "An unanswered complaint stops the offers",
  !canSend(withSignals({ unansweredFeedback: 1 }), MARKETING).ok,
  "answer it before selling them anything",
);
ok(
  "A ticket past its SLA stops them too",
  !canSend(withSignals({ breachedTickets: 2 }), MARKETING).ok,
);
ok("An invoice 60 days overdue stops them", !canSend(withSignals({ daysOverdue: 60 }), MARKETING).ok);
ok("  at 59 days it doesn't", canSend(withSignals({ daysOverdue: 59 }), MARKETING).ok, "the boundary is inclusive");
ok(
  "  and setting the block to 0 turns the rule off",
  canSend(withSignals({ daysOverdue: 900 }), { ...MARKETING, limits: { ...MARKETING.limits, overdueDaysBlock: 0 } }).ok,
);
ok(
  "None of those stop a service notice",
  canSend(withSignals({ unansweredFeedback: 3, breachedTickets: 2, daysOverdue: 200 }), TRANSACTIONAL).ok,
  "the outage email is exactly what they want",
);

console.log("\n— The frequency cap —\n");

ok("Two this week, and the cap is two", !canSend(withSignals({ sentInLastWeek: 2 }), MARKETING).ok);
ok("  one is fine", canSend(withSignals({ sentInLastWeek: 1 }), MARKETING).ok);
ok("A cap of zero means no cap", withinFrequencyCap(99, 0), "0 disables it rather than blocking everything");
ok("  and one below the cap passes", withinFrequencyCap(1, 2));
ok("  at the cap it does not", !withinFrequencyCap(2, 2));

console.log("\n— Every reason, not the first —\n");

const messy = withState({
  consent: null,
  contact: { ...CLEAN.contact, emailStatus: "RISKY" },
  signals: { unansweredFeedback: 1, daysOverdue: 90, breachedTickets: 1, sentInLastWeek: 5 },
});
const all = suppressionReasons(messy, MARKETING);
ok("A contact with six problems reports six", all.length === 6, all.map((f) => f.key).join(", "));
eq("  worst first", all[0].key, "UNANSWERED_COMPLAINT", "the one somebody should act on");
ok("  the cap comes last", all[all.length - 1].key === "FREQUENCY_CAP");
ok(
  "  and each one says what to do about it",
  all.every((f) => f.detail.length > 20),
  "a count is not actionable; a sentence is",
);

const breakdown = summariseSuppressions([
  canSend(CLEAN, MARKETING),
  canSend(CLEAN, MARKETING),
  canSend(unsub, MARKETING),
  canSend(noConsent, MARKETING),
  canSend(noConsent, MARKETING),
  canSend(reseller, MARKETING),
]);
eq("The dry run counts what will go", breakdown.sendable, 2);
eq("  and what won't", breakdown.suppressed, 4);
eq("  grouped by reason", breakdown.byReason.length, 3);
eq("  worst reason first", breakdown.byReason[0].key, "RESELLER_MANAGED");
eq("  with counts that add up", breakdown.byReason.reduce((t, r) => t + r.count, 0), 4);

// Two stored suppressions raising one key must not be counted twice.
const doubled = suppressionReasons(
  withState({ suppressions: [{ reason: "UNSUBSCRIBED" }, { reason: "UNSUBSCRIBED" }] }),
  MARKETING,
);
eq("The same reason twice is reported once", doubled.filter((f) => f.key === "UNSUBSCRIBED").length, 1);

console.log("\n— When it may go out —\n");

// Quiet 20:00–09:00 IST. 2026-09-19 is a Saturday, 21st the Monday.
const QUIET = { startMinute: 1200, endMinute: 540 };
const RULES: ScheduleRules = { quiet: QUIET, skipNonWorkingDays: true, holidays: new Set<string>() };

const blocks = allowedBlocks({ quiet: QUIET });
eq("Quiet hours across midnight leave one block", blocks.length, 1);
eq("  starting at 9am", blocks[0][0], 540);
eq("  ending at 8pm", blocks[0][1], 1200);

const midday = allowedBlocks({ quiet: { startMinute: 540, endMinute: 1200 } });
eq("Quiet hours inside one day leave two", midday.length, 2, "an odd setting, but a real one");

const narrowed = allowedBlocks({ quiet: QUIET, window: { startMinute: 600, endMinute: 720 } });
eq("A campaign window narrows it further", narrowed[0][0], 600);
eq("  on both sides", narrowed[0][1], 720);

ok("Monday 9:30am is sendable", isSendableNow(new Date("2026-09-21T04:00:00.000Z"), RULES), "09:30 IST");
ok("3am is not", !isSendableNow(new Date("2026-09-21T21:30:00.000Z"), RULES));
ok("Saturday is not", !isSendableNow(new Date("2026-09-19T05:00:00.000Z"), RULES));
ok(
  "  unless weekends are allowed",
  isSendableNow(new Date("2026-09-19T05:00:00.000Z"), { ...RULES, skipNonWorkingDays: false }),
);

eq(
  "Saturday lunchtime waits for Monday morning",
  iso(nextSendTime(new Date("2026-09-19T06:30:00.000Z"), RULES)),
  "2026-09-21T03:30:00.000Z",
  "09:00 IST Monday",
);
eq(
  "A holiday on Monday pushes it to Tuesday",
  iso(nextSendTime(new Date("2026-09-19T06:30:00.000Z"), { ...RULES, holidays: new Set(["2026-09-21"]) })),
  "2026-09-22T03:30:00.000Z",
);
eq(
  "3am on a working day waits until 9",
  iso(nextSendTime(new Date("2026-09-21T21:30:00.000Z"), RULES)),
  "2026-09-22T03:30:00.000Z",
  "21:30Z is 3am IST on the 22nd",
);
eq(
  "A time already inside the window is left alone",
  iso(nextSendTime(new Date("2026-09-21T06:00:00.000Z"), RULES)),
  "2026-09-21T06:00:00.000Z",
  "11:30 IST — no reason to delay it",
);
ok(
  "A configuration with no window at all returns rather than spinning",
  nextSendTime(new Date("2026-09-21T06:00:00.000Z"), {
    quiet: { startMinute: 0, endMinute: 0 },
    window: { startMinute: 600, endMinute: 600 },
    skipNonWorkingDays: false,
  }) instanceof Date,
);

eq("Minutes read as clock times", formatMinute(540), "9:00 am");
eq("  including noon", formatMinute(720), "12:00 pm");
eq("  and midnight", formatMinute(0), "12:00 am");
eq("  and the evening", formatMinute(1200), "8:00 pm");

console.log("\n— Filling a template in —\n");

const HELLO = "Hi {{firstName}}, your {{productName}} expires on {{expiryDate}}.";
const rendered = render(HELLO, { firstName: "Rajesh", productName: "Microsoft 365", expiryDate: "9 Aug 2027" });
ok("A complete template renders", rendered.ok);
eq("  with the values in", rendered.ok ? rendered.text : "", "Hi Rajesh, your Microsoft 365 expires on 9 Aug 2027.");

const blank = render(HELLO, { firstName: "", productName: "Microsoft 365", expiryDate: "9 Aug 2027" });
ok("An empty name blocks the send", !blank.ok, "this is the 'Hi ,' case, and it must never go out");
eq("  naming the field", blank.ok ? "" : blank.missing[0], "firstName");
ok("A missing key blocks it too", !render(HELLO, { productName: "x", expiryDate: "y" }).ok);
ok("  and whitespace counts as missing", !render(HELLO, { firstName: "   ", productName: "x", expiryDate: "y" }).ok);

const fallback = render("Hi {{firstName|there}}, a quick note.", {});
ok("A fallback rescues it", fallback.ok);
eq("  using what the author wrote", fallback.ok ? fallback.text : "", "Hi there, a quick note.");
ok(
  "  and the real value still wins",
  render("Hi {{firstName|there}}!", { firstName: "Rajesh" }).ok &&
    (render("Hi {{firstName|there}}!", { firstName: "Rajesh" }) as { text: string }).text === "Hi Rajesh!",
);

// The bar is the decision, and the distinction is the whole guard: writing one means the author
// thought about a recipient with no value; omitting it means they never did.
const deliberate = render("Hi{{firstName|}}, a note.", {});
ok("An explicitly empty fallback prints nothing, on purpose", deliberate.ok, "{{field|}} is a decision");
eq("  and leaves the rest intact", deliberate.ok ? deliberate.text : "", "Hi, a note.");
ok(
  "  while omitting the bar still blocks",
  !render("Hi {{firstName}}, a note.", {}).ok,
  "which is what stops \"Hi ,\" going out",
);
eq(
  "A field with an empty fallback is not \"required\"",
  requiredFields("{{firstName|}}").length,
  0,
  "so the editor does not warn about something already handled",
);

const typo = render("Hi {{frstName}}", { firstName: "Rajesh" });
ok("A typo'd field is refused", !typo.ok);
eq("  and reported as unknown, not missing", typo.ok ? "" : typo.unknown[0], "frstName", "an author error, fixable now");

ok("Spaces inside the braces are tolerated", render("Hi {{ firstName }}", { firstName: "R" }).ok, "people type by hand");
eq("A template declares what it needs", requiredFields(HELLO).length, 3);
eq("  and a fallback removes it from that list", requiredFields("{{firstName|there}}").length, 0);
eq("Unknown fields are separated out", fieldsUsed("{{firstName}} {{nope}}").unknown[0], "nope");
eq("  from known ones", fieldsUsed("{{firstName}} {{nope}}").known[0], "firstName");

console.log("\n— Journeys —\n");

eq("An enrolment is keyed on its subject", enrolmentKey("SUBSCRIPTION_RENEWAL", "cp_1"), "SUBSCRIPTION_RENEWAL:cp_1");
eq("  and the window, where there is one", enrolmentKey("SUBSCRIPTION_RENEWAL", "cp_1", 60), "SUBSCRIPTION_RENEWAL:cp_1:60");
ok(
  "  so two subscriptions at one company are two conversations",
  enrolmentKey("SUBSCRIPTION_RENEWAL", "cp_1") !== enrolmentKey("SUBSCRIPTION_RENEWAL", "cp_2"),
);
ok(
  "  but the same one found again tomorrow is not",
  enrolmentKey("SUBSCRIPTION_RENEWAL", "cp_1") === enrolmentKey("SUBSCRIPTION_RENEWAL", "cp_1"),
);

ok("Nothing has happened, so nobody exits", !shouldExit(["ORDERED"], NO_SIGNALS).exit);
ok("They ordered, so they exit", shouldExit(["ORDERED"], { ...NO_SIGNALS, ordered: true }).exit);
eq(
  "  with the reason recorded",
  shouldExit(["ORDERED"], { ...NO_SIGNALS, ordered: true }).reason,
  "ORDERED",
);
ok(
  "An unsubscribe always exits, configured or not",
  shouldExit([], { ...NO_SIGNALS, unsubscribed: true }).exit,
  "not a preference an author gets to ignore",
);
ok("Becoming unreachable always exits too", shouldExit([], { ...NO_SIGNALS, suppressed: true }).exit);
ok(
  "A condition nobody asked for doesn't fire",
  !shouldExit(["ORDERED"], { ...NO_SIGNALS, ticketRaised: true }).exit,
);
eq("Unrecognised exit conditions are dropped", parseExitConditions(["ORDERED", "NONSENSE"]).length, 1);
eq("  and a non-array is empty", parseExitConditions("ORDERED").length, 0);

const STEPS = [
  { id: "s1", order: 1, delayDays: 0 },
  { id: "s2", order: 2, delayDays: 7 },
  { id: "s3", order: 3, delayDays: 14 },
];
eq("The first step is the lowest order", firstStep(STEPS)?.id, "s1");
eq("  even when the array is out of order", firstStep([STEPS[2], STEPS[0], STEPS[1]])?.id, "s1");

const NOW = new Date("2026-09-21T03:30:00.000Z");
const next = advance(1, STEPS, NOW);
ok("After step 1 comes step 2", !next.done && next.step.id === "s2");
eq(
  "  seven days later",
  !next.done ? iso(next.dueAt) : "",
  "2026-09-28T03:30:00.000Z",
);
ok("After the last step the journey is done", advance(3, STEPS, NOW).done);
ok("A step order that no longer exists still terminates", advance(99, STEPS, NOW).done);

ok("Never enrolled means enrol", mayReEnrol({ reEnrolAfterDays: 365, lastEnrolledAt: null }).ok);
ok(
  "A once-per-lifetime journey never re-enrols",
  !mayReEnrol({ reEnrolAfterDays: null, lastEnrolledAt: new Date("2020-01-01"), now: NOW }).ok,
  "a welcome sequence runs once",
);
ok(
  "A renewal journey re-enrols after a year",
  mayReEnrol({ reEnrolAfterDays: 365, lastEnrolledAt: new Date("2025-09-01"), now: NOW }).ok,
);
ok(
  "  but not after a month",
  !mayReEnrol({ reEnrolAfterDays: 365, lastEnrolledAt: new Date("2026-08-21"), now: NOW }).ok,
);

console.log("\n— Triggers —\n");

ok("Every trigger has a definition", TRIGGERS.length >= 19, `${TRIGGERS.length}`);
ok(
  "  and every one says what it enrols",
  TRIGGERS.every((t) => t.enrols.length > 25),
  "so nobody has to read a query to find out",
);
ok(
  "  the contentious ones say what they leave out",
  ["SUBSCRIPTION_RENEWAL", "WARRANTY_EXPIRING", "NEW_CUSTOMER", "LEAD_LOST_REVISIT", "SEAT_GAP"].every(
    (k) => !!triggerByKey[k].excludes,
  ),
  "addons, covered machines, repeat orders, disqualified leads, unknown headcount",
);
ok(
  "  the renewal trigger excludes addon seats by name",
  triggerByKey.SUBSCRIPTION_RENEWAL.excludes!.includes("co-terminate"),
  "one expiry, one conversation",
);
ok("  every key is unique", new Set(TRIGGERS.map((t) => t.key)).size === TRIGGERS.length);
ok(
  "  a window means something wherever there is one",
  TRIGGERS.filter((t) => t.defaultDays !== undefined).every((t) => !!t.daysLabel),
  "60 what?",
);
ok("  and some hand a person a job rather than mailing", TRIGGERS.some((t) => t.suits === "TASK"));

eq("The financial year ends in March", daysToFinancialYearEnd(new Date("2026-09-19T00:00:00Z")), 193);
ok(
  "  and April counts to the following March",
  daysToFinancialYearEnd(new Date("2026-04-01T00:00:00Z")) > 300,
  `${daysToFinancialYearEnd(new Date("2026-04-01T00:00:00Z"))} days`,
);
ok(
  "  while February counts to the one weeks away",
  daysToFinancialYearEnd(new Date("2027-02-01T00:00:00Z")) < 70,
  `${daysToFinancialYearEnd(new Date("2027-02-01T00:00:00Z"))} days`,
);

console.log("\n— The renewal reminder —\n");

eq("58 days out reads as a sentence, not a bare number", daysLeftPhrase(58), "That's 58 days away.");
eq("  tomorrow is tomorrow", daysLeftPhrase(1), "That's tomorrow.");
eq("  today is today", daysLeftPhrase(0), "That's today.");
eq("  yesterday is not '-1 days away'", daysLeftPhrase(-1), "That was yesterday.");
eq("  and a lapsed one reads as past", daysLeftPhrase(-12), "That was 12 days ago.");
eq("  with no expiry there is no phrase", daysLeftPhrase(null), null, "rather than an empty clause");
ok(
  "  and it carries no leading space to lose",
  daysLeftPhrase(58) === daysLeftPhrase(58)?.trim(),
  "render trims every value it substitutes, so a clause relying on one would run into the word before",
);

// The default wording has to render for a subscription with almost nothing filled in — a reminder
// that refuses because the unit price was blank is a reminder nobody sends.
const bare = render(RENEWAL_NOTICE.subject + "\n" + RENEWAL_NOTICE.body, {
  companyName: "Vertex Industries LLP",
  ourName: "Wroffy",
  unsubscribeUrl: "https://example.test/preferences/abc",
});
ok("The standard wording renders with almost nothing filled in", bare.ok, "every field carries a fallback");
ok(
  "  and still names the customer",
  bare.ok && bare.text.includes("Vertex Industries LLP"),
);
ok(
  "  and still carries the unsubscribe link",
  bare.ok && bare.text.includes("/preferences/abc"),
);

const subjectLine = render(RENEWAL_NOTICE.subject, {
  productName: "Microsoft 365 Business Basic",
  expiryDate: "9 Aug 2027",
});
ok("A filled-in subject names the product and the date", subjectLine.ok);
eq(
  "  reading as somebody would write it",
  subjectLine.ok ? subjectLine.text : "",
  "Microsoft 365 Business Basic renews on 9 Aug 2027",
);

// The class is the whole reason an opt-out doesn't silence this.
// ── The fulfilment notice, which shares everything but the words ──
ok(
  "A fulfilment notice only goes out once the order is fulfilled",
  canAnnounceFulfilment("FULFILLED"),
);
for (const status of ["PENDING_APPROVAL", "APPROVED", "PROCESSING", "REJECTED", "CANCELLED"]) {
  ok(
    `  and never while it is ${status.toLowerCase().replaceAll("_", " ")}`,
    !canAnnounceFulfilment(status),
    status === "PROCESSING" ? "purchasing is still sourcing it — the worst possible time to say it is ready" : "",
  );
}

const fulfilment = render([FULFILMENT_NOTICE.subject, FULFILMENT_NOTICE.body].join(String.fromCharCode(10)), {
  companyName: "Vertex Industries LLP",
  ourName: "Wroffy",
  unsubscribeUrl: "https://example.test/preferences/abc",
});
ok("The fulfilment wording renders with almost nothing filled in", fulfilment.ok, "every field carries a fallback");
ok(
  "  and reads as done rather than due",
  fulfilment.ok && fulfilment.text.includes("complete") && !fulfilment.text.includes("renewal"),
);
eq(
  "  it is filed under service, not offers",
  FULFILMENT_NOTICE.topic,
  "SERVICE",
  "so it is not competing with marketing for the customer's patience",
);
ok(
  "  and carries the order number and their PO",
  FULFILMENT_NOTICE.body.includes("{{orderId") && FULFILMENT_NOTICE.body.includes("{{poNumber"),
  "the two things a purchase manager matches it against",
);

eq("A renewal notice is transactional", NOTICE_MESSAGE_CLASS, "TRANSACTIONAL");
const optedOut: RecipientState = {
  company: { managedByResellerId: null },
  contact: {
    email: "rajesh@vertex.co.in",
    phone: null,
    emailStatus: "VALID",
    emailCheckedValue: "rajesh@vertex.co.in",
  },
  suppressions: [{ reason: "UNSUBSCRIBED" }],
  consent: null,
  signals: { unansweredFeedback: 0, daysOverdue: null, breachedTickets: 0, sentInLastWeek: 9 },
};
const asNotice = { messageClass: NOTICE_MESSAGE_CLASS, channel: "EMAIL", topic: "RENEWALS", limits: MARKETING.limits } as const;
ok(
  "Somebody who unsubscribed from marketing still gets it",
  canSend(optedOut, asNotice).ok,
  "they opted out of offers, not out of being told their licences expire",
);
ok(
  "  and the frequency cap doesn't silence it either",
  canSend({ ...optedOut, signals: { ...optedOut.signals, sentInLastWeek: 99 } }, asNotice).ok,
);
ok(
  "But a bounced address still stops it",
  !canSend({ ...optedOut, suppressions: [{ reason: "HARD_BOUNCE" }] }, asNotice).ok,
  "the mailbox does not exist, whatever we want to tell them",
);
ok(
  "  as does a reseller's customer",
  !canSend({ ...optedOut, company: { managedByResellerId: "rsl_1" } }, asNotice).ok,
  "the renewal belongs to the reseller — that is who we write to",
);

console.log("\n— The footer address —\n");

const REGISTERED = {
  legalName: "Wroffy Technologies Private Limited",
  tradeName: "Wroffy",
  addressLine1: "Unit 401, Trade Centre",
  addressLine2: "Andheri East",
  city: "Mumbai",
  state: "Maharashtra",
  pincode: "400069",
};

const full = formatRegisteredAddress(REGISTERED);
eq(
  "The registered office reads as an address",
  full,
  "Wroffy Technologies Private Limited\nUnit 401, Trade Centre, Andheri East\nMumbai, Maharashtra 400069",
);
eq(
  "  the pincode belongs to the state, not after another comma",
  full?.split("\n")[2],
  "Mumbai, Maharashtra 400069",
);

const derived = postalAddressFor({ ...REGISTERED, marketingPostalAddress: null });
eq("With nothing set, the registered office is used", derived.source, "REGISTERED", "the app already knows where we are");
ok("  and it is a real address", (derived.text?.length ?? 0) > 30);

const overridden = postalAddressFor({ ...REGISTERED, marketingPostalAddress: "Wroffy, PO Box 12, Mumbai" });
eq("An override wins", overridden.text, "Wroffy, PO Box 12, Mumbai");
eq("  and says it was deliberate", overridden.source, "OVERRIDE");
eq(
  "Whitespace is not an override",
  postalAddressFor({ ...REGISTERED, marketingPostalAddress: "   " }).source,
  "REGISTERED",
  "or a stray space would silently empty the footer",
);

// A half-filled address still beats none: an empty footer is a filtered email.
const partial = formatRegisteredAddress({
  legalName: "Wroffy Technologies Private Limited",
  tradeName: null,
  addressLine1: null,
  addressLine2: null,
  city: "Mumbai",
  state: null,
  pincode: null,
});
eq("A half-filled address still produces one", partial, "Wroffy Technologies Private Limited\nMumbai");

eq(
  "A trade name stands in when there is no legal name",
  formatRegisteredAddress({ ...REGISTERED, legalName: "", tradeName: "Wroffy" })?.split("\n")[0],
  "Wroffy",
);

const nothing = postalAddressFor({
  legalName: "",
  tradeName: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  pincode: null,
  marketingPostalAddress: null,
});
eq("With genuinely nothing on file, there is nothing", nothing.text, null);
eq("  and the page warns rather than printing an empty footer", nothing.source, "NONE");

console.log("\n— Audiences —\n");

const CONTACTS = [
  { id: "a", companyId: "c1", isPrimary: false },
  { id: "b", companyId: "c1", isPrimary: true },
  { id: "c", companyId: "c1", isPrimary: false },
  { id: "d", companyId: "c2", isPrimary: false },
];
const capped = capPerCompany(CONTACTS, 2);
eq("A cap of two per company keeps three of four", capped.length, 3);
eq("  and one of them is the primary", capped.filter((c) => c.id === "b").length, 1);
eq(
  "A cap of one keeps the primary, not the first row",
  capPerCompany(CONTACTS, 1).find((c) => c.companyId === "c1")?.id,
  "b",
  "the person who signs things",
);
eq("A cap of zero keeps everybody", capPerCompany(CONTACTS, 0).length, 4);

const defaults = parseContactFilters(undefined);
ok("Missing contact filters fall back to verified-only", defaults.verifiedOnly === true, "the safe default");
ok("  with a per-company cap", (defaults.maxPerCompany ?? 0) > 0);
ok(
  "An explicit false survives the parse",
  parseContactFilters({ verifiedOnly: false }).verifiedOnly === false,
  "or the setting could never be turned off",
);
ok(
  "An audience describes itself",
  describeContactFilters({ primaryOnly: true, verifiedOnly: true, maxPerCompany: 1 }).includes("primary contact only"),
  describeContactFilters({ primaryOnly: true, verifiedOnly: true, maxPerCompany: 1 }),
);


console.log("\n— Inbound forms —\n");

// The spec is a JSON column an admin edits, so every one of these is a shape that has actually
// reached the parser or plausibly will. None of them may produce a page a stranger cannot use.
eq("A missing spec falls back to the defaults", parseFields(undefined).length, DEFAULT_FIELDS.length);
eq("  and so does an empty array", parseFields([]).length, DEFAULT_FIELDS.length, "seed-marketing writes exactly this");
eq("  and so does a string", parseFields("name,email").length, DEFAULT_FIELDS.length);
eq("  and so does a list of rubbish", parseFields([null, 3, {}, { label: "No key" }]).length, DEFAULT_FIELDS.length);

const custom = parseFields([
  { key: "name", label: "Your name", type: "TEXT", required: true },
  { key: "email", label: "Work email", type: "EMAIL", required: true },
  { key: "seats", label: "How many seats?", type: "TEXT", required: true },
  { key: "plan", label: "Plan", type: "SELECT", required: false, options: ["E3", "E5"] },
]);
eq("A real spec is used as written", custom.length, 4);
eq("  keeping the questions it asks", custom[2]?.label, "How many seats?");
eq("  and the options it offers", custom[3]?.options.join("/"), "E3/E5");

// Looked up by key, never by index: `parseFields` puts name and email at the front, so [0] is
// whichever of those it had to put back — and two of these assertions passed on that by
// accident before, which is a check that proves nothing.
const only = (spec: unknown, key: string) => parseFields(spec).find((f) => f.key === key);

eq("An unknown type becomes a text box", only([{ key: "a", type: "COLOUR" }], "a")?.type, "TEXT", "rather than rendering nothing");
eq("  and `kind` is read as `type`", only([{ key: "a", kind: "TEXTAREA" }], "a")?.type, "TEXTAREA", "an earlier writer used that spelling");
eq(
  "A select with no options becomes a text box",
  only([{ key: "a", type: "SELECT" }], "a")?.type,
  "TEXT",
  "a dropdown with nothing in it cannot be answered",
);
eq("A duplicate key is dropped", parseFields([{ key: "a", label: "First" }, { key: "a", label: "Second" }]).filter((f) => f.key === "a").length, 1);
eq("  keeping the first", parseFields([{ key: "a", label: "First" }, { key: "a", label: "Second" }]).find((f) => f.key === "a")?.label, "First");
eq("A field with no label falls back to its key", only([{ key: "seats" }], "seats")?.label, "seats");

// The invariant the submit path depends on. Without these two there is no contact to create and
// nobody to reply to, so an admin cannot remove them by editing the column.
const stripped = parseFields([{ key: "seats", label: "Seats", required: true }]);
ok("Name and email are put back when a spec leaves them out", stripped.some((f) => f.key === "name") && stripped.some((f) => f.key === "email"));
ok(
  "  and forced to required when a spec says otherwise",
  parseFields([{ key: "email", label: "Email", required: false }]).find((f) => f.key === "email")?.required === true,
);
eq(
  "  and the address field is validated as an address whatever it was declared as",
  parseFields([{ key: "email", label: "Email", type: "TEXT" }]).find((f) => f.key === "email")?.type,
  "EMAIL",
);

const answers = { name: "Priya", email: "priya@acme.example", seats: "", plan: "E3" };
eq("A missing required answer is refused", Object.keys(validateAnswers(custom, answers)).join(), "seats");
eq("  naming the question, not the key", validateAnswers(custom, answers).seats, "How many seats? is needed.");
eq("A complete set passes", Object.keys(validateAnswers(custom, { ...answers, seats: "45" })).length, 0);
eq(
  "A bad address is refused",
  validateAnswers(custom, { ...answers, seats: "45", email: "priya at acme" }).email,
  "That doesn't look like an email address.",
);
ok(
  "An answer that is not on the list is refused",
  validateAnswers(custom, { ...answers, seats: "45", plan: "E7" }).plan !== undefined,
  "or a dropdown is only a suggestion",
);
eq("An empty optional answer is not picked over", Object.keys(validateAnswers(custom, { ...answers, seats: "45", plan: "" })).length, 0);

eq(
  "The lead description carries the custom answers",
  summariseAnswers(custom, { ...answers, seats: "45" }),
  "How many seats?: 45" + String.fromCharCode(10) + "Plan: E3",
);
ok(
  "  and not the ones that are already columns",
  !summariseAnswers(custom, { ...answers, seats: "45" }).includes("priya@acme.example"),
  "repeating the email into the description makes it longer, not clearer",
);

console.log(failures === 0 ? "\nAll marketing checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
