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
  if (!bytesAre(base64, input.mimeType)) return { ok: false, error: "That file isn't the kind its name says — upload the PDF, Word file or picture itself." };
  return { ok: true, sizeBytes };
}

/**
 * Whether a file's first bytes are those every file of its kind starts with (security review, 23 Oct 2026). The kind
 * came from the browser and was taken at its word, so anything at all could be filed and served back as a PDF or a
 * picture. `atob`, not Buffer, so this stays plain enough for either side.
 */
function bytesAre(base64: string, mimeType: string): boolean {
  let head: number[];
  try {
    head = Array.from(atob(base64.slice(0, 24)), (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  const starts = (...signature: number[]) => signature.every((byte, i) => head[i] === byte);
  switch (mimeType) {
    case "application/pdf":
      return starts(0x25, 0x50, 0x44, 0x46, 0x2d); // %PDF-
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/webp":
      return starts(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50; // RIFF….WEBP
    case "application/msword":
      return starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return starts(0x50, 0x4b, 0x03, 0x04); // a .docx is a zip
    default:
      return false;
  }
}
