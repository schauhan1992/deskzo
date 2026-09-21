/**
 * The asset lifecycle rules.
 *
 * The one that matters most is ownership: a client's machine must never carry a financial record,
 * because capitalising somebody else's property overstates the balance sheet and depreciates it
 * against our own profit. Nothing here throws at the time it goes wrong — it just produces a
 * register nobody trusts — so it is checked instead.
 *
 *   npm run check:assets
 */
import type { AssetMovementType, AssetStatus } from "@prisma/client";
import {
  awayFromSite,
  canMove,
  checkOwnership,
  coverExpiringWithin,
  coverState,
  ewayBillRequired,
  EWAY_BILL_THRESHOLD,
  isPhysical,
  isSupply,
  mayBeCapitalised,
  paperworkFor,
  requiresOwnerCompany,
  statusAfter,
} from "../src/lib/assets/lifecycle";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = d("2026-09-19");

console.log("\n— Ownership —\n");

ok("Our own kit can be capitalised", mayBeCapitalised("INTERNAL"));
ok("So can kit deployed at a client", mayBeCapitalised("DEPLOYED"), "still ours, still our balance sheet");
ok(
  "A client's asset never can",
  !mayBeCapitalised("CLIENT_OWNED"),
  "capitalising it would claim property we don't own",
);
ok("Only a client-owned asset names an owner", requiresOwnerCompany("CLIENT_OWNED") && !requiresOwnerCompany("INTERNAL"));

const clientAssetCapitalised = checkOwnership({
  ownership: "CLIENT_OWNED",
  ownerCompanyId: "acme",
  fixedAssetId: "fa-1",
  siteCompanyId: "acme",
});
ok(
  "A client asset with a fixed-asset record is refused",
  clientAssetCapitalised.some((p) => p.field === "fixedAssetId"),
  clientAssetCapitalised.find((p) => p.field === "fixedAssetId")?.message,
);

const clientAssetNoOwner = checkOwnership({
  ownership: "CLIENT_OWNED",
  ownerCompanyId: null,
  fixedAssetId: null,
  siteCompanyId: null,
});
ok("A client asset with no client is refused", clientAssetNoOwner.some((p) => p.field === "ownerCompanyId"));

const oursButOwned = checkOwnership({
  ownership: "INTERNAL",
  ownerCompanyId: "acme",
  fixedAssetId: "fa-1",
  siteCompanyId: null,
});
ok(
  "Our own asset can't also belong to a company",
  oursButOwned.some((p) => p.field === "ownerCompanyId"),
  "one or the other, never both",
);

const deployedNoSite = checkOwnership({
  ownership: "DEPLOYED",
  ownerCompanyId: null,
  fixedAssetId: "fa-1",
  siteCompanyId: null,
});
ok("A deployed asset must say where it is", deployedNoSite.some((p) => p.field === "siteCompanyId"));

const cleanInternal = checkOwnership({
  ownership: "INTERNAL",
  ownerCompanyId: null,
  fixedAssetId: "fa-1",
  siteCompanyId: null,
});
ok("A normal internal asset passes", cleanInternal.length === 0);

const cleanClient = checkOwnership({
  ownership: "CLIENT_OWNED",
  ownerCompanyId: "acme",
  fixedAssetId: null,
  siteCompanyId: "acme",
});
ok("A normal client asset passes", cleanClient.length === 0);

const cleanDeployed = checkOwnership({
  ownership: "DEPLOYED",
  ownerCompanyId: null,
  fixedAssetId: "fa-1",
  siteCompanyId: "acme",
});
ok("Our kit at a client passes, and keeps its financial record", cleanDeployed.length === 0);

console.log("\n— Status follows the last movement —\n");

