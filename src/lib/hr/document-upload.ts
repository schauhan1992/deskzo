/**
 * What may be filed on a personnel record, and how big it may be.
 *
 * Pure, and shared by the employee and candidate upload paths, because those two differ only in who
 * owns the row. Two copies of "which file types are allowed" is how one of them quietly starts
 * accepting something the other refuses.
 */

/** Data URLs are stored in the row, so the cap is what a Postgres row should reasonably carry. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export const ALLOWED_MIME = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export type UploadCheck = { ok: true; sizeBytes: number } | { ok: false; error: string };

export function checkUpload(input: { name: string; fileDataUrl: string; mimeType: string }): UploadCheck {
  if (!input.name.trim()) return { ok: false, error: "Give the document a name." };
  if (!input.fileDataUrl.startsWith("data:")) return { ok: false, error: "That doesn't look like a file." };
  if (!ALLOWED_MIME.includes(input.mimeType)) {
    return { ok: false, error: "Only PDF, Word and image files can be uploaded." };
  }

  // A base64 payload is about 4/3 of the bytes it encodes — measured on the encoded string, since
  // that is what actually goes into the row.
  const base64 = input.fileDataUrl.slice(input.fileDataUrl.indexOf(",") + 1);
  const sizeBytes = Math.floor((base64.length * 3) / 4);
  if (sizeBytes > MAX_FILE_BYTES) {
    return { ok: false, error: `That file is ${(sizeBytes / 1048576).toFixed(1)} MB. The limit is 4 MB.` };
  }
  return { ok: true, sizeBytes };
}
