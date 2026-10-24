/**
 * Each Deskzo product's icon (owner, 24 Oct 2026: "3d icons to our products") — a raised tile in the
 * product's own colour, lit from the top left, with a white glyph standing out of it. Pure data and one
 * SVG builder, so the website (src/components/brand/product-icon.tsx) and the files at /brand/<file>
 * draw the same icon from one copy. Every product in src/lib/products.ts has one: the Record says so.
 *
 * The depth is drawn, not rendered: a darker slab under the tile for its thickness, a gloss on its top
 * half, a highlight along its rim, and the glyph three times — its soft shadow, its edge, and its face.
 * Deskzo One's glyph is the D of Deskzo's own icon, on Deskzo blue (src/lib/brand/deskzo-logo.ts).
 *
 * Glyphs are drawn in a 64-unit box. A part that is a shape says `stroke="none"`, a line says
 * `fill="none"`, and a shape that is both (`rounded`) gets its corners from its own stroke — so each
 * pass of the glyph paints it by setting fill and stroke once. `shade` is drawn on the face only, in the
 * tile's colour: the cube's sides, the lines on a card.
 */

import { DESKZO_BLUE, DESKZO_MARK } from "@/lib/brand/deskzo-logo";
import type { ProductKey } from "@/lib/products";

type Glyph = { body: string; shade?: string };

