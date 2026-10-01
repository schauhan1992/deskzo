import { execFile } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * A page turned into a PDF by a headless Chrome, Chromium or Edge already on the server.
 *
 * Its own browser rather than a PDF library: the document's printed layout already exists as a page
 * (the Print / PDF view), and a second copy of it written for a PDF library would drift from the
 * first — the emailed invoice and the printed one must be the same document. Chrome's own
 * command-line printing does the job with nothing to install beyond the browser.
 *
 * The browser is found at `PDF_BROWSER_PATH` if set, or at the usual install locations. Each run gets
 * a throwaway profile directory, so two sends at once do not fight over one, and nothing a run did is
 * left for the next to see.
 */

const CANDIDATES: Record<string, string[]> = {
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
    "C:/Program Files/Chromium/Application/chrome.exe",
    // Last: on some machines msedge.exe hands off to a running Edge and exits at once without
    // printing anything. That is caught below — no PDF means an error, never an empty attachment.
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ],
  linux: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/microsoft-edge"],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
};

export const PDF_TIMEOUT_MS = 45_000;
/** Microsoft's sendMail takes an attachment inline up to about 3 MB. */
export const PDF_MAX_BYTES = 3 * 1024 * 1024;

export class PdfError extends Error {}

export function findBrowser(): string | null {
  const configured = process.env.PDF_BROWSER_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  return (CANDIDATES[process.platform] ?? []).find((p) => p && existsSync(p)) ?? null;
}

type Renderer = (url: string, options?: RenderOptions) => Promise<Buffer>;

/** `hostRules`: Chrome's --host-resolver-rules, so a workspace's hostname can point at this machine. */
export type RenderOptions = { hostRules?: string | null };
let testRenderer: Renderer | null = null;

/** For check scripts: a stand-in, so a suite never needs a browser or a running server. */
export function setTestPdfRenderer(renderer: Renderer | null) {
  testRenderer = renderer;
}

export async function renderPdf(url: string, options: RenderOptions = {}): Promise<Buffer> {
  if (testRenderer) return testRenderer(url, options);

  const browser = findBrowser();
  if (!browser) {
    throw new PdfError(
      process.env.PDF_BROWSER_PATH
        ? "The browser set in PDF_BROWSER_PATH isn't there."
        : "Making the PDF needs Chrome, Chromium or Edge on the server. Install one, or set PDF_BROWSER_PATH.",
    );
  }

  const work = mkdtempSync(path.join(tmpdir(), "deskzo-pdf-"));
  const out = path.join(work, "document.pdf");
  try {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--hide-scrollbars",
      `--user-data-dir=${path.join(work, "profile")}`,
      // A PDF of a document, not of a browser tab: no URL, date or page count stamped on it.
      "--no-pdf-header-footer",
      // Some Linux servers run the app as root, where Chrome refuses its own sandbox.
      ...(process.env.PDF_BROWSER_NO_SANDBOX === "true" ? ["--no-sandbox"] : []),
      ...(options.hostRules ? [`--host-resolver-rules=${options.hostRules}`] : []),
      `--print-to-pdf=${out}`,
      url,
    ];
    await new Promise<void>((resolve, reject) => {
      execFile(browser, args, { timeout: PDF_TIMEOUT_MS, windowsHide: true }, (error) =>
        error ? reject(new PdfError(error.killed ? "The browser took too long to make the PDF." : "The browser couldn't make the PDF.")) : resolve(),
      );
    });
    if (!existsSync(out)) throw new PdfError("The browser finished without making a PDF.");
    const pdf = readFileSync(out);
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new PdfError("What the browser made isn't a PDF.");
    return pdf;
  } finally {
    // Chrome's helper processes can hold the profile a moment after the main one exits, most of all
    // on Windows. A folder left in the temp directory is not worth failing a send over.
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS cleans its temp directory */
    }
  }
}
