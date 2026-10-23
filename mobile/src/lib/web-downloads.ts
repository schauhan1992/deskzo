/**
 * Files a Deskzo page makes in the browser — an export (a CSV of leads, the aging report) is a Blob the page hands to
 * a link with `download` (src/components/leads/export-leads-button.tsx and the rest) — on an iPhone (owner, 22 Oct
 * 2026). WKWebView saves none of them, and the URL is revoked the moment after the click; so before each page's own
 * scripts run, this keeps hold of every Blob made into a URL, and a click on a `download` link of one sends the file to
 * the app instead (src/app/(tabs)/web.tsx), which hands it to the share sheet. A file the server sends as an attachment
 * goes the other way, by its address (onFileDownload).
 */

/** What a page sends: the file's name, its type, and its bytes in base64. */
export type PageFile = { type: "deskzo-download"; name: string; mime: string; data: string };

export function readPageFile(message: string): PageFile | null {
  try {
    const m = JSON.parse(message) as Partial<PageFile>;
    if (m.type !== "deskzo-download" || typeof m.data !== "string" || !m.data) return null;
    const name = typeof m.name === "string" && m.name.trim() ? m.name.trim().replace(/[/\\]/g, "-").slice(0, 200) : "download";
    return { type: "deskzo-download", name, mime: typeof m.mime === "string" ? m.mime : "application/octet-stream", data: m.data };
  } catch {
    return null;
  }
}

/** Run in each page before its own scripts (injectedJavaScriptBeforeContentLoaded). */
export const PAGE_DOWNLOADS = `(function () {
  if (window.__deskzoDownloads) return;
  window.__deskzoDownloads = true;
  var blobs = new Map();
  var make = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    var url = make.call(URL, object);
    if (object instanceof Blob) blobs.set(url, object);
    return url;
  };
  function send(blob, name) {
    var reader = new FileReader();
    reader.onloadend = function () {
      var data = String(reader.result || "");
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "deskzo-download", name: name, mime: blob.type || "application/octet-stream", data: data.slice(data.indexOf(",") + 1) }));
    };
    reader.readAsDataURL(blob);
  }
  function take(link) {
    if (!link || !link.hasAttribute || !link.hasAttribute("download")) return false;
    var blob = blobs.get(link.href);
    if (!blob) return false;
    send(blob, link.getAttribute("download") || "download");
    return true;
  }
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!take(this)) click.call(this);
  };
  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a[download]") : null;
    if (take(link)) event.preventDefault();
  }, true);
})();
true;`;
