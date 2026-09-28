import type { SiteRenderContext, StatsProps } from "@/components/site/blocks/types";
import { anchorId, fill } from "@/components/site/links";
import { Container } from "@/components/site/ui";
import { cn } from "@/lib/utils";

/** A few figures in a row. Facts about the product only — never invented customer counts or ratings. */
export function StatsBlock({ props, ctx }: { props: StatsProps; ctx: SiteRenderContext }) {
  if (!props.items.length) return null;
  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 border-b border-line py-10 sm:py-12">
      <Container>
        {props.heading && <h2 className="mb-8 text-center text-sm font-semibold text-muted">{fill(props.heading, ctx)}</h2>}
        <dl className={cn("grid gap-8 text-center", props.items.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2", props.items.length >= 4 && "lg:grid-cols-4")}>
          {props.items.map((item, i) => (
            <div key={i} className="flex flex-col-reverse gap-1">
              <dt className="text-sm leading-6 text-muted">{fill(item.label, ctx)}</dt>
              <dd className="text-3xl font-semibold tracking-tight text-text tabular-nums sm:text-4xl">{fill(item.value, ctx)}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}
