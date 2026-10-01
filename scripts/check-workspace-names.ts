/**
 * Checks what a new workspace may be called (src/lib/workspace-names.ts, slugProblem in
 * src/lib/platform/provisioning.ts, the reserved subdomains in src/lib/tenancy/host.ts).
 *
 * Owner decisions, 1 Oct 2026: a business signing itself up gets an address of at least eight letters
 * or digits, made from its registered business name; nobody gets one of the platform's own words, our
 * name or a competitor's.
 *
 *   npm run check:workspace-names
 *
 * Reads the control plane (existing workspaces); writes nothing.
 */
import { MIN_SIGNUP_NAME, legalNameWords, protectedNameIn, signupNameProblem, suggestedName } from "../src/lib/workspace-names";
import { RESERVED_SLUGS, SLUG_PATTERN, classifyHost } from "../src/lib/tenancy/host";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const allowed = (slug: string, legal: string) => signupNameProblem(slug, legal) === null;

async function main() {
  console.log("\n— Made from the registered business name —");
  const acme = "Acme Technologies Pvt. Ltd.";
  for (const slug of ["acmetechnologies", "acme-technologies", "acmetech", "acme-tech", "technologies", "acmetechnologiespvt"]) ok(`"${slug}" from "${acme}"`, allowed(slug, acme), signupNameProblem(slug, acme));
  for (const slug of ["techacme", "acmetechltd", "ac-metech", "pvtltdacme", "bestcrmsoftware", "acmetechnologies-india"]) ok(`  "${slug}" refused`, !allowed(slug, acme));
  ok("  the refusal names an address that would do", (signupNameProblem("techacme", acme) ?? "").includes("acmetechnologies"));
  ok("an ampersand may be read as \"and\" or as nothing", allowed("smithandsons", "Smith & Sons Traders LLP") && allowed("smithsons", "Smith & Sons Traders LLP"));
  ok("accents are dropped", allowed("cafedelmar", "Café Del Mar Hospitality Pvt Ltd"));
  ok("\"M/s\" can't start one; the name after it can", !allowed("msshreeganesh", "M/s Shree Ganesh Enterprises") && allowed("shreeganesh", "M/s Shree Ganesh Enterprises"));
  ok("\"The\" may start one", allowed("theindianhotels", "The Indian Hotels Company Limited") && allowed("indianhotels", "The Indian Hotels Company Limited"));
  ok("a word inside the name may start one, but not a company-kind word", allowed("sonstraders", "Smith & Sons Traders LLP") && !allowed("limitedabc", "Abc Limited Partners Ltd") );
  ok("legalNameWords splits on anything that isn't a letter or digit", JSON.stringify(legalNameWords("A.B.C. (India) Pvt. Ltd.")[0]) === JSON.stringify(["a", "b", "c", "india", "pvt", "ltd"]));

  console.log("\n— At least eight letters or digits —");
  ok(`MIN_SIGNUP_NAME is ${MIN_SIGNUP_NAME}`, MIN_SIGNUP_NAME === 8);
  ok("eight is enough", allowed("acmetech", acme));
  ok("seven is not", signupNameProblem("acmetec", acme) === `Use at least ${MIN_SIGNUP_NAME} letters or digits.`, signupNameProblem("acmetec", acme));
  ok("hyphens don't count towards the eight", !allowed("acme-te-c", acme) && signupNameProblem("ac-me", "Ac Me Industries") === `Use at least ${MIN_SIGNUP_NAME} letters or digits.`);
  ok("a registered name too short for any address says to contact us", (signupNameProblem("acmeltd", "Acme Ltd") ?? "").startsWith("Your registered business name is too short"));
  ok("no registered name: asked for first", (signupNameProblem("acmetechnologies", "") ?? "").startsWith("Give your registered business name"));

  console.log("\n— The form's suggestion —");
  ok("the name without what kind of company it is", suggestedName(acme) === "acmetechnologies", suggestedName(acme));
  ok("  without a leading \"The\"", suggestedName("The Indian Hotels Company Limited") === "indianhotels", suggestedName("The Indian Hotels Company Limited"));
  ok("  with the rest when that alone is too short", suggestedName("Acme Ltd") === "acmeltd" && suggestedName("Kite Pvt Ltd") === "kitepvtltd", `${suggestedName("Acme Ltd")} ${suggestedName("Kite Pvt Ltd")}`);
  ok("  never more than 40 characters, and always one the rules allow", suggestedName("Ab".repeat(30) + " Holdings") .length <= 40 && allowed(suggestedName(acme), acme) && allowed(suggestedName("Smith & Sons Traders LLP"), "Smith & Sons Traders LLP"));

  console.log("\n— Our name and competitors' —");
  for (const slug of ["deskzo-support", "mydeskzo", "deskzoone", "wroffy-crm", "zoho-india", "zohoindia", "tallysolutions", "odoo-partners", "salesforce", "hubspot-agency"]) ok(`"${slug}" is protected`, protectedNameIn(slug) !== null);
  for (const slug of ["digitallyyours", "acmetechnologies", "totallyfresh", "zohra-textiles"]) ok(`  "${slug}" isn't`, protectedNameIn(slug) === null, protectedNameIn(slug));

  console.log("\n— Reserved subdomains —");
  for (const word of ["official", "books", "crm", "helpdesk", "desk", "accounting", "payroll", "support", "security", "verify", "one", "erp", "status", "partners"]) ok(`"${word}" is reserved`, RESERVED_SLUGS.has(word));
  ok("every reserved word is itself a valid address shape (or it would be refused anyway)", [...RESERVED_SLUGS].every((w) => SLUG_PATTERN.test(w) || w.length < 3));
  ok("a reserved word is never served as a workspace", classifyHost(`books.${process.env.PLATFORM_DOMAIN ?? "localhost"}${process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : ""}`).kind === "invalid");

  console.log("\n— Every path that makes a workspace (slugProblem) —");
  const { slugProblem } = await import("../src/lib/platform/provisioning");
  ok("a reserved word: refused", (await slugProblem("helpdesk")) === "That name is reserved.");
  ok("our name inside one: refused", (await slugProblem("deskzo-support")) === "That name is reserved.");
  ok("a competitor's: refused", (await slugProblem("zoho-india")) === "That name is reserved.");
  ok("the shape: refused in its own words", ((await slugProblem("-bad-")) ?? "").startsWith("Use 3–40"));
  ok("a free, ordinary name: allowed (staff aren't held to the signup rules)", (await slugProblem("zzwsn-ok")) === null);

  const { controlDb, controlConfigured } = await import("../src/lib/platform/control-db");
  if (controlConfigured()) {
    const existing = await controlDb().tenant.findMany({ select: { slug: true, isDefault: true } });
    const clash = existing.filter((t) => RESERVED_SLUGS.has(t.slug));
    ok("no existing workspace's address is now reserved — it would stop being served", clash.length === 0, clash.map((t) => t.slug).join(", "));
    const protectedOnes = existing.filter((t) => !t.isDefault && protectedNameIn(t.slug));
    ok("  and none but the platform's own carries our name or a competitor's", protectedOnes.length === 0, protectedOnes.map((t) => t.slug).join(", "));
  }

  console.log(failures === 0 ? "\nAll workspace-name checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
