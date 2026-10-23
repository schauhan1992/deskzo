/**
 * A Content-Disposition header for a file somebody named (security review, 23 Oct 2026). A header carries only
 * Latin-1, and a name with anything past it — "Report – Q3.pdf", a name in Hindi — made the response throw, so the
 * download failed with a 500. The plain `filename` is folded to printable ASCII (anything else, a quote and a backslash
 * included, becomes an underscore), and the name as it is goes in `filename*`, which every current browser reads first.
 */
export function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const backslash = String.fromCharCode(92);
  let plain = "";
  for (const ch of fileName) {
    const code = ch.codePointAt(0)!;
    plain += code >= 32 && code < 127 && ch !== '"' && ch !== backslash ? ch : "_";
  }
  return `${kind}; filename="${plain.trim() || "file"}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
