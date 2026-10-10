/**
 * What a new workspace may be called — its address, `<name>.<PLATFORM_DOMAIN>`. Pure: the signup
 * form's live hint, the signup action, provisioning, the console and the checks share it. Client-safe
 * too, so it stays out of src/lib/platform and src/lib/tenancy (check:tenancy); the database's part —
 * staff's rules, holds, names taken — is read by src/lib/platform/name-rules.ts and passed in.
 *
 * Every new workspace, whoever makes it — signup, staff, a script (`slugProblem` in provisioning.ts),
 * in this order (`nameVerdict`):
 *   1. the address pattern;
 *   2. never one of the platform's own addresses (`PLATFORM_HOSTS`): locked, nothing lets one through;
 *   3. never a name staff have blocked — exactly that name, or any name with a blocked word in it;
 *   4. never a built-in reserved word (`RESERVED_WORDS`), and never one carrying our name or a
 *      competitor's, so no workspace can pass itself off as either: our names anywhere in it
 *      ("deskzo-support"), a competitor's as a whole word of it ("zoho-india", "tallysolutions") — not
 *      inside another word, so "digitallyyours" is fine. Staff may release any of these words;
 *   5. never a name an open invitation holds for its customer, nor one a workspace already has.
 *
 * An invitation may hold an address for the customer it is for (owner decision, 1 Oct 2026): that
 * customer's signup gets exactly it, and nobody else may take it while the invitation is open. When
 * an owner or admin said so, the held address may be a reserved word or a blocked name — steps 3 and
 * 4 are skipped for it; 1, 2 and 5 never are.
 *
 * A business signing itself up, as well (owner decisions, 1 Oct 2026) — unless its invitation holds
 * its address:
 *   · at least eight letters or digits;
 *   · made from its registered business name: the name's letters in order, starting at one of its
 *     words and running on without skipping — for "Acme Technologies Pvt Ltd": acmetechnologies,
 *     acme-technologies, acmetech, technologies; never techacme, acme-tech-ltd-india or bestcrm. A
 *     hyphen may only stand where the name has a break between words. It may not start on "Pvt",
 *     "Ltd" or another word that only says what kind of company it is.
 *
 * A name the signup rules refuse can still be given by staff, who set up workspaces outside signup.
 * Whatever refused it, a customer reads only "That name is reserved." — never which rule, never
 * staff's reasons.
 */

export const MIN_SIGNUP_NAME = 8;

/** A workspace name: lower-case letters, digits and hyphens, 3–40, not starting or ending with a hyphen. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * The platform's own addresses: what it answers on itself, or will — its hosts and infrastructure,
 * mail, its environments, sign-in and its legal pages. Locked: never a workspace's, whatever staff
 * decide — no release, no hold. src/lib/tenancy/host.ts refuses to serve a workspace on any of them
 * (`classifyHost`); the list is written here, with the other name lists, so the rules below can read
 * it and stay client-safe.
 *
 * Never "deskzo", nor any workspace's address: the platform's own first workspace is called that, and
 * adoption (scripts/platform-adopt.ts) refuses a default workspace named by one of these.
 */
export const PLATFORM_HOSTS: ReadonlySet<string> = new Set([
  "www", "admin", "api", "app", "apps", "auth", "billing", "console", "dashboard", "devices", "docs", "help",
  "mail", "smtp", "imap", "pop", "pop3", "mx", "ns", "ns1", "ns2", "dns", "ftp", "sftp", "vpn", "status", "support",
  "autodiscover", "autoconfig", "mta-sts",
  "static", "cdn", "assets", "files", "uploads", "media", "images", "img", "download", "downloads",
  "login", "logout", "signin", "signout", "signup", "register", "account", "accounts", "platform", "system", "root",
  "test", "testing", "dev", "developer", "developers", "sandbox", "staging", "demo", "beta", "alpha", "preview",
  "cms", "partners", "partner", "portal", "my", "id", "identity", "oauth", "sso", "password", "reset", "verify",
  "verification", "secure", "security", "trust", "privacy", "legal", "terms",
  "abuse", "postmaster", "hostmaster", "webmaster", "noreply", "no-reply",
  "null", "undefined", "default", "example",
]);