const rect = (x: number, y: number, w: number, h: number, r: number, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" stroke="none"${extra}/>`;
const circle = (cx: number, cy: number, r: number, extra = "") => `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="none"${extra}/>`;
const shape = (d: string, extra = "") => `<path d="${d}" stroke="none"${extra}/>`;
const line = (d: string, width: number, extra = "") => `<path d="${d}" fill="none" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
/** A shape with round corners: filled, and stroked in the same paint. */
const rounded = (d: string, width: number) => `<path d="${d}" stroke-width="${width}" stroke-linejoin="round"/>`;
/** The right-hand side of a bar with round corners, for the shade that makes it a prism. */
const barSide = (x: number, y: number, w: number, h: number, r: number, side = 4) =>
  shape(`M${x + w - side} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + w - side}Z`);

/**
 * Deskzo's D, moved into the glyph box: every number of the traced path (absolute M, L and C only, so all
 * pairs) mapped to 46 units high, centred. Done to the numbers rather than by a transform, so the face's
 * gradient, which is in the glyph box's units, lies across the D the way it lies across every other glyph.
 */
function deskzoD(): string {
  const [vx, vy] = DESKZO_MARK.viewBox.split(" ").map(Number);
  const scale = 46 / DESKZO_MARK.height;
  const left = (64 - DESKZO_MARK.width * scale) / 2;
  const top = (64 - 46) / 2;
  let i = 0;
  const d = DESKZO_MARK.path.replace(/-?\d+(?:[.]\d+)?/g, (n) => {
    const v = Number(n);
    const out = i++ % 2 === 0 ? left + (v - vx!) * scale : top + (v - vy!) * scale;
    return String(Math.round(out * 100) / 100);
  });
  return `<path d="${d}" fill-rule="evenodd" stroke="none"/>`;
}

const GLYPHS: Record<ProductKey, Glyph> = {
  one: { body: deskzoD() },
  // Two people: the customers and contacts the CRM is about.
  crm: {
    body:
      circle(22, 20, 9) +
      shape("M6 52C6 41.5 13 35 22 35C31 35 38 41.5 38 52Q38 55 35 55H9Q6 55 6 52Z") +
      circle(46, 21, 7.5) +
      shape("M41 36.4C42.6 35.5 44.3 35 46 35C53.2 35 58 40.4 58 48.5Q58 51.5 55 51.5H42.3C42.3 45.6 42 40.2 41 36.4Z"),
  },
  // A sales funnel, in three stages.
  pipeline: { body: rounded("M8 10H56L47 22H17Z", 4) + rounded("M19 27H45L39 38H25Z", 4) + rounded("M27 43H37L35 54H29Z", 4) },
  // An invoice with a torn foot, its lines and its total.
  books: {
    body: shape("M18 6H46Q50 6 50 10V57L45.5 53L41 57L36.5 53L32 57L27.5 53L23 57L18.5 53L14 57V10Q14 6 18 6Z"),
    shade: rect(20, 14, 24, 4, 2) + rect(20, 23, 16, 3.5, 1.75) + rect(20, 30, 20, 3.5, 1.75) + rect(20, 40, 24, 6, 3, ' fill-opacity="0.4"'),
  },
  // An employee's ID badge on its clip.
  people: {
    body: rect(26, 3, 12, 10, 3) + rect(13, 9, 38, 50, 7),
    shade: rect(26, 15, 12, 3, 1.5) + circle(32, 30, 6.5) + shape("M21 47C21 41 26 38 32 38C38 38 43 41 43 47Z") + rect(23, 51, 18, 3, 1.5),
  },
  // A support headset.
  desk: {
    body: line("M13 35V31A19 19 0 0 1 51 31V35", 5.5) + rect(7, 31, 13, 19, 5.5) + rect(44, 31, 13, 19, 5.5) + line("M50.5 50V51Q50.5 57 44 57H37", 4) + rect(27, 53, 12, 8, 4),
  },
  // Stock: a packed carton, its tape over the top and down the side.
  inventory: {
    body: rounded("M32 7L55 18.5V45.5L32 57L9 45.5V18.5Z", 4),
    shade: shape("M9 18.5L32 30V57L9 45.5Z", ' fill-opacity="0.1"') + shape("M32 30L55 18.5V45.5L32 57Z", ' fill-opacity="0.26"') + line("M20.5 12.75L43.5 24.25V37", 4.5, ' stroke-opacity="0.2"'),
  },
  // Two arrows chasing each other round: renewals.
  subscriptions: {
    body:
      line("M50.19 21.5A21 21 0 0 0 11.32 35.65", 6.5) +
      rounded("M4.43 36.87L18.22 34.43L12.71 43.53Z", 3) +
      line("M13.81 42.5A21 21 0 0 0 52.68 28.35", 6.5) +
      rounded("M59.57 27.13L45.78 29.57L51.29 20.47Z", 3),
  },
  // A plan's bars, each with the part that is done.
  projects: {
    body: rect(7, 9, 32, 11, 5.5) + rect(19, 26.5, 38, 11, 5.5) + rect(13, 44, 28, 11, 5.5),
    shade: rect(7, 9, 22, 11, 5.5) + rect(19, 26.5, 17, 11, 5.5) + rect(13, 44, 11, 11, 5.5),
  },
  // A megaphone, and its sound.
  campaigns: {
    body: rounded("M7 25H21L45 12V52L21 39H7Z", 6) + rounded("M12 39H21L24 52Q25 55 22 55H18Q16 55 15.5 53Z", 2) + line("M52 24Q57 32 52 40", 4),
    shade: rect(19, 23, 3, 18, 1),
  },
  // Rising bars, each a prism.
  analytics: {
    body: rect(8, 36, 12, 20, 3.5) + rect(26, 25, 12, 31, 3.5) + rect(44, 13, 12, 43, 3.5),
    shade: barSide(8, 36, 12, 20, 3.5) + barSide(26, 25, 12, 31, 3.5) + barSide(44, 13, 12, 43, 3.5),
  },
  // A padlock.
  vault: {
    body: line("M21 29V21A11 11 0 0 1 43 21V29", 6) + rect(11, 27, 42, 32, 8),
    shade: circle(32, 40, 5, ' fill-opacity="0.5"') + rect(30, 41, 4, 10, 2, ' fill-opacity="0.5"'),
  },
  // A business card: the person, their name and their lines.
  cards: {
    body: rect(5, 13, 54, 38, 7),
    shade: circle(19, 27, 5.5) + shape("M11 41C11 36.5 14.5 34.5 19 34.5C23.5 34.5 27 36.5 27 41Z") + rect(32, 22, 20, 4, 2) + rect(32, 30, 14, 3.5, 1.75) + rect(32, 37.5, 17, 3.5, 1.75),
  },
  // A pen's nib over the signature it wrote.
  signatures: {
    body:
      shape("M21 5H43Q46 5 46 8V20Q46 26 42.5 31.5L34.4 45Q32 49 29.6 45L21.5 31.5Q18 26 18 20V8Q18 5 21 5Z") +
      line("M7 56C14 50 18 50 21 55C24 60 29 59 33 54C37 49 41 51 43 55C45 58 50 58 57 54", 3.5),
    shade: rect(18, 5, 28, 7, 3) + circle(32, 26, 3.5, ' fill-opacity="0.45"') + rect(31, 28, 2, 15, 1, ' fill-opacity="0.45"'),
  },
};

/** Each product's colour — the tile's, at its foot; its top is lighter. Deskzo One is Deskzo blue. */
export const PRODUCT_COLORS: Record<ProductKey, string> = {
  one: DESKZO_BLUE,
  crm: "#7C3AED",
  pipeline: "#0D9488",
  books: "#16A34A",
  people: "#F59E0B",
  desk: "#E11D48",
  inventory: "#B7791F",
  subscriptions: "#4F46E5",
  projects: "#65A30D",
  campaigns: "#F4511E",
  analytics: "#DB2777",
  vault: "#334155",
  cards: "#0EA5E9",
  signatures: "#C026D3",
};

/** `a` moved toward `b` by `t` (0–1), both #RRGGBB. */
function mix(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0")).join("")}`;
}

