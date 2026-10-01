/**
 * The bits every part of the demo seed needs.
 *
 * ## Why the randomness is seeded
 *
 * A demo database that comes out different every run is one nobody can talk about: "the Northwind
 * order" stops meaning anything, and a screenshot taken on Monday does not match the screen on
 * Tuesday. The PRNG below is deterministic, so the same run produces the same company every time.
 *
 * ## Why everything is tagged
 *
 * `DEMO_TAG` goes on every company and `DEMO_SKU` on every catalogue item, which is what makes
 * `--reset` able to remove exactly what a previous run added and nothing else. A seed that cannot
 * be undone is one people are afraid to run.
 */

export const DEMO_TAG = "seed-demo";
export const DEMO_SKU = "DMO-";
export const DEMO_EMAIL_DOMAIN = "@demo.deskzo.invalid";

export const TODAY = new Date();

/**
 * How long this company has been running, and so how far back anything can have happened.
 *
 * The single lever for the dataset's age. Every date in every demo module goes through `daysAgo`
 * below — there is no raw arithmetic on `TODAY` anywhere else — so clamping it here shortens the
 * whole history at once rather than needing twenty ranges adjusted in step.
 *
 * ## The one thing that is deliberately older than the company
 *
 * Subscription terms. Their start date is worked back from the *expiry* (see `activity.ts`), so a
 * subscription can begin before the company existed — and it should. A reseller onboarding a
 * customer takes over the tenancies they are already running, part-way through their term. That is
 * also what keeps the renewals screen worth looking at: clamp those too and every expiry lands more
 * than eight months out, so the 30/60/90-day windows are empty and the module cannot be tested.
 */
export const COMPANY_AGE_DAYS = 120;

/** The day the company opened. */
export const FOUNDED = new Date(TODAY.getTime() - COMPANY_AGE_DAYS * 86400000);

/** How many people are on the payroll. The roster in `people.ts` scales itself to this. */
export const HEADCOUNT = 50;

/**
 * How many accounts are on the books.
 *
 * Tied to the headcount rather than fixed, because the two move together: a book is only as big as
 * the people working it. Four accounts a head is a young company's ratio — enough that every list,
 * filter and report has something to show, and not so many that a four-month-old firm looks like it
 * has been trading for a decade.
 */
export const BOOK_SIZE = HEADCOUNT * 4;

let seed = 20260920;
export function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
export const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
export const int = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;
export const chance = (p: number) => rnd() < p;
/**
 * Clamped to the company's own lifetime, so nothing is dated before it existed.
 *
 * Every module asks for a spread in days — `daysAgo(int(0, 365))` and the like — and those ranges
 * were written for a year-old business. Rather than rewrite twenty of them, the floor is applied
 * here: ask for 300 days ago on a 120-day-old company and you get its founding day.
 *
 * `daysAhead` is deliberately NOT clamped. The future is not constrained by how long the company
 * has been trading, and the renewals, targets and expiry screens all live there.
 */
export const daysAgo = (n: number) => new Date(TODAY.getTime() - Math.min(n, COMPANY_AGE_DAYS) * 86400000);
export const daysAhead = (n: number) => new Date(TODAY.getTime() + n * 86400000);

/**
 * A moment somewhere in the company's life, weighted towards recent.
 *
 * A flat spread looks wrong: a business has more of everything in its last quarter than its first,
 * because it grew. Squaring the random number bends the curve that way.
 *
 * Spread across `COMPANY_AGE_DAYS` rather than a flat year, so a young company's activity is dense
 * over a short history instead of four fifths of it piling onto the founding day — which is what a
 * clamped year-long spread would have produced.
 */
export function sometimeLastYear(): Date {
  const r = rnd();
  return daysAgo(Math.floor(r * r * COMPANY_AGE_DAYS));
}

/** Business hours on a weekday — nothing in this dataset should be timestamped 3am on a Sunday. */
export function duringWorkHours(day: Date): Date {
  const out = new Date(day);
  // Nudge weekends to the Friday before, the way real activity clusters.
  const dow = out.getDay();
  if (dow === 0) out.setDate(out.getDate() - 2);
  if (dow === 6) out.setDate(out.getDate() - 1);
  out.setHours(int(9, 18), int(0, 59), int(0, 59), 0);
  return out;
}

export const some = <T,>(arr: readonly T[], n: number): T[] => {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]!);
  return out;
};

// ── Names ───────────────────────────────────────────────────────────────────────────────────────

export const FIRST_NAMES = [
  "Aarav", "Aditi", "Akash", "Ananya", "Arjun", "Bhavna", "Chirag", "Deepa", "Dhruv", "Divya",
  "Farhan", "Gaurav", "Harsh", "Ishaan", "Jyoti", "Kabir", "Kavya", "Kiran", "Lakshmi", "Manish",
  "Meera", "Mohit", "Neha", "Nikhil", "Nisha", "Omkar", "Pooja", "Pranav", "Priya", "Rahul",
  "Rakesh", "Ravi", "Riya", "Rohan", "Sanjay", "Shalini", "Shreya", "Siddharth", "Sneha", "Sunil",
  "Swati", "Tanvi", "Tarun", "Uday", "Varun", "Vikram", "Vinay", "Vishal", "Yash", "Zoya",
];

