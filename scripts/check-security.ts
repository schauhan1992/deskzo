/**
 * The decisions the DLP layer makes, checked without a browser or a database.
 *
 * Most of this module fails quietly by construction. A crawler classified as a browser is simply
 * let in; a screenshot cap that resets at the wrong hour hands out a second allowance every night;
 * a throttle that never lets go writes nothing for the rest of the process's life. None of those
 * throw, none of them show up on a screen, and all of them make the feature a placebo — so the
 * arithmetic is checked here rather than trusted.
 *
 *   npm run check:security
 */
import { classifyUserAgent, shouldBlockBot, isMachineEndpoint } from "../src/lib/security/bots";
import { permissionsPolicyFor } from "../src/lib/security/headers";
import {
  DEFAULT_SECURITY_POLICY,
  dlpApplies,
  hasAnyDeterrent,
  screenshotDecision,
  istDayKey,
  exportDecision,
  isBulkRead,
  type SecurityPolicyShape,
} from "../src/lib/security/policy";
import { throttle, resetThrottle } from "../src/lib/security/throttle";
import { noteReads, resetBulkRead } from "../src/lib/security/bulk-read";
import { ACTIVITY_KINDS, activityKind, kindsInGroup, severitiesAtLeast, SEVERITY_TONE } from "../src/lib/security/activity-kinds";

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

const policy = (over: Partial<SecurityPolicyShape> = {}): SecurityPolicyShape => ({ ...DEFAULT_SECURITY_POLICY, ...over });

console.log("\n— Telling a browser from a crawler —\n");

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

eq("A real Chrome is not a bot", classifyUserAgent(CHROME), null, "the false positive that would lock out the sales team");
eq("Nor is Safari on an iPhone", classifyUserAgent(SAFARI_IOS), null);
eq(
  "  even though 'Mobile' and 'Version' look odd",
  classifyUserAgent(SAFARI_IOS)?.category ?? "browser",
  "browser",
);

eq("GPTBot is an AI crawler", classifyUserAgent("GPTBot/1.2 (+https://openai.com/gptbot)")?.category, "AI_CRAWLER");
eq("ClaudeBot too", classifyUserAgent("Mozilla/5.0 (compatible; ClaudeBot/1.0)")?.category, "AI_CRAWLER");
eq("CCBot too", classifyUserAgent("CCBot/2.0 (https://commoncrawl.org/faq/)")?.category, "AI_CRAWLER");
eq("Google-Extended too", classifyUserAgent("Google-Extended")?.category, "AI_CRAWLER");
eq("Bytespider too", classifyUserAgent("Bytespider")?.category, "AI_CRAWLER");

eq(
  "Googlebot is a search crawler, not an AI one",
  classifyUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")?.category,
  "SEARCH_CRAWLER",
  "the specific signatures must beat the generic 'bot' catch-all",
);
eq("Bingbot as well", classifyUserAgent("Mozilla/5.0 (compatible; bingbot/2.0)")?.category, "SEARCH_CRAWLER");

eq("curl is automation", classifyUserAgent("curl/8.4.0")?.category, "AUTOMATION");
eq("python-requests too", classifyUserAgent("python-requests/2.31.0")?.category, "AUTOMATION");
eq("headless Chrome too", classifyUserAgent(`${CHROME.replace("Chrome", "HeadlessChrome")}`)?.category, "AUTOMATION");
eq("Playwright too", classifyUserAgent("Mozilla/5.0 playwright/1.44")?.category, "AUTOMATION");
eq("An empty agent counts as automation", classifyUserAgent("")?.category, "AUTOMATION", "every real browser sends one");
eq("  and so does a missing one", classifyUserAgent(null)?.category, "AUTOMATION");
eq("AhrefsBot is an SEO crawler", classifyUserAgent("Mozilla/5.0 (compatible; AhrefsBot/7.0)")?.category, "SEO_CRAWLER");
eq("UptimeRobot is a monitor", classifyUserAgent("Mozilla/5.0+(compatible; UptimeRobot/2.0)")?.category, "MONITOR");
eq(
  "Something merely calling itself a spider is generic",
  classifyUserAgent("SomeNewThing spider v3")?.category,
  "GENERIC_BOT",
);

