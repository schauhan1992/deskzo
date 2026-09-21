"use client";

import { useEffect, useRef, useState } from "react";

/** The print page's own max width. Below this it reflows, which is exactly what a preview mustn't do. */
const PAGE_WIDTH = 820;

/**
 * The print view, shown at page width and scaled down to fit whatever space it's given.
 *
 * Dropping the print page straight into a narrow iframe would let it reflow, and a preview that
 * lays out differently from the PDF isn't a preview. Rendering at the real width and scaling the
 * whole thing keeps the proportions honest — it's a small page, not a different one.
 */
export function DocumentPdfPreview({ documentId }: { documentId: string }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(1160);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // Never scale up: on a wide screen the page sits at its natural size rather than stretching.
    const observer = new ResizeObserver(([entry]) => {
      setScale(Math.min(1, entry.contentRect.width / PAGE_WIDTH));
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  function measure() {
    // Same origin, so the real content height is readable — the alternative is guessing a page
    // count and cropping documents with a lot of lines.
    const body = frameRef.current?.contentDocument?.body;
    if (body) setHeight(body.scrollHeight);
  }

  return (
    <div ref={wrapperRef} className="overflow-hidden rounded-lg border border-line bg-white">
      <div style={{ height: height * scale }}>
        <iframe
          ref={frameRef}
          onLoad={measure}
          src={`/documents/${documentId}/print?embed=1`}
          title="Document preview"
          scrolling="no"
          style={{
            width: PAGE_WIDTH,
            height,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            border: "none",
            display: "block",
          }}
        />
      </div>
    </div>
  );
}
