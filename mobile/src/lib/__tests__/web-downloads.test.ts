import { PAGE_DOWNLOADS, readPageFile } from "@/lib/web-downloads";

/** A page, as far as the script sees one: Blob URLs, a link's click, a click listener, and the app's postMessage. */
function page() {
  const posted: string[] = [];
  const navigated: string[] = [];
  const listeners: ((e: { target: unknown; preventDefault(): void }) => void)[] = [];
  let next = 0;
  class Blob {
    constructor(
      readonly parts: string[],
      readonly options: { type?: string } = {},
    ) {}
    get type() {
      return this.options.type ?? "";
    }
  }
  const made = new Map<string, Blob>();
  const URL = {
    createObjectURL: (blob: Blob) => {
      const url = `blob:https://acme.deskzo.com/${++next}`;
      made.set(url, blob);
      return url;
    },
    revokeObjectURL: (url: string) => void made.delete(url),
  };
  class FileReader {
    result: string | null = null;
    onloadend: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      this.result = `data:${blob.type};base64,${btoa(blob.parts.join(""))}`;
      this.onloadend?.();
    }
  }
  class HTMLAnchorElement {
    href = "";
    attributes: Record<string, string> = {};
    setAttribute(k: string, v: string) {
      this.attributes[k] = v;
    }
    hasAttribute(k: string) {
      return k in this.attributes;
    }
    getAttribute(k: string) {
      return this.attributes[k] ?? null;
    }
    closest(selector: string) {
      return selector === "a[download]" && this.hasAttribute("download") ? this : null;
    }
    click() {
      navigated.push(this.href);
    }
  }
  const window: Record<string, unknown> = { ReactNativeWebView: { postMessage: (m: string) => void posted.push(m) } };
  const document = { addEventListener: (_: string, fn: (typeof listeners)[number]) => void listeners.push(fn) };
  // The script as a page runs it, with this page's globals in place of the real ones.
  const run = () => new Function("window", "document", "URL", "Blob", "FileReader", "HTMLAnchorElement", PAGE_DOWNLOADS)(window, document, URL, Blob, FileReader, HTMLAnchorElement);
  run();
  run(); // a second injection changes nothing
  const link = (href: string, download?: string) => {
    const a = new HTMLAnchorElement();
    a.href = href;
    if (download !== undefined) a.setAttribute("download", download);
    return a;
  };
  return { posted, navigated, listeners, link, URL, Blob };
}

describe("a page's own downloads, on an iPhone", () => {
  it("sends an export to the app — though the page revokes its URL at once", () => {
    const p = page();
    const blob = new p.Blob(["name,phone\nRavi,98765"], { type: "text/csv;charset=utf-8;" });
    const url = p.URL.createObjectURL(blob);
    const a = p.link(url, "leads.csv");
    a.click();
    p.URL.revokeObjectURL(url);
    expect(p.navigated).toEqual([]);
    expect(p.posted).toHaveLength(1);
    const file = readPageFile(p.posted[0]!);
    expect(file).toEqual({ type: "deskzo-download", name: "leads.csv", mime: "text/csv;charset=utf-8;", data: btoa("name,phone\nRavi,98765") });
  });

  it("takes a click on a download link in the page too", () => {
    const p = page();
    const url = p.URL.createObjectURL(new p.Blob(["x"], { type: "application/pdf" }));
    let prevented = false;
    p.listeners.forEach((fn) => fn({ target: p.link(url, "aging.pdf"), preventDefault: () => (prevented = true) }));
    expect(prevented).toBe(true);
    expect(readPageFile(p.posted[0]!)).toMatchObject({ name: "aging.pdf", mime: "application/pdf" });
  });

  it("leaves every other link alone", () => {
    const p = page();
    p.link("https://acme.deskzo.com/leads").click();
    const url = p.URL.createObjectURL(new p.Blob(["x"]));
    p.link(url).click(); // a Blob URL without download: the page is showing it, not saving it
    p.link("blob:https://acme.deskzo.com/not-ours", "x.csv").click();
    expect(p.posted).toEqual([]);
    expect(p.navigated).toHaveLength(3);
  });
});

describe("readPageFile", () => {
  it("takes only a file the script sent", () => {
    expect(readPageFile("not json")).toBeNull();
    expect(readPageFile(JSON.stringify({ type: "something-else", data: "eA==" }))).toBeNull();
    expect(readPageFile(JSON.stringify({ type: "deskzo-download", name: "a.csv", data: "" }))).toBeNull();
  });

  it("gives a name that stays in its folder", () => {
    expect(readPageFile(JSON.stringify({ type: "deskzo-download", name: "../../etc/passwd", data: "eA==" }))?.name).toBe("..-..-etc-passwd");
    expect(readPageFile(JSON.stringify({ type: "deskzo-download", name: "  ", data: "eA==" }))?.name).toBe("download");
    expect(readPageFile(JSON.stringify({ type: "deskzo-download", data: "eA==" }))).toMatchObject({ name: "download", mime: "application/octet-stream" });
  });
});
