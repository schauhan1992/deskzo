/**
 * Making a password nobody has to remember.
 *
 * The vault exists so people stop reusing the same four passwords, and that only works if getting a
 * good one is easier than inventing a bad one. So the generator sits in the box where the password
 * is typed, not on a settings page somewhere.
 *
 * Pure, and takes its randomness as an argument, so `scripts/check-vault.ts` can drive it with a
 * known sequence and assert what comes out. The default source is the platform CSPRNG.
 */

export type PasswordOptions = {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  /**
   * Drops the characters people misread off a screen or a sticky note: O/0, l/1/I, and friends.
   * Costs about a bit and a half of entropy at twenty characters, which is nothing next to somebody
   * typing the wrong one four times and writing it down in frustration.
   */
  avoidAmbiguous: boolean;
};

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: true,
};

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;

const SETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  // No quotes, backslash or backtick: these get pasted into shell commands, connection strings and
  // CSV exports, and the ones that need escaping somewhere are the ones that get mangled.
  symbols: "!#$%&()*+-<=>?@[]^_{|}~",
} as const;

const AMBIGUOUS = new Set("O0oIl1|`'\"{}[]()/\\".split(""));

/** A source of random integers in `[0, max)`. Injectable so the generator can be tested. */
export type RandomInt = (maxExclusive: number) => number;

/**
 * The platform CSPRNG, with the modulo bias taken out.
 *
 * `getRandomValues() % n` is the bug everybody writes: unless `n` divides 2³² exactly, the low
 * values come up slightly more often. Over one password that is unobservable; over a company's
 * worth of them it is a real, if small, narrowing of the search space. Rejection sampling costs a
 * few discarded draws and removes the question.
 */
export const secureRandomInt: RandomInt = (maxExclusive: number) => {
  if (maxExclusive <= 0) throw new Error("Range must be positive.");
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0]! < limit) return buffer[0]! % maxExclusive;
  }
};

function poolFor(options: PasswordOptions): { pool: string; required: string[] } {
  const chosen: string[] = [];
  if (options.lower) chosen.push(SETS.lower);
  if (options.upper) chosen.push(SETS.upper);
  if (options.digits) chosen.push(SETS.digits);
  if (options.symbols) chosen.push(SETS.symbols);

  const filtered = chosen
    .map((set) => (options.avoidAmbiguous ? [...set].filter((c) => !AMBIGUOUS.has(c)).join("") : set))
    .filter((set) => set.length > 0);

  return { pool: filtered.join(""), required: filtered };
}

/** The number of distinct characters a password could be drawn from, for the entropy sum. */
export function poolSize(options: PasswordOptions): number {
  return poolFor(options).pool.length;
}

/**
 * A password drawn uniformly from the chosen alphabet.
 *
 * One character of each selected class is placed first and the rest drawn freely, then the whole
 * thing is shuffled. Guaranteeing the classes this way rather than by generating and re-rolling
 * until it happens to contain them keeps the running time bounded — and the shuffle is what stops
 * the guaranteed characters always landing at the front, which would be a pattern an attacker could
 * use.
 */
export function generatePassword(
  options: PasswordOptions = DEFAULT_PASSWORD_OPTIONS,
  randomInt: RandomInt = secureRandomInt,
): string {
  const length = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.floor(options.length)));
  const { pool, required } = poolFor(options);
  // Every class turned off. Rather than return an empty string that somebody saves, fall back to
  // the one alphabet that is always safe to type.
  if (pool.length === 0) return generatePassword({ ...options, lower: true }, randomInt);

  const chars: string[] = [];
  for (const set of required.slice(0, length)) chars.push(set[randomInt(set.length)]!);
  while (chars.length < length) chars.push(pool[randomInt(pool.length)]!);

  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

export type Strength = {
  /** Assuming the password was generated rather than chosen. See below. */
  bits: number;
  label: "weak" | "fair" | "good" | "strong";
  /** What is holding it back, or null when nothing is. */
  note: string | null;
};

const CLASSES: [RegExp, number][] = [
  [/[a-z]/, 26],
  [/[A-Z]/, 26],
  [/[0-9]/, 10],
  [/[^a-zA-Z0-9]/, 32],
];

/**
 * How hard this would be to guess.
 *
 * Stated carefully, because a strength meter that flatters a bad password is worse than no meter:
 * the figure is `length × log2(alphabet)`, which is the *upper bound* that holds only if the
 * password was picked at random. "Password123!" scores 78 bits by that measure and would fall to a
 * dictionary attack in seconds — it is four characters of real entropy wearing a costume.
 *
 * So the bits are computed honestly and then the obvious disasters are caught and capped by hand:
 * one character class, one repeated character, a straight run of the alphabet or the keyboard, or a
 * length nobody should accept. This is not a dictionary check and does not pretend to be one. It is
 * why the generator is one click away — a generated password needs no meter.
 */
export function strengthOf(password: string): Strength {
  if (!password) return { bits: 0, label: "weak", note: "Nothing entered yet." };

  const alphabet = CLASSES.reduce((sum, [re, size]) => (re.test(password) ? sum + size : sum), 0);
  const classes = CLASSES.filter(([re]) => re.test(password)).length;
  const bits = Math.round(password.length * Math.log2(Math.max(alphabet, 2)));

  const cap = (label: Strength["label"], note: string): Strength => ({ bits, label, note });

  if (password.length < 12) return cap("weak", "Under twelve characters — length beats cleverness.");
  if (classes === 1) return cap("weak", "One kind of character only.");
  if (new Set(password).size <= 4) return cap("weak", "Too few different characters.");
  if (hasRun(password, 4)) return cap("fair", "Contains a run like abcd or 1234.");
  if (/(.)\1{2,}/.test(password)) return cap("fair", "Contains a character repeated three times.");
  if (classes === 2) return cap("fair", "Only two kinds of character.");

  if (bits >= 90) return { bits, label: "strong", note: null };
  if (bits >= 70) return { bits, label: "good", note: null };
  return { bits, label: "fair", note: "Longer would help more than anything else." };
}

/** A straight run up or down the character codes, which is what `abcd` and `4321` both are. */
function hasRun(value: string, length: number): boolean {
  let up = 1;
  let down = 1;
  for (let i = 1; i < value.length; i++) {
    const step = value.charCodeAt(i) - value.charCodeAt(i - 1);
    up = step === 1 ? up + 1 : 1;
    down = step === -1 ? down + 1 : 1;
    if (up >= length || down >= length) return true;
  }
  return false;
}