console.log("\n— What gets turned away —\n");

const on = { blockBots: true, blockAiCrawlers: true };
const aiOnly = { blockBots: false, blockAiCrawlers: true };
const allOff = { blockBots: false, blockAiCrawlers: false };

ok("A browser is never blocked", !shouldBlockBot(classifyUserAgent(CHROME), on));
ok("GPTBot is blocked when AI blocking is on", shouldBlockBot(classifyUserAgent("GPTBot/1.2"), aiOnly));
ok(
  "  and still blocked when only general bot blocking is on",
  shouldBlockBot(classifyUserAgent("GPTBot/1.2"), { blockBots: true, blockAiCrawlers: false }),
  "an admin who blocks all bots did not mean 'except the AI ones'",
);
ok("Googlebot is not blocked by the AI setting alone", !shouldBlockBot(classifyUserAgent("Googlebot/2.1"), aiOnly));
ok("  but is when general bot blocking is on", shouldBlockBot(classifyUserAgent("Googlebot/2.1"), on));
ok(
  "A monitor is never blocked, even with everything on",
  !shouldBlockBot(classifyUserAgent("UptimeRobot/2.0"), on),
  "a 403 at 3am teaches everyone to ignore the alerting",
);
ok("Nothing is blocked when both settings are off", !shouldBlockBot(classifyUserAgent("curl/8.4.0"), allOff));

ok("The biometric endpoint is exempt", isMachineEndpoint("/iclock/cdata"), "firmware retries forever on a 403");
ok("  and so is every API route", isMachineEndpoint("/api/marketing/tick"));
ok("A dashboard page is not exempt", !isMachineEndpoint("/companies"));
ok("Nor is a public customer page", !isMachineEndpoint("/review/abc123"), "the one page a crawler can actually reach");

console.log("\n— The screenshot allowance —\n");

eq("The first of two is allowed", screenshotDecision(0, 2).allowed, true);
eq("  and says one is left", screenshotDecision(0, 2).remaining, 1);
eq("The second is allowed", screenshotDecision(1, 2).allowed, true);
eq("  and says it was the last", screenshotDecision(1, 2).remaining, 0);
ok("  and says so in words", screenshotDecision(1, 2).reason.includes("last screenshot"), screenshotDecision(1, 2).reason);
eq("The third is refused", screenshotDecision(2, 2).allowed, false);
ok(
  "  and the refusal says it was logged",
  screenshotDecision(2, 2).reason.includes("logged"),
  screenshotDecision(2, 2).reason,
);
eq("A limit of zero refuses the first", screenshotDecision(0, 0).allowed, false);
eq("A limit of -1 allows everything", screenshotDecision(999, -1).allowed, true);
eq("  and reports no remaining count", screenshotDecision(999, -1).remaining, null, "rather than a misleading zero");
eq("A limit of one reads as singular", screenshotDecision(1, 1).reason.includes("1 screenshot."), true);

console.log("\n— Which day a screenshot counts against —\n");

// 03:00 IST on 21 September is 21:30 UTC on the 20th. A UTC day key would file it under the 20th,
// which hands the night shift a second allowance and resets the cap mid-afternoon.
eq("3am IST counts as that morning", istDayKey(new Date("2026-09-20T21:30:00.000Z")), "2026-09-21");
eq("  where a UTC key would say the day before", new Date("2026-09-20T21:30:00.000Z").toISOString().slice(0, 10), "2026-09-20");
eq("Just before midnight IST is still that day", istDayKey(new Date("2026-09-21T18:29:00.000Z")), "2026-09-21");
eq("Just after midnight IST is the next", istDayKey(new Date("2026-09-21T18:31:00.000Z")), "2026-09-22");