/**
 * Words reserved for the platform, which staff may release (a `RELEASE` rule) — a customer could
 * then have one: staff set it up, or an invitation holds it. In two groups, for the console.
 */
export const RESERVED_WORD_GROUPS = [
  {
    key: "official",
    label: "Sound official, or like the platform's own pages",
    words: [
      "official", "officials", "staff", "team", "internal", "corp", "corporate", "owner", "administrator", "sysadmin", "superadmin",
      "home", "about", "pricing", "contact", "careers", "jobs", "press", "events", "blog", "news", "shop", "store",
      "community", "forum", "learn", "academy", "training", "webinar", "webinars", "updates", "changelog", "roadmap",
      "feedback", "uptime", "compliance", "gdpr", "reseller", "resellers", "affiliate", "affiliates", "me",
      "info", "hello", "sales", "enquiry", "enquiries", "care", "service", "services",
      "helpcenter", "helpcentre", "knowledgebase", "kb",
    ],
  },
  {
    key: "products",
    label: "Products the platform has, or may sell on their own",
    words: [
      "one", "suite", "erp", "crm", "books", "accounting", "finance", "invoice", "invoices", "invoicing", "payments",
      "pay", "payroll", "people", "hr", "hrms", "recruit", "hiring", "expense", "expenses", "inventory", "stock",
      "orders", "purchase", "procurement", "projects", "tasks", "desk", "helpdesk", "servicedesk", "tickets",
      "ticketing", "marketing", "campaigns", "mailer", "survey", "surveys", "forms", "analytics", "reports",
      "insights", "vault", "cards", "signatures", "sign", "esign", "drive", "workdrive", "chat", "meet", "connect", "workplace",
      "office", "commerce", "pos", "gst", "einvoice", "ewaybill", "copilot", "ai", "assistant",
    ],
  },
] as const satisfies readonly { key: string; label: string; words: readonly string[] }[];

/** Every reserved word, as one set. A whole address only: "books" is refused, "acmebooks" is not. */
export const RESERVED_WORDS: ReadonlySet<string> = new Set(RESERVED_WORD_GROUPS.flatMap((g) => g.words));

/** Ours: refused anywhere in an address. Distinctive enough never to sit inside an ordinary word. */
export const OUR_NAMES = ["deskzo"] as const;

/** Competitors': refused as a word of the address (between hyphens, or how it starts). */
export const COMPETITOR_NAMES = ["zoho", "tally", "odoo", "salesforce", "hubspot", "freshworks", "freshdesk", "freshsales", "pipedrive", "netsuite", "quickbooks"] as const;

/** Words that say what kind of company it is, not which: an address can't start on one. */
const COMPANY_KIND_WORDS = new Set([
  "private", "pvt", "pvtltd", "limited", "ltd", "llp", "llc", "inc", "incorporated", "corp", "corporation", "co", "company",
  "plc", "gmbh", "ag", "sa", "bv", "pte", "sdn", "bhd", "opc", "pty", "the", "and", "of", "m", "s",
]);