const transitions: [AssetMovementType, AssetStatus][] = [
  ["RECEIVED", "IN_STOCK"],
  ["ASSIGNED", "ASSIGNED"],
  ["DISPATCHED", "IN_TRANSIT"],
  ["DELIVERED", "INSTALLED"],
  ["INSTALLED", "INSTALLED"],
  ["RETURNED", "IN_STOCK"],
  ["SENT_FOR_REPAIR", "UNDER_REPAIR"],
  ["BACK_FROM_REPAIR", "IN_STOCK"],
  ["TRANSFERRED", "IN_TRANSIT"],
  ["SCRAPPED", "RETIRED"],
  ["LOST", "LOST"],
];
for (const [movement, expected] of transitions) {
  ok(`${movement} leaves it ${expected}`, statusAfter(movement) === expected, statusAfter(movement));
}
ok(
  "Every movement type has a destination status",
  transitions.length === 11,
  "so a status can never disagree with the last thing that happened",
);

console.log("\n— What may move, and when —\n");

ok("Nothing moves after it's scrapped", !canMove("RETIRED", "DISPATCHED").ok);
ok("  but it can be received back if it turns up", canMove("RETIRED", "RECEIVED").ok);
ok(
  "Something away for repair can't be dispatched to a customer",
  !canMove("UNDER_REPAIR", "DISPATCHED").ok,
  (canMove("UNDER_REPAIR", "DISPATCHED") as { reason: string }).reason,
);
ok("  but it can come back", canMove("UNDER_REPAIR", "BACK_FROM_REPAIR").ok);
ok("  or be written off where it stands", canMove("UNDER_REPAIR", "SCRAPPED").ok);
ok("Something can't come back from a repair it never went on", !canMove("IN_STOCK", "BACK_FROM_REPAIR").ok);
ok("A lost asset can be found", canMove("LOST", "RECEIVED").ok);
ok("  but not assigned while still missing", !canMove("LOST", "ASSIGNED").ok);
ok("Ordinary moves are allowed", canMove("IN_STOCK", "ASSIGNED").ok && canMove("ASSIGNED", "RETURNED").ok);

console.log("\n— Cover —\n");

const live = coverState({ warrantyEndsOn: d("2027-01-01"), amcEndsOn: null }, NOW);
ok("A live warranty reads as covered", live.key === "WARRANTY" && live.tone === "green", live.label);

const amcOnly = coverState({ warrantyEndsOn: d("2025-01-01"), amcEndsOn: d("2027-03-31") }, NOW);
ok(
  "An expired warranty with a live AMC is still covered",
  amcOnly.key === "AMC",
  "the practical question is whether somebody else pays, and they do",
);

const both = coverState({ warrantyEndsOn: d("2027-01-01"), amcEndsOn: d("2027-06-30") }, NOW);
ok("Both live reads as both", both.key === "BOTH", both.label);
ok("  and counts to whichever lasts longer", both.daysLeft === 284, both.daysLeft);

const lapsed = coverState({ warrantyEndsOn: d("2025-01-01"), amcEndsOn: d("2026-01-01") }, NOW);
ok("Everything lapsed reads as expired", lapsed.key === "EXPIRED" && lapsed.tone === "red", lapsed.label);

const never = coverState({ warrantyEndsOn: null, amcEndsOn: null }, NOW);
ok(
  "No cover recorded is not the same as expired",
  never.key === "NONE",
  "one needs chasing, the other needs entering",
);

const expiringSoon = coverState({ warrantyEndsOn: d("2026-10-01"), amcEndsOn: null }, NOW);
ok("Cover running out soon is still live", expiringSoon.key === "WARRANTY" && expiringSoon.daysLeft === 12, expiringSoon.daysLeft);

const estate = [
  { id: "a", warrantyEndsOn: d("2026-10-05"), amcEndsOn: null },
  { id: "b", warrantyEndsOn: d("2028-01-01"), amcEndsOn: null },
  { id: "c", warrantyEndsOn: d("2025-01-01"), amcEndsOn: null },
  { id: "d", warrantyEndsOn: null, amcEndsOn: null },
];
const due = coverExpiringWithin(estate, 30, NOW);
ok("Cover expiring inside 30 days is picked up", due.some((a) => a.id === "a"), `${due.length} asset(s)`);
ok("  and so is cover that already lapsed", due.some((a) => a.id === "c"), "expired is more urgent, not less");
ok("  cover with years left is not", !due.some((a) => a.id === "b"));
ok("  and nor is an asset with no dates at all", !due.some((a) => a.id === "d"), "nothing to renew");

console.log("\n— Paperwork —\n");

