/**
 * The words for wishes: what the chip, the corner card and the notification say. Client-safe, and pure,
 * so the card and the notification can never word the same wishes differently.
 */

export type WishKindKey = "BIRTHDAY" | "ANNIVERSARY";

/** What a wish says, after the names: "Sachin wished you many many returns of the day". */
export function wishPhrase(kind: WishKindKey): string {
  return kind === "BIRTHDAY" ? "many many returns of the day" : "a happy work anniversary";
}

/** The card's heading on the day, with the years on an anniversary. */
export function wishHeading(kind: WishKindKey, years?: number | null): string {
  if (kind === "BIRTHDAY") return "Many many returns of the day!";
  return years ? `Happy ${years}-year work anniversary!` : "Happy work anniversary!";
}

/**
 * Who wished, in one line, newest first: one name, two, or two and how many more.
 *
 * Fifty wishes are one sentence, not fifty. The card lists every name beneath it, and the
 * notification is this sentence, rewritten as each new wish comes in.
 */
export function wishSummary(names: string[], kind: WishKindKey): string {
  const phrase = `wished you ${wishPhrase(kind)}`;
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} ${phrase}`;
  if (names.length === 2) return `${names[0]} and ${names[1]} ${phrase}`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} and ${others} other${others === 1 ? "" : "s"} ${phrase}`;
}

/** What the strip says on a colleague's occasion: whom a click wishes, before and after. */
export function wishButtonLabel(firstName: string, kind: WishKindKey, sent: boolean): string {
  if (sent) return `You wished ${firstName}`;
  return kind === "BIRTHDAY" ? `Wish ${firstName} a happy birthday` : `Wish ${firstName} a happy work anniversary`;
}

/** Initials for an avatar: the first letters of the first two words. */
export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "·"
  );
}
