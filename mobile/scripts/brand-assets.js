#!/usr/bin/env node
/**
 * Draws the Deskzo app's icons and Google Play graphics from the official logo (owner, 23 Oct 2026): the
 * blue D on a white tile, and the Deskzo wordmark — traced to vectors in brand/logo/deskzo-mark.svg and
 * deskzo-wordmark.svg at the repository's root, read from there so the app, the website and the
 * wallpaper share one copy. Shapes, not letters, so they look the same on every computer.
 *
 *   node scripts/brand-assets.js
 *
 * Uses sharp from the main project's node_modules (it comes with Next). Writes assets/ for the app and
 * store/graphics/ for the Play listing. A new icon reaches phones only with a new build from the store —
 * an over-the-air update carries the screens, not the icon.
 */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require(path.join(__dirname, "..", "..", "node_modules", "sharp"));

const BRAND = "#0249FE";
const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const STORE = path.join(ROOT, "store", "graphics");
const LOGO = path.join(ROOT, "..", "brand", "logo");
fs.mkdirSync(STORE, { recursive: true });

/** A traced shape from brand/logo: its path and the box it sits in. */
function shape(file) {
  const text = fs.readFileSync(path.join(LOGO, file), "utf8");
  const [x, y, w, h] = /viewBox="([^"]+)"/.exec(text)[1].split(/\s+/).map(Number);
  return { d: /\sd="([^"]+)"/.exec(text)[1], x, y, w, h };
}
const D = shape("deskzo-mark.svg");
const WORDMARK = shape("deskzo-wordmark.svg");

/** A shape drawn `width` wide with its top-left corner at (left, top). */
const place = (s, left, top, width, fill) =>
  `<g transform="translate(${left} ${top}) scale(${width / s.w}) translate(${-s.x} ${-s.y})"><path fill="${fill}" fill-rule="evenodd" d="${s.d}"/></g>`;

/**
 * The D where the icon file puts it on its tile — 376, 330 and 686.5 wide on a 1341 tile — on a tile of
 * `size` at (left, top). `scale` shrinks it about its own centre, for the round masks Android cuts.
 */
function tileD(left, top, size, fill, scale = 1) {
  const k = size / 1341;
  const width = 686.5 * k * scale;
  const height = (width * D.h) / D.w;
  const cx = left + (376 + 686.5 / 2) * k;
  const cy = top + (330 + 724 / 2) * k;
  return place(D, cx - width / 2, cy - height / 2, width, fill);
}

const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);

async function write(file, w, h, body) {
  await sharp(svg(w, h, body)).png().toFile(file);
  console.log("wrote", path.relative(ROOT, file));
}

(async () => {
  // The launcher icon on older Android, and Expo's own icon: the official icon, the blue D on a white tile.
  await write(path.join(ASSETS, "icon.png"), 1024, 1024, `<rect width="1024" height="1024" rx="225" fill="#FFFFFF"/>${tileD(0, 0, 1024, BRAND)}`);
  // Adaptive icon (Android 8+): a white background, the blue D smaller in front so a round mask doesn't
  // clip it, and a one-colour D for themed icons. Android cuts these to the phone's own shape.
  await write(path.join(ASSETS, "android-icon-background.png"), 1024, 1024, `<rect width="1024" height="1024" fill="#FFFFFF"/>`);
  await write(path.join(ASSETS, "android-icon-foreground.png"), 1024, 1024, tileD(0, 0, 1024, BRAND, 0.8));
  await write(path.join(ASSETS, "android-icon-monochrome.png"), 1024, 1024, tileD(0, 0, 1024, "#000000", 0.8));
  await write(path.join(ASSETS, "splash-icon.png"), 1024, 1024, tileD(0, 0, 1024, BRAND, 1.2));
  await write(path.join(ASSETS, "favicon.png"), 48, 48, `<rect width="48" height="48" rx="11" fill="#FFFFFF"/>${tileD(0, 0, 48, BRAND)}`);

  // Google Play: the 512 icon (square — Play rounds it), and the 1024×500 feature graphic: the icon and the
  // wordmark in white on Deskzo blue.
  await write(path.join(STORE, "play-icon-512.png"), 512, 512, `<rect width="512" height="512" fill="#FFFFFF"/>${tileD(0, 0, 512, BRAND)}`);
  await write(
    path.join(STORE, "feature-graphic-1024x500.png"),
    1024,
    500,
    `<rect width="1024" height="500" fill="${BRAND}"/>` +
      `<rect x="96" y="146" width="208" height="208" rx="46" fill="#FFFFFF"/>${tileD(96, 146, 208, BRAND)}` +
      place(WORDMARK, 352, 176, 340, "#FFFFFF") +
      `<text x="354" y="306" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="34" fill="#DCE6FF">Calls with customers that log themselves</text>`,
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