console.log("\n— Who the deterrents apply to —\n");

ok("An admin is never restricted", !dlpApplies("ADMIN", policy()), "they could not undo it otherwise");
ok("A salesperson is", dlpApplies("SALES", policy()));
ok("Unless their role is exempt", !dlpApplies("SALES", policy({ exemptRoles: ["SALES"] })));
ok("Exempting one role leaves the others alone", dlpApplies("SUPPORT", policy({ exemptRoles: ["SALES"] })));
ok("Nobody at all means nobody", !dlpApplies(null, policy()));
ok(
  "An admin stays exempt even if ADMIN is somehow in the list",
  !dlpApplies("ADMIN", policy({ exemptRoles: ["ADMIN", "SALES"] })),
  "the exemption is in code, not in data somebody can remove",
);

ok("The default policy still has something to mount", hasAnyDeterrent(DEFAULT_SECURITY_POLICY), "the screenshot cap");
ok(
  "Everything off and screenshots unlimited means nothing to mount",
  !hasAnyDeterrent(policy({ screenshotLimitPerDay: -1 })),
  "so the guard is not rendered at all",
);
ok("A watermark alone is enough to mount", hasAnyDeterrent(policy({ screenshotLimitPerDay: -1, watermarkEnabled: true })));

console.log("\n— Exports and read volume —\n");

ok("An export inside the cap is allowed", exportDecision(999, policy({ exportRowLimit: 1000 })).allowed);
ok("  exactly at the cap too", exportDecision(1000, policy({ exportRowLimit: 1000 })).allowed, "1000 is not 'more than 1000'");
ok("  one over is refused", !exportDecision(1001, policy({ exportRowLimit: 1000 })).allowed);
ok(
  "  and the refusal says what to do",
  exportDecision(1001, policy({ exportRowLimit: 1000 })).reason.includes("Narrow the filters"),
  exportDecision(1001, policy({ exportRowLimit: 1000 })).reason,
);
ok("A cap of zero is no cap", exportDecision(500_000, policy({ exportRowLimit: 0 })).allowed);

ok("Reads under the threshold are ordinary work", !isBulkRead(399, policy({ bulkReadThreshold: 400 })));
ok("Reads at the threshold are not", isBulkRead(400, policy({ bulkReadThreshold: 400 })), "a threshold of 400 fires at 400");
ok("A threshold of zero switches the check off", !isBulkRead(99_999, policy({ bulkReadThreshold: 0 })));

console.log("\n— Counting reads in a window —\n");

resetBulkRead();
const WINDOW = 10 * 60_000;
const t0 = 1_800_000_000_000;
eq("A first page of 50 counts 50", noteReads("u1", 50, WINDOW, t0), 50);
eq("  a second page adds up", noteReads("u1", 50, WINDOW, t0 + 1000), 100);
eq("  and a third", noteReads("u1", 200, WINDOW, t0 + 2000), 300);
eq("Another user counts separately", noteReads("u2", 10, WINDOW, t0 + 2000), 10, "or one busy person incriminates everybody");
eq(
  "Past the window the count restarts",
  noteReads("u1", 25, WINDOW, t0 + WINDOW + 1),
  25,
  "otherwise a long-lived session eventually trips no matter what it does",
);

console.log("\n— Writing the first, counting the rest —\n");

resetThrottle();
const w = 120_000;
eq("The first occurrence is written", throttle("k", w, t0).write, true);
eq("  with nothing suppressed before it", throttle("k2", w, t0).suppressedSince, 0);
eq("The second inside the window is not", throttle("k", w, t0 + 1000).write, false);
eq("  and counts itself", throttle("k", w, t0 + 2000).suppressedSince, 2);
eq("After the window it writes again", throttle("k", w, t0 + w + 1).write, true);
eq(
  "  reporting what it swallowed",
  throttle("k3", w, t0).write && (throttle("k3", w, t0 + 1), throttle("k3", w, t0 + 2), throttle("k3", w, t0 + w + 1).suppressedSince),
  2,
  "so the row reads '2 more since the last entry' rather than lying by omission",
);
eq("Different keys are independent", throttle("other", w, t0 + 1000).write, true);