ok("A sale moves on a tax invoice", isSupply("SALE_DELIVERY") && paperworkFor("SALE_DELIVERY") === "TAX_INVOICE");
ok(
  "A repair does not",
  !isSupply("REPAIR_OUT") && paperworkFor("REPAIR_OUT") === "DELIVERY_CHALLAN",
  "invoicing it would book revenue that doesn't exist",
);
ok("Nor does deploying our own kit", paperworkFor("DEPLOYMENT") === "DELIVERY_CHALLAN");
ok("Nor does moving between our own sites", paperworkFor("INTERNAL_TRANSFER") === "DELIVERY_CHALLAN");
ok("Nor does collecting from a client", paperworkFor("COLLECTION") === "DELIVERY_CHALLAN");

console.log("\n— E-way bill —\n");

const cheap = ewayBillRequired({ declaredValue: 45000, interstate: true, reason: "SALE_DELIVERY" });
ok("Below the threshold, no bill", !cheap.required, cheap.reason);

const dear = ewayBillRequired({ declaredValue: 250000, interstate: true, reason: "SALE_DELIVERY" });
ok("Above it on a sale, a bill", dear.required, dear.reason);

// The one people get wrong: the threshold is about the goods moving, not about a sale.
const repairs = ewayBillRequired({ declaredValue: 900000, interstate: false, reason: "REPAIR_OUT" });
ok(
  "Laptops going out for repair need one too",
  repairs.required,
  "₹9 lakh of goods are moving even though nothing is sold",
);
ok("  and it says why", repairs.reason.includes("not the sale"), repairs.reason);

const transfer = ewayBillRequired({ declaredValue: 600000, interstate: true, reason: "INTERNAL_TRANSFER" });
ok("So does moving our own kit between offices", transfer.required);

const exactly = ewayBillRequired({ declaredValue: EWAY_BILL_THRESHOLD, interstate: true, reason: "SALE_DELIVERY" });
ok("Exactly at the threshold, no bill", !exactly.required, "the rule is 'exceeding ₹50,000'");

const unknown = ewayBillRequired({ declaredValue: null, interstate: true, reason: "SALE_DELIVERY" });
ok("Without a value it says so rather than guessing", !unknown.required, unknown.reason);

console.log("\n— A client's estate —\n");

// The client whose page we are on, and somewhere else entirely.
const ACME = "acme";
const OTHER = "other";
const from = (companyId: string | null) => ({ fromCompanyId: companyId });

// `movements` arrives newest-first, so [0] is the last thing that happened to the machine.
const onSite = { id: "on-site", movements: [from(null)] };
const atRepair = { id: "at-repair", movements: [from(ACME)] };
const passedThrough = { id: "passed-through", movements: [from(OTHER), from(ACME)] };
const neverHere = { id: "never-here", movements: [from(OTHER)] };

const away = awayFromSite({
  candidates: [onSite, atRepair, passedThrough, neverHere],
  companyId: ACME,
  stillHere: [{ id: onSite.id }],
});
const ids = away.map((a) => a.id);

ok("A machine sent away from their site is still theirs to ask about", ids.includes("at-repair"), ids.join(", "));
ok(
  "A machine that only passed through once isn't",
  !ids.includes("passed-through"),
  "the latest movement decides where something is, not any movement",
);
ok("Nor is one that was never there", !ids.includes("never-here"));
ok(
  "And nothing still standing at their site counts as away",
  !ids.includes("on-site"),
  "it is already on the estate, and would otherwise be listed twice",
);
ok("So exactly one is away", away.length === 1, `${away.length}`);

// Nothing with no history at all may fall through into the away list.
const noHistory = awayFromSite({
  candidates: [{ id: "fresh", movements: [] as { fromCompanyId: string | null }[] }],
  companyId: ACME,
  stillHere: [],
});
ok("An asset that has never moved is not away", noHistory.length === 0, "there is no movement to read");

console.log("\n— Licences —\n");

ok("A laptop is physical", isPhysical("LAPTOP"));
ok("A licence is not", !isPhysical("SOFTWARE_LICENCE"), "so sites and movements are meaningless for it");

console.log(failures === 0 ? "\nAll asset checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