/** The words of a registered name — accents dropped, "&" read as "and" or as nothing (both are tried). */
export function legalNameWords(legalName: string): string[][] {
  const base = String(legalName ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const words = (text: string) => text.replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const withAnd = words(base.replace(/&/g, " and "));
  const without = words(base.replace(/&/g, ""));
  return withAnd.join(" ") === without.join(" ") ? [withAnd] : [withAnd, without];
}

/** Whether `slug` is the name's letters in order from the start of one of its (meaningful) words. */
function builtFrom(slug: string, words: string[]): boolean {
  const parts = slug.split("-");
  const letters = parts.join("");
  const joined = words.join("");
  // Where each word starts in the run of letters — the only places a hyphen, or the address, may start.
  const starts: number[] = [];
  let at = 0;
  for (const w of words) {
    starts.push(at);
    at += w.length;
  }
  const breaks = new Set([...starts, joined.length]);
  return words.some((word, i) => {
    // "The" may start one (theindianhotels); what kind of company it is may not (pvtltd…).
    if (COMPANY_KIND_WORDS.has(word) && word !== "the") return false;
    const from = starts[i]!;
    if (!joined.startsWith(letters, from)) return false;
    let cut = from;
    for (const part of parts.slice(0, -1)) {
      cut += part.length;
      if (!breaks.has(cut)) return false;
    }
    return true;
  });
}

/** Our name, or a competitor's, carried by an address; null when it carries neither. Staff's releases aside. */
export function protectedNameIn(slug: string): string | null {
  return builtInWordsIn(slug.toLowerCase()).find((m) => m.rule !== "reserved")?.word ?? null;
}

/** Which built-in group a word is in — one staff may release — or null. */
export type BuiltInGroup = "reserved" | "ours" | "competitor";

/**
 * Every built-in word an address runs into, in the order they are judged: a reserved word (the
 * whole address), then our names (anywhere in it, hyphens ignored), then competitors' (a word of it,
 * or how it starts).
 */
export function builtInWordsIn(slug: string): { rule: BuiltInGroup; word: string }[] {
  const letters = slug.replace(/-/g, "");
  const parts = slug.split("-");
  return [
    ...(RESERVED_WORDS.has(slug) ? [{ rule: "reserved" as const, word: slug }] : []),
    ...OUR_NAMES.filter((n) => letters.includes(n)).map((word) => ({ rule: "ours" as const, word })),
    ...COMPETITOR_NAMES.filter((n) => parts.includes(n) || slug.startsWith(n)).map((word) => ({ rule: "competitor" as const, word })),
  ];
}

/** The built-in group a word belongs to, when staff could release it; null for anything else. */
export function releasableGroupOf(word: string): BuiltInGroup | null {
  if (RESERVED_WORDS.has(word)) return "reserved";
  if ((OUR_NAMES as readonly string[]).includes(word)) return "ours";
  if ((COMPETITOR_NAMES as readonly string[]).includes(word)) return "competitor";
  return null;
}

/** An address made from the registered name, for the form to offer: its words, as many as fit in 40. */
export function suggestedName(legalName: string): string {
  const words = legalNameWords(legalName)[0]!;
  const firstReal = words.findIndex((w) => !COMPANY_KIND_WORDS.has(w));
  if (firstReal < 0) return "";
  const meaningful = words.slice(firstReal);
  // The name without what kind of company it is ("Acme Technologies", not "… Pvt Ltd") — unless that
  // is too short to be an address, when the rest is kept.
  let end = meaningful.length;
  while (end > 1 && COMPANY_KIND_WORDS.has(meaningful[end - 1]!)) end -= 1;
  const core = meaningful.slice(0, end).join("");
  const name = core.length >= MIN_SIGNUP_NAME ? core : meaningful.join("");
  return name.slice(0, 40).replace(/-+$/, "");
}

/**
 * Why a business signing itself up can't have this address, in words for the form; null when it
 * can. Run after the general checks (pattern, reserved, taken) — this is only what signup adds.
 */
export function signupNameProblem(slug: string, legalName: string): string | null {
  const s = slug.trim().toLowerCase();
  const letters = s.replace(/-/g, "");
  const variants = legalNameWords(legalName);
  if (!variants[0]!.length) return "Give your registered business name first — your address is made from it.";
  const tooShort = `Your registered business name is too short for an address of ${MIN_SIGNUP_NAME} letters. Contact us and we'll set your workspace up.`;
  // However it is cut, the name gives fewer than eight letters: nothing typed could pass.
  if (Math.max(...variants.map((w) => w.join("").length)) < MIN_SIGNUP_NAME) return tooShort;
  if (letters.length < MIN_SIGNUP_NAME) return `Use at least ${MIN_SIGNUP_NAME} letters or digits.`;
  if (variants.some((words) => builtFrom(s, words))) return null;
  const example = suggestedName(legalName);
  return example.replace(/-/g, "").length >= MIN_SIGNUP_NAME ? `Your address must come from your registered business name, in order — for example ${example}.` : tooShort;
}

// ─── Staff's rules, holds, and the whole verdict ─────────────────────────────────────────────────

/** What a staff rule does (the control plane's `NameRuleKind`). */
export type NameRuleKind = "BLOCK_EXACT" | "BLOCK_WORD" | "RELEASE";

/** A staff rule as the verdict needs it: lower case; a name for BLOCK_EXACT, a word for the others. */
export type NameRule = { kind: NameRuleKind; value: string };

/** An address an invitation holds for its customer; `skipsReserved`: it may be reserved or blocked. */
export type NameHold = { slug: string; skipsReserved: boolean };

/** What the database knows about a name, passed in — this file never reads it. */
export type NameFacts = {
  /** Staff's rules, all of them (src/lib/platform/name-rules.ts). None: the built-in rules alone. */
  rules?: readonly NameRule[];
  /** The hold the one asking presents — their invitation's. It counts for its own address only. */
  hold?: NameHold | null;
  /** Another open invitation holds this name. */
  heldElsewhere?: boolean;
  /** A workspace has this name already. */
  taken?: boolean;
};

export const NAME_PATTERN_MESSAGE = "Use 3–40 lower-case letters, digits and hyphens, not starting or ending with a hyphen.";
/** What a customer reads for every reserved, blocked or protected name — whichever rule it was. */
export const NAME_RESERVED = "That name is reserved.";
/** …and for a name a workspace has, or an open invitation holds for somebody else. */
export const NAME_TAKEN = "That name is taken.";

/** Which step refused a name. */
export type NameRefusalRule = "pattern" | "platform" | "blocked-exact" | "blocked-word" | "reserved" | "ours" | "competitor" | "held" | "taken";

export type NameVerdict =
  /** `held`: allowed as the hold presented; `released`: built-in words that staff's releases let through. */
  | { ok: true; held: boolean; released: string[] }
  /** `word`: the word or name that decided it, for staff — never shown to a customer. */
  | { ok: false; rule: NameRefusalRule; word: string | null; message: string };

/**
 * Whether a workspace may have this exact address, and which rule decided — in the order at the top
 * of this file. `slug` is judged as given: callers trim and lower-case what a person typed.
 */
export function nameVerdict(slug: string, facts: NameFacts = {}): NameVerdict {
  const refuse = (rule: NameRefusalRule, word: string | null, message = NAME_RESERVED): NameVerdict => ({ ok: false, rule, word, message });
  if (!SLUG_PATTERN.test(slug)) return refuse("pattern", null, NAME_PATTERN_MESSAGE);
  if (PLATFORM_HOSTS.has(slug)) return refuse("platform", slug);
  const rules = facts.rules ?? [];
  const hold = facts.hold && facts.hold.slug === slug ? facts.hold : null;
  const released: string[] = [];
  if (!hold?.skipsReserved) {
    if (rules.some((r) => r.kind === "BLOCK_EXACT" && r.value === slug)) return refuse("blocked-exact", slug);
    const letters = slug.replace(/-/g, "");
    const word = rules.find((r) => r.kind === "BLOCK_WORD" && letters.includes(r.value));
    if (word) return refuse("blocked-word", word.value);
    const releases = new Set(rules.filter((r) => r.kind === "RELEASE").map((r) => r.value));
    for (const match of builtInWordsIn(slug)) {
      if (!releases.has(match.word)) return refuse(match.rule, match.word);
      released.push(match.word);
    }
  }
  if (facts.heldElsewhere) return refuse("held", null, NAME_TAKEN);
  if (facts.taken) return refuse("taken", null, NAME_TAKEN);
  return { ok: true, held: !!hold, released };
}

/** Why a workspace can't have this address, in a customer's words; null when it can. */
export function nameRefusal(slug: string, facts: NameFacts = {}): string | null {
  const verdict = nameVerdict(slug, facts);
  return verdict.ok ? null : verdict.message;
}

export type SignupNameVerdict = NameVerdict | { ok: false; rule: "signup" | "hold-mismatch"; word: string | null; message: string };

/**
 * Signup's whole answer about an address: the rules for every workspace, then what a business
 * signing itself up must also meet (`signupNameProblem`) — whose words come before "taken", so the
 * form says what would do. With an invitation that holds an address (`facts.hold`): that address and
 * no other, and without the signup rules.
 */
export function signupNameVerdict(slug: string, legalName: string, facts: NameFacts = {}): SignupNameVerdict {
  const hold = facts.hold ?? null;
  if (hold && hold.slug !== slug) return { ok: false, rule: "hold-mismatch", word: hold.slug, message: `Your invitation comes with its own address: ${hold.slug}.` };
  const general = nameVerdict(slug, facts);
  if (!general.ok && general.rule !== "taken" && general.rule !== "held") return general;
  if (hold) return general;
  const own = signupNameProblem(slug, legalName);
  return own ? { ok: false, rule: "signup", word: null, message: own } : general;
}

/** Whether a rule touches an address: a block refuses it, a release lets it through. Hyphens ignored for words. */
export function ruleTouches(slug: string, rule: NameRule): boolean {
  if (rule.kind === "BLOCK_EXACT") return slug === rule.value;
  if (rule.kind === "BLOCK_WORD") return slug.replace(/-/g, "").includes(rule.value);
  return builtInWordsIn(slug).some((m) => m.word === rule.value);
}

/** A word for BLOCK_WORD or RELEASE: letters and digits only (the control plane's CHECK). */
const RULE_WORD = /^[a-z0-9]{2,40}$/;

/**
 * Why staff can't block this — in staff's words; null when they can. `value` as stored: trimmed,
 * lower case. A blocked word has three letters at least: two would refuse a great many names.
 */
export function blockProblem(value: string, kind: "BLOCK_EXACT" | "BLOCK_WORD"): string | null {
  if (kind === "BLOCK_EXACT") {
    if (!SLUG_PATTERN.test(value)) return "A name to block is a whole address: 3–40 lower-case letters, digits and hyphens, not starting or ending with a hyphen.";
  } else if (!RULE_WORD.test(value) || value.length < 3) {
    return "A word to block is 3–40 lower-case letters or digits, without hyphens.";
  }
  if (PLATFORM_HOSTS.has(value)) return `"${value}" is one of the platform's own addresses — locked already, for good.`;
  return null;
}

/** Why staff can't release this word — in staff's words; null when they can. */
export function releaseProblem(value: string): string | null {
  if (PLATFORM_HOSTS.has(value)) return `"${value}" is one of the platform's own addresses. It can never be released: the platform answers on it itself.`;
  if (!RULE_WORD.test(value)) return "A word to release is lower-case letters or digits.";
  if (!releasableGroupOf(value)) return `"${value}" isn't a built-in reserved word, our name or a competitor's — there is nothing to release.`;
  return null;
}

/** Which rule decided a verdict, in staff's words — the console's "Test a name". Never for a customer. */
export function verdictInWords(verdict: SignupNameVerdict): string {
  if (verdict.ok) {
    if (verdict.held) return "Allowed: the invitation holds this address for its customer.";
    if (verdict.released.length) return `Allowed: staff released ${verdict.released.map((w) => `"${w}"`).join(" and ")}.`;
    return "Allowed: no rule refuses it.";
  }
  const word = verdict.word ? `"${verdict.word}"` : "";
  switch (verdict.rule) {
    case "pattern":
      return "The address pattern: 3–40 lower-case letters, digits and hyphens.";
    case "platform":
      return `A platform address (${word}) — locked; nothing lets it through.`;
    case "blocked-exact":
      return `Blocked by staff: this exact name (${word}).`;
    case "blocked-word":
      return `Blocked by staff: it contains the word ${word}.`;
    case "reserved":
      return `A built-in reserved word (${word}).`;
    case "ours":
      return `It carries our name, ${word}.`;
    case "competitor":
      return `It carries a competitor's name, ${word}.`;
    case "held":
      return "Held for another customer on a live invitation.";
    case "taken":
      return "A workspace has it already.";
    case "signup":
      return `A signup rule: ${MIN_SIGNUP_NAME} letters or digits at least, made from the registered business name.`;
    case "hold-mismatch":
      return `The invitation holds another address (${word}).`;
  }
}