console.log("\n— The activity registry —\n");

ok("Every kind has a label", ACTIVITY_KINDS.every((k) => k.label.length > 0));
ok("Every kind has a description", ACTIVITY_KINDS.every((k) => k.description.length > 0), "the table's expanded row shows it");
ok("Every kind has a tone", ACTIVITY_KINDS.every((k) => SEVERITY_TONE[k.severity] !== undefined));
ok(
  "No kind is registered twice",
  new Set(ACTIVITY_KINDS.map((k) => k.key)).size === ACTIVITY_KINDS.length,
  `${ACTIVITY_KINDS.length} kinds`,
);
eq("A policy change is always critical", activityKind("SECURITY_POLICY_CHANGED").severity, "CRITICAL", "it explains why other rows stopped");
eq("So is unusual read volume", activityKind("BULK_READ").severity, "CRITICAL");
eq("A failed sign-in is a warning", activityKind("LOGIN_FAILED").severity, "WARNING");
eq("Starting a view-as is a warning", activityKind("IMPERSONATION_STARTED").severity, "WARNING");
eq("An ordinary view is not", activityKind("VIEW").severity, "INFO");
ok("An unknown kind still renders", activityKind("NOT_A_KIND" as never).label.length > 0, "rather than blanking the row");

ok("The DLP group has the clipboard kinds", kindsInGroup("DLP").includes("COPY_BLOCKED"));
ok("  and the screenshot ones", kindsInGroup("DLP").includes("SCREENSHOT_BLOCKED"));
ok("The perimeter group has blocked crawlers", kindsInGroup("PERIMETER").includes("BOT_BLOCKED"));
ok("Every kind belongs to a group", ACTIVITY_KINDS.every((k) => kindsInGroup(k.group).includes(k.key)));

eq("'At least warning' is warning and critical", severitiesAtLeast("WARNING").join(","), "WARNING,CRITICAL");
eq("'At least info' is everything", severitiesAtLeast("INFO").length, 4);
eq("'At least critical' is one", severitiesAtLeast("CRITICAL").join(","), "CRITICAL");

/**
 * What a page is allowed to ask the browser for.
 *
 * The reception kiosk needs a camera and the blanket policy denied it, so `getUserMedia` failed
 * before the page could ask and every visitor took the "camera unavailable" path — a degradation
 * meant for a broken webcam, silently becoming the only path. Nothing failed, nothing logged, and
 * the photo requirement simply stopped existing. A header that disables a feature is exactly the
 * kind of thing no test notices, so there is one.
 */
ok("The kiosk may use a camera", permissionsPolicyFor("/kiosk/abc123").includes("camera=(self)"));
ok("  including the bare prefix", permissionsPolicyFor("/kiosk").includes("camera=(self)"));
ok("The rest of the app may not", permissionsPolicyFor("/dashboard").includes("camera=()"));
ok("  nor the login page", permissionsPolicyFor("/login").includes("camera=()"));
// A prefix match, not a substring one: /kiosk-report is not the kiosk.
ok("  nor a path that merely starts with the same letters", permissionsPolicyFor("/kiosk-report").includes("camera=()"));
ok("Nothing anywhere gets a microphone", ["/kiosk/abc", "/dashboard"].every((path) => permissionsPolicyFor(path).includes("microphone=()")));
ok("  or a location", ["/kiosk/abc", "/dashboard"].every((path) => permissionsPolicyFor(path).includes("geolocation=()")));
// `*` would let any embedded frame use it; `self` is the whole point of the exception being narrow.
ok("  and the kiosk's grant is to us, not to everyone", !permissionsPolicyFor("/kiosk/abc").includes("camera=*"));

console.log(failures === 0 ? "\nAll security checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
