import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

/**
 * A receipt photo made small enough for Deskzo to keep (owner, 22 Oct 2026 — field work): a phone's camera takes
 * several megabytes, Deskzo keeps a receipt of at most half a megabyte. Each try decodes it no bigger than the size
 * named — never the full-sized photo in memory — and saves it as a JPEG, smaller each time, until it fits.
 */

const TRIES = [
  { side: 1600, quality: 0.7 },
  { side: 1280, quality: 0.6 },
  { side: 1024, quality: 0.5 },
  { side: 800, quality: 0.45 },
];

export type Receipt = { uri: string; size: number; width: number; height: number };

async function sizeOf(uri: string): Promise<number> {
  try {
    return (await (await fetch(uri)).blob()).size;
  } catch {
    return 0;
  }
}

export async function shrinkReceipt(uri: string, maxBytes: number): Promise<Receipt | null> {
  for (const t of TRIES) {
    const image = await ImageManipulator.manipulate(uri, { maxWidth: t.side, maxHeight: t.side }).renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: t.quality });
    const size = await sizeOf(saved.uri);
    if (size > 0 && size <= maxBytes) return { uri: saved.uri, size, width: saved.width, height: saved.height };
  }
  return null;
}