export const LAST_NAMES = [
  "Agarwal", "Bhat", "Chauhan", "Desai", "Dutta", "Gupta", "Iyer", "Jain", "Joshi", "Kapoor",
  "Khanna", "Kulkarni", "Kumar", "Malhotra", "Mehta", "Menon", "Mishra", "Nair", "Pandey", "Patel",
  "Pillai", "Rao", "Reddy", "Saxena", "Sharma", "Shetty", "Singh", "Sinha", "Thakur", "Verma",
];

export function personName(): string {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

/** A work address from a name, made unique by a counter the caller keeps. */
export function workEmail(name: string, n: number): string {
  const [first, last] = name.toLowerCase().split(" ");
  return `${first}.${last}${n}${DEMO_EMAIL_DOMAIN}`;
}

export function phone(): string {
  return `+91 9${int(1000, 9999)}${int(10000, 99999)}`;
}

// ── Places ──────────────────────────────────────────────────────────────────────────────────────

export const CITIES: [city: string, state: string, stateCode: string, pinPrefix: string][] = [
  ["Mumbai", "Maharashtra", "27", "4000"],
  ["Pune", "Maharashtra", "27", "4110"],
  ["Bengaluru", "Karnataka", "29", "5600"],
  ["Hyderabad", "Telangana", "36", "5000"],
  ["Chennai", "Tamil Nadu", "33", "6000"],
  ["Delhi", "Delhi", "07", "1100"],
  ["Gurugram", "Haryana", "06", "1220"],
  ["Noida", "Uttar Pradesh", "09", "2013"],
  ["Ahmedabad", "Gujarat", "24", "3800"],
  ["Kolkata", "West Bengal", "19", "7000"],
  ["Jaipur", "Rajasthan", "08", "3020"],
  ["Indore", "Madhya Pradesh", "23", "4520"],
  ["Kochi", "Kerala", "32", "6820"],
  ["Chandigarh", "Punjab", "04", "1600"],
  ["Lucknow", "Uttar Pradesh", "09", "2260"],
];

/** A GSTIN that is the right shape for its state — not a real one, and the checksum is not real. */
export function gstin(stateCode: string): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const pan =
    Array.from({ length: 5 }, () => letters[int(0, 25)]).join("") +
    String(int(1000, 9999)) +
    letters[int(0, 25)];
  return `${stateCode}${pan}1Z${letters[int(0, 25)]}`;
}

export const COMPANY_PREFIXES = [
  "Acme", "Aurora", "Brightwave", "Cobalt", "Crestline", "Deccan", "Eastgate", "Evergreen",
  "Falcon", "Ganges", "Granite", "Harbour", "Horizon", "Indus", "Ironclad", "Juniper", "Kaveri",
  "Kinetic", "Lumen", "Meridian", "Narmada", "Nimbus", "Orbit", "Pinnacle", "Quantum", "Redwood",
  "Sahyadri", "Sapphire", "Silverline", "Summit", "Trident", "Vertex", "Vindhya", "Westfield",
  "Yamuna", "Zenith", "Blueridge", "Copperfield", "Dovetail", "Emberline",
];
export const COMPANY_MIDS = [
  "Technologies", "Systems", "Industries", "Logistics", "Retail", "Healthcare", "Infra", "Digital",
  "Foods", "Textiles", "Motors", "Pharma", "Chemicals", "Engineering", "Realty", "Financial",
];
export const COMPANY_SUFFIXES = ["Pvt Ltd", "India Pvt Ltd", "Enterprises", "LLP", "Solutions Pvt Ltd", "& Co"];

export const INDUSTRIES = [
  "Manufacturing", "IT Services", "Healthcare", "Education", "Retail", "Logistics", "BFSI",
  "Pharmaceuticals", "Real Estate", "Hospitality", "Media", "Automotive", "Textiles", "Chemicals",
];

/**
 * The app's own rule for `Company.normalizedName`, re-exported rather than reimplemented.
 *
 * This used to be a second copy that also stripped punctuation, and the two disagreed: the seed
 * stored "acme digital co" where the application computes "acme digital & co". Every demo company
 * with an ampersand in its name was then invisible to the duplicate check, to search and to the
 * importer, which quietly created a second copy of each one. A seed that writes a derived column
 * by its own rule writes a value the app can never find.
 */
export { normalizeCompanyName as normalise } from "../../src/lib/validation/company";

/** A slug for the made-up websites and addresses below. Not a key — nothing is matched on it. */
export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function log(step: string, detail: string) {
  console.log(`  ${step.padEnd(26)} ${detail}`);
}
