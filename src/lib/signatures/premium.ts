import { FREE_LAYOUTS, PREMIUM_TEASERS, type SignatureLayout } from "@/lib/signatures/render";

/**
 * The premium signature templates (owner, 10 Oct 2026): usable in a workspace with Deskzo Signatures
 * (Deskzo One includes it), shown on the public generator only as a watermarked image.
 *
 * Server-only. No client component may import this file — `check:signatures` refuses one that does —
 * so the layouts never reach a browser that hasn't paid for them.
 */
if (typeof window !== "undefined") throw new Error("src/lib/signatures/premium.ts is server-only.");

export const PREMIUM_LAYOUTS: readonly SignatureLayout[] = [
  {
    key: "portrait",
    name: "Portrait",
    tier: "premium",
    blurb: PREMIUM_TEASERS[0]!.blurb,
    arrangement: "side",
    side: "photo",
    photo: "round",
    divider: "vertical",
    nameStyle: "accent",
    logo: "none",
    contacts: "labelled",
    socials: "badges",
  },
  {
    key: "executive",
    name: "Executive",
    tier: "premium",
    blurb: PREMIUM_TEASERS[1]!.blurb,
    arrangement: "side",
    side: "photo",
    photo: "square",
    divider: "top",
    nameStyle: "caps",
    logo: "none",
    contacts: "labelled",
    socials: "text",
  },
  {
    key: "card",
    name: "Card link",
    tier: "premium",
    blurb: PREMIUM_TEASERS[2]!.blurb,
    arrangement: "side",
    side: "photo",
    photo: "round",
    divider: "vertical",
    nameStyle: "bold",
    logo: "none",
    contacts: "plain",
    socials: "badges",
    card: "button-qr",
  },
  {
    key: "campaign",
    name: "Campaign",
    tier: "premium",
    blurb: PREMIUM_TEASERS[3]!.blurb,
    arrangement: "side",
    side: "logo",
    photo: "none",
    divider: "vertical",
    nameStyle: "accent",
    logo: "side",
    contacts: "labelled",
    socials: "badges",
    banner: true,
  },
  {
    key: "centered",
    name: "Centred",
    tier: "premium",
    blurb: PREMIUM_TEASERS[4]!.blurb,
    arrangement: "centered",
    photo: "round",
    divider: "none",
    nameStyle: "accent",
    logo: "none",
    contacts: "plain",
    socials: "badges",
  },
  {
    key: "accent-bar",
    name: "Accent bar",
    tier: "premium",
    blurb: PREMIUM_TEASERS[5]!.blurb,
    arrangement: "stacked",
    photo: "none",
    divider: "left-bar",
    nameStyle: "bold",
    logo: "below",
    contacts: "labelled",
    socials: "badges",
    card: "button",
  },
  {
    key: "split",
    name: "Split",
    tier: "premium",
    blurb: PREMIUM_TEASERS[6]!.blurb,
    arrangement: "split",
    side: "logo",
    photo: "none",
    divider: "none",
    nameStyle: "accent",
    logo: "side",
    contacts: "labelled",
    socials: "text",
  },
  {
    key: "legal",
    name: "Legal",
    tier: "premium",
    blurb: PREMIUM_TEASERS[7]!.blurb,
    arrangement: "side",
    side: "photo",
    photo: "round",
    divider: "vertical",
    nameStyle: "bold",
    logo: "none",
    contacts: "labelled",
    socials: "badges",
    banner: true,
    disclaimer: true,
  },
];

/** Every template a workspace with Signatures may use: the free four first. */
export const ALL_LAYOUTS: readonly SignatureLayout[] = [...FREE_LAYOUTS, ...PREMIUM_LAYOUTS];

export function layoutByKey(key: string | null | undefined): SignatureLayout | undefined {
  return ALL_LAYOUTS.find((l) => l.key === key);
}
