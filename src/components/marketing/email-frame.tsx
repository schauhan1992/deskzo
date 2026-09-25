import { previewDocument } from "@/lib/marketing/preview";
import { cn } from "@/lib/utils";

/**
 * An email, shown as it will look — in a sandboxed frame where nothing can run and no link goes
 * anywhere. `scale` shrinks it to a thumbnail; the frame is laid out at full width and scaled down,
 * so a thumbnail looks like the email rather than a squashed one.
 */
export function EmailFrame({ html, title, scale = 1, height = 560, className }: { html: string; title: string; scale?: number; height?: number; className?: string }) {
  if (scale === 1) {
    return <iframe title={title} sandbox="" srcDoc={previewDocument(html)} className={cn("w-full rounded-lg border border-line bg-white", className)} style={{ height }} />;
  }
  const width = 640;
  return (
    <div className={cn("overflow-hidden rounded-lg border border-line bg-white", className)} style={{ height: height * scale }}>
      <iframe
        title={title}
        sandbox=""
        tabIndex={-1}
        aria-hidden
        srcDoc={previewDocument(html)}
        className="pointer-events-none origin-top-left border-0"
        style={{ width, height, transform: `scale(${scale})` }}
      />
    </div>
  );
}
