/**
 * Draws the sample signature banners (src/lib/signatures/samples.ts) as animated GIFs into
 * public/signature-banners — run again after changing one; the GIFs are committed.
 *
 * Each frame is an SVG drawn by sharp (librsvg, the fonts on this machine), and the frames are joined
 * into one GIF by sharp too — the copy Next already installs, nothing more. The first frame of each is
 * the whole banner, held, because classic Outlook for Windows shows only a GIF's first frame; the
 * movement comes after it, small and short, and loops.
 *
 *   npm run signatures:banners
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { SAMPLE_BANNER_SIZE, SIGNATURE_BANNER_SAMPLES } from "../src/lib/signatures/samples";

const W = SAMPLE_BANNER_SIZE.width;
const H = SAMPLE_BANNER_SIZE.height;
const FONT = "'Segoe UI', Arial, Helvetica, sans-serif";
const OUT = path.join(__dirname, "..", "public", "signature-banners");

type Frame = { body: string; delay: number };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function background(a: string, b: string): string {
  return `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#bg)"/>`;
}

/** Soft circles in a corner, the same in every frame. */
function decoration(color: string): string {
  return `<circle cx="${W - 40}" cy="-10" r="90" fill="${color}" fill-opacity="0.10"/><circle cx="${W - 150}" cy="${H + 30}" r="70" fill="${color}" fill-opacity="0.08"/>`;
}

function words(p: { eyebrow: string; eyebrowColor: string; title: string; sub: string; x?: number; eyebrowX?: number }): string {
  const x = p.x ?? 32;
  return [
    `<text x="${p.eyebrowX ?? x}" y="42" font-family="${FONT}" font-size="12.5" font-weight="700" letter-spacing="2" fill="${p.eyebrowColor}">${esc(p.eyebrow)}</text>`,
    `<text x="${x}" y="80" font-family="${FONT}" font-size="29" font-weight="800" fill="#ffffff">${esc(p.title)}</text>`,
    `<text x="${x}" y="108" font-family="${FONT}" font-size="14.5" fill="#ffffff" fill-opacity="0.86">${esc(p.sub)}</text>`,
  ].join("");
}

/** A pill button on the right; `shine` (0–1) sweeps a light band across it, `glow` rings it. */
function button(p: { label: string; width: number; fill: string; ink: string; shine?: number | null; glow?: number; nudge?: number }): string {
  const x = W - 32 - p.width;
  const y = 50;
  const parts = [`<clipPath id="btn"><rect x="${x}" y="${y}" width="${p.width}" height="40" rx="20"/></clipPath>`];
  if (p.glow) parts.push(`<rect x="${x - 5}" y="${y - 5}" width="${p.width + 10}" height="50" rx="25" fill="none" stroke="${p.fill}" stroke-opacity="${(0.55 * p.glow).toFixed(2)}" stroke-width="3"/>`);
  parts.push(`<rect x="${x}" y="${y}" width="${p.width}" height="40" rx="20" fill="${p.fill}"/>`);
  if (p.shine !== undefined && p.shine !== null) {
    const bx = x - 50 + (p.width + 100) * p.shine;
    parts.push(`<g clip-path="url(#btn)"><polygon points="${bx},${y} ${bx + 26},${y} ${bx + 10},${y + 40} ${bx - 16},${y + 40}" fill="#ffffff" fill-opacity="0.45"/></g>`);
  }
  const arrow = p.nudge !== undefined;
  const cx = x + p.width / 2 - (arrow ? 8 : 0);
  parts.push(`<text x="${cx}" y="${y + 25.5}" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700" fill="${p.ink}">${esc(p.label)}</text>`);
  if (arrow) parts.push(`<text x="${x + p.width - 30 + (p.nudge ?? 0)}" y="${y + 26}" font-family="${FONT}" font-size="16" font-weight="700" fill="${p.ink}">→</text>`);
  return parts.join("");
}

/** A four-pointed sparkle. */
function sparkle(cx: number, cy: number, r: number, opacity: number): string {
  const k = r * 0.28;
  return `<path d="M${cx} ${cy - r} L${cx + k} ${cy - k} L${cx + r} ${cy} L${cx + k} ${cy + k} L${cx} ${cy + r} L${cx - k} ${cy + k} L${cx - r} ${cy} L${cx - k} ${cy - k} Z" fill="#ffffff" fill-opacity="${opacity.toFixed(2)}"/>`;
}

function star(cx: number, cy: number, r: number, filled: boolean): string {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  return `<polygon points="${pts}" fill="${filled ? "#fbbf24" : "#ffffff"}" fill-opacity="${filled ? 1 : 0.22}" stroke="${filled ? "#f59e0b" : "#ffffff"}" stroke-opacity="${filled ? 1 : 0.4}" stroke-width="1.2"/>`;
}

