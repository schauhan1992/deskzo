import type { FormCategory, FormFillMode, MarketingTopic } from "@prisma/client";
import type { Clock } from "@/lib/time/zone";
import { CATEGORY_KEYS } from "@/lib/forms/categories";
import { TOPICS } from "@/lib/marketing/topics";

/**
 * A form's settings as the builder sends them, checked.
 *
 * Pure, so the rules are the same whoever asks and `check:forms` can hold them without a database.
 * Times arrive as `datetime-local` text and are read on the clock passed in — the workspace's — see
 * `Clock.parseInput`.
 */

/** Lower case, digits and single hyphens: it is a web address, and it will be typed and read aloud. */
export const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

const FILL_MODES: FormFillMode[] = ["LINK", "INVITE", "BOTH"];

export type FormSettingsInput = {
  name: string;
  slug: string;
  headline?: string | null;
  intro?: string | null;
  thankYouText?: string | null;
  category: string;
  fillMode: string;
  createsLead: boolean;
  topic: string;
  assignToUserId?: string | null;
  /** `yyyy-mm-ddThh:mm`, the workspace's time, or blank. */
  closesAt?: string | null;
  eventStartsAt?: string | null;
  eventEndsAt?: string | null;
  venue?: string | null;
  capacity?: string | number | null;
};

export type FormSettings = {
  name: string;
  slug: string;
  headline: string | null;
  intro: string | null;
  thankYouText: string | null;
  category: FormCategory;
  fillMode: FormFillMode;
  createsLead: boolean;
  topic: MarketingTopic;
  assignToUserId: string | null;
  closesAt: Date | null;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  venue: string | null;
  capacity: number | null;
};

const text = (value: string | null | undefined, max: number): string | null => {
  const t = value?.trim() ?? "";
  return t ? t.slice(0, max) : null;
};

function when(clock: Clock, value: string | null | undefined, label: string): { ok: true; at: Date | null } | { ok: false; error: string } {
  if (!value?.trim()) return { ok: true, at: null };
  const at = clock.parseInput(value);
  return at ? { ok: true, at } : { ok: false, error: `${label} isn't a date and time.` };
}

export function checkFormSettings(input: FormSettingsInput, clock: Clock): { ok: true; settings: FormSettings } | { ok: false; error: string } {
  const name = text(input.name, 120);
  if (!name) return { ok: false, error: "Give the form a name." };

  const slug = input.slug.trim().toLowerCase();
  if (slug.length < 3 || slug.length > 60 || !SLUG_SHAPE.test(slug)) {
    return { ok: false, error: "The web address can use lower-case letters, numbers and hyphens, 3 to 60 of them." };
  }

  if (!(CATEGORY_KEYS as string[]).includes(input.category)) return { ok: false, error: "Pick what kind of form this is." };
  if (!(FILL_MODES as string[]).includes(input.fillMode)) return { ok: false, error: "Say who can fill it in." };
  if (!TOPICS.some((t) => t.key === input.topic)) return { ok: false, error: "Pick a topic." };
  const category = input.category as FormCategory;

  const closes = when(clock, input.closesAt, "The closing time");
  if (!closes.ok) return closes;

  let eventStartsAt: Date | null = null;
  let eventEndsAt: Date | null = null;
  let venue: string | null = null;
  let capacity: number | null = null;

  // The event half only means anything on an event. Anywhere else it is cleared rather than kept
  // hidden, so switching a form from event to survey does not leave a seat limit quietly in force.
  if (category === "EVENT") {
    const starts = when(clock, input.eventStartsAt, "The start");
    if (!starts.ok) return starts;
    if (!starts.at) return { ok: false, error: "An event needs a date and time." };
    const ends = when(clock, input.eventEndsAt, "The finish");
    if (!ends.ok) return ends;
    if (ends.at && ends.at.getTime() <= starts.at.getTime()) return { ok: false, error: "The event has to finish after it starts." };
    if (closes.at && closes.at.getTime() > starts.at.getTime()) {
      return { ok: false, error: "Registration can't close after the event has started." };
    }
    eventStartsAt = starts.at;
    eventEndsAt = ends.at;
    venue = text(input.venue, 300);

    const rawCapacity = input.capacity === null || input.capacity === undefined ? "" : String(input.capacity).trim();
    if (rawCapacity) {
      const n = Number(rawCapacity);
      if (!Number.isInteger(n) || n < 1 || n > 100_000) return { ok: false, error: "Seats should be a whole number, 1 or more." };
      capacity = n;
    }
  }

  return {
    ok: true,
    settings: {
      name,
      slug,
      headline: text(input.headline, 200),
      intro: text(input.intro, 2000),
      thankYouText: text(input.thankYouText, 1000),
      category,
      fillMode: input.fillMode as FormFillMode,
      createsLead: input.createsLead === true,
      topic: input.topic as MarketingTopic,
      assignToUserId: input.assignToUserId?.trim() || null,
      closesAt: closes.at,
      eventStartsAt,
      eventEndsAt,
      venue,
      capacity,
    },
  };
}
