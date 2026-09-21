import { cn } from "@/lib/utils";

/**
 * A person, as a circle.
 *
 * One component for every place somebody is shown, because the fallback is the interesting part and
 * it should not be reinvented. Most users will never upload a photo, so the initials are not a
 * degraded state — they are the normal one, and they need to look deliberate rather than like a
 * broken image.
 *
 * `photoUpdatedAt` decides which to render, and no query needs to carry the image to answer that.
 * It also goes in the URL as a version, which is what lets the route cache for a year: a new photo
 * is a different URL rather than something the browser must be persuaded to re-fetch.
 */

export type AvatarUser = {
  id: string;
  name: string;
  /** Null when there is no photo. See the column's comment in prisma/schema.prisma. */
  photoUpdatedAt?: Date | string | null;
};

/**
 * `overlap` is how far each avatar in a stack slides over the one before it, and it is per-size
 * rather than a single constant because it has to stay under the width of two initials. Six pixels
 * off a 20px circle leaves ten pixels of content, and "AM" does not fit in ten pixels — a row of
 * six then reads as one smear of half-letters. Photos tolerate a heavier overlap; initials, which
 * are the normal case here and not a degraded one, do not.
 */
const SIZES = {
  xs: { box: "h-5 w-5", text: "text-[9px]", px: 20, overlap: "-ml-1" },
  sm: { box: "h-7 w-7", text: "text-[11px]", px: 28, overlap: "-ml-1.5" },
  md: { box: "h-9 w-9", text: "text-xs", px: 36, overlap: "-ml-2" },
  lg: { box: "h-16 w-16", text: "text-lg", px: 64, overlap: "-ml-3" },
  xl: { box: "h-24 w-24", text: "text-2xl", px: 96, overlap: "-ml-4" },
} as const;

export type AvatarSize = keyof typeof SIZES;

/**
 * Two letters at most.
 *
 * `slice(0, 2)` on the words rather than on the string: "Priya Sharma" gives PS, and a single-word
 * name gives one letter rather than the first two characters of it, which reads as a typo.
 */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function Avatar({
  user,
  size = "sm",
  className,
  /** A ring, for the "you are viewing as somebody else" state. */
  tone = "default",
}: {
  user: AvatarUser | null | undefined;
  size?: AvatarSize;
  className?: string;
  tone?: "default" | "warning";
}) {
  const s = SIZES[size];
  const shell = cn(
    "grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold",
    s.box,
    s.text,
    tone === "warning" ? "bg-warning-bg text-warning ring-2 ring-warning/40" : "bg-brand-subtle text-brand",
    className,
  );

  if (!user) return <span className={shell}>?</span>;

  if (user.photoUpdatedAt) {
    const version = new Date(user.photoUpdatedAt).getTime();
    return (
      <span className={shell}>
        {/* A plain <img>, not next/image: these are served from our own route already sized for the
            circle, and the optimizer would add a round trip and a cache layer to save nothing. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/users/${user.id}/photo?v=${version}`}
          alt=""
          width={s.px}
          height={s.px}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      </span>
    );
  }

  return (
    <span className={shell} aria-hidden>
      {initialsOf(user.name)}
    </span>
  );
}

/**
 * A row of people, overlapping.
 *
 * The point of a stack over a list of names is that it answers "roughly who, and how many" in one
 * glance without costing a line of text. It is not a substitute for the names — every avatar keeps
 * its `title`, and anywhere the exact list matters there is a dialog behind it.
 *
 * Beyond `max` it stops and counts. The overflow chip is the same size and shape as an avatar so
 * the row does not change height when somebody is added.
 */
export function AvatarStack({
  users,
  size = "sm",
  max = 4,
  className,
}: {
  users: AvatarUser[];
  size?: AvatarSize;
  max?: number;
  className?: string;
}) {
  if (users.length === 0) return null;

  // A single hidden person reads as "+1" beside three faces, which is sillier than just showing
  // four. So the overflow only kicks in when it actually saves space.
  const shown = users.length <= max + 1 ? users : users.slice(0, max);
  const hidden = users.length - shown.length;
  const s = SIZES[size];

  return (
    <span className={cn("flex items-center", className)}>
      {shown.map((user) => (
        // `shrink-0` on the wrapper, not only on the avatar inside it: these spans are the flex
        // items, and without it a row of six collapses into an unreadable smear of half-circles
        // the moment the container is the least bit narrow.
        <span key={user.id} title={user.name} className={cn(s.overlap, "shrink-0 first:ml-0")}>
          <Avatar user={user} size={size} className="ring-2 ring-surface" />
        </span>
      ))}
      {hidden > 0 && (
        <span
          title={users.slice(shown.length).map((u) => u.name).join(", ")}
          className={cn(
            "grid shrink-0 place-items-center rounded-full bg-surface-sunken font-semibold text-muted ring-2 ring-surface",
            s.overlap,
            s.box,
            s.text,
          )}
        >
          +{hidden}
        </span>
      )}
    </span>
  );
}
