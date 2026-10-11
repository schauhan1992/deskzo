/**
 * Ready-made banners for under a signature — animated GIFs drawn by scripts/make-signature-banners.ts and
 * kept in public/signature-banners. A manager starts a banner from one: the picture is copied into the
 * banner as an upload (so it is served by the workspace like any other), and its name and words are
 * filled in to change. Each one's first frame says everything on its own — classic Outlook for Windows
 * shows only the first frame of a GIF.
 */

export const SAMPLE_BANNER_SIZE = { width: 600, height: 140 } as const;

export const SIGNATURE_BANNER_SAMPLES = [
  { key: "hiring", name: "We're hiring", alt: "We're hiring — join our team and see our open roles", link: "yourcompany.com/careers" },
  { key: "demo", name: "Book a demo", alt: "See it in action — book a free 20-minute demo", link: "yourcompany.com/demo" },
  { key: "event", name: "Meet us at the expo", alt: "Come and meet us — we'll be at the expo, drop by our stand", link: "yourcompany.com/events" },
  { key: "webinar", name: "Live webinar", alt: "Join our live webinar — register free", link: "yourcompany.com/webinar" },
  { key: "launch", name: "Just launched", alt: "Just launched — something new is here, take a look", link: "yourcompany.com/new" },
  { key: "feedback", name: "Rate your experience", alt: "How did we do? Rate your experience with us", link: "yourcompany.com/feedback" },
  { key: "holidays", name: "Season's greetings", alt: "Season's greetings — warm wishes from all of us", link: "yourcompany.com" },
  { key: "diwali", name: "Happy Diwali", alt: "Happy Diwali — wishing you light, joy and prosperity", link: "yourcompany.com" },
] as const;
export type SignatureBannerSample = (typeof SIGNATURE_BANNER_SAMPLES)[number];

/** Where the app's own pages load a sample from. */
export function sampleBannerPath(key: string): string {
  return `/signature-banners/${key}.gif`;
}