const WHITE = "#ffffff";
const BLACK = "#000000";

/**
 * A product's icon as an SVG document. `idPrefix` names its gradients, filters and glyph: two icons on one
 * page need different ones, or the second paints with the first's — and a first one in a closed menu
 * paints nothing at all. `size` sets its width and height; without one it fills its box.
 */
export function productIconSvg(product: ProductKey, options: { idPrefix?: string; size?: number } = {}): string {
  const glyph = GLYPHS[product];
  const base = PRODUCT_COLORS[product];
  const id = options.idPrefix ?? `dz-${product}-`;
  const light = mix(base, WHITE, 0.3);
  const slab = mix(base, BLACK, 0.32);
  const shadow = mix(base, BLACK, 0.55);
  const edge = mix(WHITE, base, 0.38);
  const faceFoot = mix(WHITE, base, 0.12);
  const dim = options.size ? `width="${options.size}" height="${options.size}"` : 'width="100%" height="100%"';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" ${dim} focusable="false">` +
    "<defs>" +
    `<linearGradient id="${id}t" x1="24" y1="8" x2="104" y2="112" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${base}"/></linearGradient>` +
    `<linearGradient id="${id}g" x1="0" y1="8" x2="0" y2="72" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="0.38"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="${id}r" x1="0" y1="8" x2="0" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="0.75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${faceFoot}"/></linearGradient>` +
    `<filter id="${id}s" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="2.2"/></filter>` +
    `<filter id="${id}b" x="-25%" y="-100%" width="150%" height="300%"><feGaussianBlur stdDeviation="3"/></filter>` +
    `<g id="${id}m">${glyph.body}</g>` +
    "</defs>" +
    `<ellipse cx="64" cy="117" rx="42" ry="4.5" fill="${shadow}" opacity="0.4" filter="url(#${id}b)"/>` +
    `<rect x="12" y="14" width="104" height="104" rx="28" fill="${slab}"/>` +
    `<rect x="12" y="8" width="104" height="104" rx="28" fill="url(#${id}t)"/>` +
    `<rect x="12" y="8" width="104" height="104" rx="28" fill="url(#${id}g)"/>` +
    `<rect x="12.75" y="8.75" width="102.5" height="102.5" rx="27.25" fill="none" stroke="url(#${id}r)" stroke-width="1.5"/>` +
    '<g transform="translate(32 28)">' +
    `<use href="#${id}m" y="5" fill="${shadow}" stroke="${shadow}" opacity="0.45" filter="url(#${id}s)"/>` +
    `<use href="#${id}m" y="3" fill="${edge}" stroke="${edge}"/>` +
    `<use href="#${id}m" fill="url(#${id}f)" stroke="url(#${id}f)"/>` +
    (glyph.shade ? `<g fill="${base}" stroke="${base}" fill-opacity="0.22" stroke-opacity="0.22">${glyph.shade}</g>` : "") +
    "</g>" +
    "</svg>"
  );
}
