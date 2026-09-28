"use client";

import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Monitor, Smartphone, Tablet } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The live preview's window: an iframe the width of a real screen — desktop, tablet or phone — scaled
 * down to fit the pane, so the site's own responsive layout (its `sm:`/`lg:` breakpoints read the
 * frame's width, not the CMS's) is exactly what a visitor on that screen gets.
 *
 * The frame is same-origin and empty (`srcDoc`); the editor's React tree is portalled into it, with the
 * CMS's stylesheets and theme class copied across and kept in step (a theme switch, a stylesheet hot-
 * reloaded in development). Nothing inside navigates: links and forms are inert, and a click on a block
 * tells the editor which one to open.
 */

export type Device = "desktop" | "tablet" | "mobile";
const DEVICES: Record<Device, { width: number; label: string; icon: typeof Monitor }> = {
  desktop: { width: 1280, label: "Desktop", icon: Monitor },
  tablet: { width: 768, label: "Tablet", icon: Tablet },
  mobile: { width: 390, label: "Phone", icon: Smartphone },
};

const COPIED = "data-cms-preview-copy";
const FRAME_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>';

/** Only in the browser, after hydration: an iframe in the server's HTML can finish loading before React is listening. */
const noSubscribe = () => () => {};
const useInBrowser = () => useSyncExternalStore(noSubscribe, () => true, () => false);

function copyHead(doc: Document) {
  for (const node of Array.from(doc.head.querySelectorAll(`[${COPIED}]`))) node.remove();
  for (const node of Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'))) {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.setAttribute(COPIED, "");
    doc.head.appendChild(copy);
  }
}

function copyTheme(doc: Document) {
  doc.documentElement.className = document.documentElement.className;
  const style = document.documentElement.getAttribute("style");
  if (style) doc.documentElement.setAttribute("style", style);
  else doc.documentElement.removeAttribute("style");
}

export function PreviewFrame({
  title,
  children,
  scrollTo,
  onSelectBlock,
  toolbar,
}: {
  title: string;
  children: ReactNode;
  /** Scrolls the preview to a block; a new object each time the editor asks. */
  scrollTo: { id: string } | null;
  onSelectBlock: (id: string) => void;
  /** More controls for the preview's toolbar (the header-and-footer switch). */
  toolbar?: ReactNode;
}) {
  const inBrowser = useInBrowser();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [box, setBox] = useState({ width: 0, height: 0 });

  const onLoad = () => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    copyHead(doc);
    copyTheme(doc);
    doc.body.className = "bg-bg text-text antialiased";
    let root = doc.getElementById("cms-preview-root");
    if (!root) {
      root = doc.createElement("div");
      root.id = "cms-preview-root";
      doc.body.appendChild(root);
    }
    setMount(root);
  };

  // The pane's size, for the scale.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [inBrowser]);

  // Keep the frame's styles and theme in step with the CMS's.
  useEffect(() => {
    if (!mount) return;
    const doc = mount.ownerDocument;
    const observer = new MutationObserver((records) => {
      if (records.some((r) => r.type === "childList")) copyHead(doc);
      if (records.some((r) => r.type === "attributes")) copyTheme(doc);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    observer.observe(document.head, { childList: true });
    return () => observer.disconnect();
  }, [mount]);

  // A click picks a block; nothing in the frame follows a link or sends a form.
  const pick = useEffectEvent((id: string) => onSelectBlock(id));
  useEffect(() => {
    if (!mount) return;
    const doc = mount.ownerDocument;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.("a, button, form, summary, label")) event.preventDefault();
      const block = target?.closest?.("[data-block-id]");
      const id = block?.getAttribute("data-block-id");
      if (id) pick(id);
    };
    const onSubmit = (event: Event) => event.preventDefault();
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("submit", onSubmit, true);
    return () => {
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("submit", onSubmit, true);
    };
  }, [mount]);

  // The editor asked to see a block.
  useEffect(() => {
    if (!mount || !scrollTo) return;
    const el = Array.from(mount.querySelectorAll<HTMLElement>("[data-block-id]")).find((node) => node.getAttribute("data-block-id") === scrollTo.id);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [mount, scrollTo]);

  const width = DEVICES[device].width;
  const scale = box.width > 0 ? Math.min(1, box.width / width) : 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div role="radiogroup" aria-label="Preview screen size" className="inline-flex rounded-base border border-line bg-surface-sunken p-0.5">
          {(Object.keys(DEVICES) as Device[]).map((key) => {
            const { label, icon: Icon, width: w } = DEVICES[key];
            const on = key === device;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={on}
                title={`${label} — ${w}px wide`}
                onClick={() => setDevice(key)}
                className={cn("inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-xs font-medium", on ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
              >
                <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">{label}</span>
                <span className="sr-only xl:hidden">{label}</span>
              </button>
            );
          })}
        </div>
        <span className="text-xs text-subtle tabular-nums">
          {width}px{scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">{toolbar}</div>
      </div>
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface-sunken">
        {inBrowser && (
          <div className="absolute top-0 left-1/2 -translate-x-1/2" style={{ width: width * scale, height: box.height }}>
            <iframe
              ref={frameRef}
              title={title}
              srcDoc={FRAME_HTML}
              onLoad={onLoad}
              className={cn("origin-top-left border-0 bg-bg shadow-sm", box.width === 0 && "opacity-0")}
              style={{ width, height: scale > 0 ? box.height / scale : box.height, transform: `scale(${scale})` }}
            />
          </div>
        )}
        {mount && createPortal(children, mount)}
      </div>
    </div>
  );
}
