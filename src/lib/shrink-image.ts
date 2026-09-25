/**
 * A picture redrawn small enough to put on a page that loads it every minute.
 *
 * A phone photo is 3–6 MB, and the wins wall and the office TV load every prize picture on every
 * refresh. So the browser redraws it at most `maxSide` pixels on its longer side, as a JPEG, before it
 * is sent — typically 60–150 KB. Transparent parts come out white rather than JPEG's black.
 *
 * Browser-only: it needs a canvas.
 */
export async function shrinkImage(file: File, maxSide = 900, quality = 0.82): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file isn't a picture this browser can open."));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't resize pictures.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}
