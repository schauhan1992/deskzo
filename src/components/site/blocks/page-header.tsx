import { Info, TriangleAlert } from "lucide-react";
import type { PageHeaderProps, SiteRenderContext } from "@/components/site/blocks/types";
import { fill } from "@/components/site/links";
import { Container, Eyebrow } from "@/components/site/ui";
import { cn } from "@/lib/utils";

/** The top of an inner page: its h1, an introduction, and a notice such as "Draft — for review by counsel". */
export function PageHeaderBlock({ props, ctx }: { props: PageHeaderProps; ctx: SiteRenderContext }) {
  const notice = props.notice?.text ? props.notice : null;
  return (
    <section className="relative overflow-hidden border-b border-line">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_0%_0%,color-mix(in_srgb,var(--brand)_10%,transparent),transparent_70%)]" />
      <Container className="relative py-14 sm:py-20">
        <div className="max-w-3xl">
          {props.eyebrow && <Eyebrow>{fill(props.eyebrow, ctx)}</Eyebrow>}
          <h1 className={cn("text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl", props.eyebrow && "mt-3")}>{fill(props.heading, ctx)}</h1>
          {props.intro && <p className="mt-5 text-base leading-7 text-muted text-pretty sm:text-lg sm:leading-8">{fill(props.intro, ctx)}</p>}
          {notice && (
            <p
              className={cn(
                "mt-8 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm leading-6",
                notice.tone === "warning" ? "border-warning/30 bg-warning-bg text-warning" : "border-info/30 bg-info-bg text-info",
              )}
            >
              {notice.tone === "warning" ? <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> : <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
              <span className="font-medium">{fill(notice.text, ctx)}</span>
            </p>
          )}
        </div>
      </Container>
    </section>
  );
}