function pin(cx: number, top: number): string {
  return `<path d="M${cx} ${top + 34} C${cx - 4} ${top + 26} ${cx - 13} ${top + 19} ${cx - 13} ${top + 11} A13 13 0 1 1 ${cx + 13} ${top + 11} C${cx + 13} ${top + 19} ${cx + 4} ${top + 26} ${cx} ${top + 34} Z" fill="#ffffff"/><circle cx="${cx}" cy="${top + 11}" r="5" fill="#f97316"/>`;
}

function diya(cx: number, cy: number, flame: number): string {
  const h = 13 + flame * 6;
  return [
    `<ellipse cx="${cx}" cy="${cy - h * 0.55}" rx="${10 + flame * 4}" ry="${h * 0.9}" fill="#fde68a" fill-opacity="${(0.18 + flame * 0.12).toFixed(2)}"/>`,
    `<path d="M${cx} ${cy - h - 4} C${cx + 6} ${cy - h * 0.55} ${cx + 5} ${cy - 3} ${cx} ${cy - 2} C${cx - 5} ${cy - 3} ${cx - 6} ${cy - h * 0.55} ${cx} ${cy - h - 4} Z" fill="#fbbf24"/>`,
    `<path d="M${cx} ${cy - h * 0.6} C${cx + 2.5} ${cy - h * 0.35} ${cx + 2} ${cy - 4} ${cx} ${cy - 3} C${cx - 2} ${cy - 4} ${cx - 2.5} ${cy - h * 0.35} ${cx} ${cy - h * 0.6} Z" fill="#fff7ed"/>`,
    `<path d="M${cx - 22} ${cy} Q${cx} ${cy + 22} ${cx + 22} ${cy} Z" fill="#c2410c"/>`,
    `<path d="M${cx - 22} ${cy} L${cx + 22} ${cy}" stroke="#fdba74" stroke-width="2"/>`,
  ].join("");
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
/** 0 → 1 → 0 over the frames. */
const wave = (i: number, n: number) => Math.sin((Math.PI * i) / (n - 1));

const DRAW: Record<string, () => Frame[]> = {
  hiring: () => {
    const base = background("#1e1b4b", "#4338ca") + decoration("#a5b4fc") + words({ eyebrow: "WE'RE HIRING", eyebrowColor: "#a5b4fc", title: "Join our team", sub: "Good people, real work, room to grow." });
    const b = (nudge: number) => button({ label: "See open roles", width: 182, fill: "#ffffff", ink: "#312e81", nudge });
    return [{ body: base + b(0), delay: 1600 }, ...range(10).map((i) => ({ body: base + b(Math.round(wave(i, 10) * 7)), delay: 70 }))];
  },
  demo: () => {
    const base = background("#0f766e", "#14b8a6") + decoration("#ccfbf1") + words({ eyebrow: "SEE IT IN ACTION", eyebrowColor: "#ccfbf1", title: "Book a free demo", sub: "Twenty minutes, your questions, no slides." });
    const b = (shine: number | null) => button({ label: "Book a demo", width: 150, fill: "#ffffff", ink: "#0f766e", shine });
    return [{ body: base + b(null), delay: 1800 }, ...range(11).map((i) => ({ body: base + b(i / 10), delay: 60 }))];
  },
  event: () => {
    const base = background("#9a3412", "#f97316") + decoration("#ffedd5") + words({ eyebrow: "COME AND MEET US", eyebrowColor: "#ffedd5", title: "We'll be at the expo", sub: "Drop by our stand and say hello." });
    const b = button({ label: "Plan your visit", width: 158, fill: "#ffffff", ink: "#9a3412" });
    const bounce = [0, -5, -9, -11, -9, -5, 0, -3, 0];
    return [{ body: base + b + pin(386, 46), delay: 1600 }, ...bounce.map((dy) => ({ body: base + b + pin(386, 46 + dy), delay: 70 }))];
  },
  webinar: () => {
    const base = background("#111827", "#374151") + decoration("#9ca3af") + words({ eyebrow: "LIVE WEBINAR", eyebrowX: 50, eyebrowColor: "#fca5a5", title: "Join our live session", sub: "Learn, ask, and keep the recording." });
    const dot = (o: number) => `<circle cx="38" cy="37.5" r="5" fill="#ef4444" fill-opacity="${o.toFixed(2)}"/><circle cx="38" cy="37.5" r="${(5 + (1 - o) * 5).toFixed(1)}" fill="none" stroke="#ef4444" stroke-opacity="${(o * 0.6).toFixed(2)}" stroke-width="1.5"/>`;
    const b = (glow: number) => button({ label: "Register free", width: 156, fill: "#ef4444", ink: "#ffffff", glow });
    return range(8).map((i) => {
      const w = wave(i, 8);
      return { body: base + dot(i === 0 ? 1 : 0.35 + 0.65 * (1 - w)) + b(w), delay: i === 0 ? 900 : 110 };
    });
  },
  launch: () => {
    const base = background("#581c87", "#a855f7") + decoration("#f3e8ff") + words({ eyebrow: "JUST LAUNCHED", eyebrowColor: "#f3e8ff", title: "Something new is here", sub: "See what we've been building." });
    const b = button({ label: "Take a look", width: 146, fill: "#ffffff", ink: "#6b21a8" });
    const spots = [
      [372, 36, 9, 0],
      [404, 98, 6, 3],
      [W - 30, 26, 7, 5],
      [W - 196, 116, 5, 7],
      [352, 112, 5, 2],
    ] as const;
    return range(10).map((i) => ({
      body: base + b + spots.map(([x, y, r, phase]) => sparkle(x, y, i === 0 ? r : r * (0.5 + 0.5 * Math.abs(Math.sin(((i + phase) * Math.PI) / 5))), i === 0 ? 0.95 : 0.35 + 0.6 * Math.abs(Math.sin(((i + phase) * Math.PI) / 5)))).join(""),
      delay: i === 0 ? 1400 : 100,
    }));
  },
  feedback: () => {
    const base = background("#064e3b", "#10b981") + decoration("#d1fae5") + words({ eyebrow: "HOW DID WE DO?", eyebrowColor: "#d1fae5", title: "Rate your experience", sub: "One click tells us what to keep doing." });
    const stars = (n: number) => range(5).map((k) => star(W - 190 + k * 38, 70, 15, k < n)).join("");
    return [
      { body: base + stars(5), delay: 1800 },
      { body: base + stars(0), delay: 260 },
      ...[1, 2, 3, 4].map((n) => ({ body: base + stars(n), delay: 170 })),
    ];
  },
  holidays: () => {
    // The snow falls behind the words, so they stay crisp in every frame.
    const back = background("#14532d", "#166534") + decoration("#dcfce7");
    const front = words({ eyebrow: "SEASON'S GREETINGS", eyebrowColor: "#fecaca", title: "Warm wishes from all of us", sub: "Thank you for a wonderful year together." });
    const flakes = range(26).map((k) => ({ x: (k * 97 + 13) % W, y0: (k * 53) % H, r: 1.4 + (k % 3) * 0.8, drift: (k % 5) - 2 }));
    const frames = 12;
    // Never among the words: a flake between two letters reads as a stray full stop.
    const amongWords = (x: number, y: number) => (x < 225 && y > 28 && y < 48) || (x < 425 && y > 52 && y < 90) || (x < 345 && y > 94 && y < 115);
    return range(frames).map((i) => ({
      body:
        back +
        flakes
          .map((f) => {
            const y = (f.y0 + (i * H) / frames) % H;
            const x = f.x + f.drift * Math.sin((i * Math.PI) / 6);
            return amongWords(x, y) ? "" : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${f.r}" fill="#ffffff" fill-opacity="0.6"/>`;
          })
          .join("") +
        front,
      delay: 120,
    }));
  },
  diwali: () => {
    const base = background("#3b0764", "#7c2d12") + decoration("#fde68a") + words({ eyebrow: "WARM WISHES", eyebrowColor: "#fcd34d", title: "Happy Diwali", sub: "May the festival of lights bring you joy and prosperity." });
    const lamps = [W - 150, W - 96, W - 42];
    return range(8).map((i) => ({
      body: base + lamps.map((x, k) => diya(x, 88, i === 0 ? 1 : 0.5 + 0.5 * Math.abs(Math.sin(((i + k * 2) * Math.PI) / 4)))).join(""),
      delay: i === 0 ? 1200 : 130,
    }));
  },
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const sample of SIGNATURE_BANNER_SAMPLES) {
    const draw = DRAW[sample.key];
    if (!draw) throw new Error(`No drawing for the sample "${sample.key}".`);
    const frames = draw();
    const pngs = await Promise.all(
      frames.map((f) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${f.body}</svg>`)).png().toBuffer()),
    );
    const gif = await sharp(pngs, { join: { animated: true } })
      .gif({ delay: frames.map((f) => f.delay), loop: 0, colours: 128, effort: 10, dither: 0.4, interFrameMaxError: 6, interPaletteMaxError: 4 })
      .toBuffer();
    const file = path.join(OUT, `${sample.key}.gif`);
    writeFileSync(file, gif);
    console.log(`${sample.key.padEnd(9)} ${frames.length} frames  ${Math.round(statSync(file).size / 1024)} KB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
