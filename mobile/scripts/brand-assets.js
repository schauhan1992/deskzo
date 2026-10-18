#!/usr/bin/env node
/**
 * Draws the Deskzo app's icons and Google Play graphics from one mark — a white D on the brand indigo
 * (src/app/globals.css --brand), the web app's own mark (src/components/site/logo.tsx). The D is a shape,
 * not a letter, so it looks the same on every computer whatever fonts it has.
 *
 *   node scripts/brand-assets.js
 *
 * Uses sharp from the main project's node_modules (it comes with Next). Writes assets/ for the app and
 * store/graphics/ for the Play listing.
 */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require(path.join(__dirname, "..", "..", "node_modules", "sharp"));

const BRAND = "#4F46E5";
const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const STORE = path.join(ROOT, "store", "graphics");
fs.mkdirSync(STORE, { recursive: true });

/** The D on a 1024 square, centred: an outer bowl and the counter cut out of it. */
const D = '<path fill-rule="evenodd" d="M311 280h170a232 232 0 0 1 0 464h-170z M401 370h80a142 142 0 0 1 0 284h-80z"/>';
const mark = (fill, scale = 1) => `<g fill="${fill}" transform="translate(512 512) scale(${scale}) translate(-512 -512)">${D}</g>`;
const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);

async function write(file, w, h, body) {
  await sharp(svg(w, h, body)).png().toFile(file);
  console.log("wrote", path.relative(ROOT, file));
}

(async () => {
  // The launcher icon on older Android, and Expo's own icon: a rounded indigo tile.
  await write(path.join(ASSETS, "icon.png"), 1024, 1024, `<rect width="1024" height="1024" rx="224" fill="${BRAND}"/>${mark("#fff", 0.9)}`);
  // Adaptive icon (Android 8+): a plain indigo background, the D inside the safe zone in front, and a
  // one-colour D for themed icons. Android cuts these to the phone's own shape.
  await write(path.join(ASSETS, "android-icon-background.png"), 1024, 1024, `<rect width="1024" height="1024" fill="${BRAND}"/>`);
  await write(path.join(ASSETS, "android-icon-foreground.png"), 1024, 1024, mark("#fff", 0.72));
  await write(path.join(ASSETS, "android-icon-monochrome.png"), 1024, 1024, mark("#000", 0.72));
  await write(path.join(ASSETS, "splash-icon.png"), 1024, 1024, mark(BRAND, 0.9));
  await write(path.join(ASSETS, "favicon.png"), 48, 48, `<rect width="48" height="48" rx="10" fill="${BRAND}"/><g transform="scale(0.046875)">${mark("#fff", 0.9)}</g>`);

  // Google Play: the 512 icon (square — Play rounds it), and the 1024×500 feature graphic.
  await write(path.join(STORE, "play-icon-512.png"), 512, 512, `<rect width="512" height="512" fill="${BRAND}"/><g transform="scale(0.5)">${mark("#fff", 0.82)}</g>`);
  await write(
    path.join(STORE, "feature-graphic-1024x500.png"),
    1024,
    500,
    `<rect width="1024" height="500" fill="${BRAND}"/>` +
      `<rect x="96" y="146" width="208" height="208" rx="46" fill="#fff"/><g transform="translate(96 146) scale(0.203125)">${mark(BRAND, 0.9)}</g>` +
      `<text x="352" y="238" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="76" font-weight="700" fill="#fff">Deskzo</text>` +
      `<text x="354" y="300" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="34" fill="#E0E7FF">Calls with customers that log themselves</text>`,
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
