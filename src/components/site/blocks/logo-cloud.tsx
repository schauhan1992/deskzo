import type { LogoCloudProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill, safeHref, safeSrc } from "@/components/site/links";
import { Container, SiteAnchor } from "@/components/site/ui";

/** Customers' names or logos — only real ones, so it renders nothing until there are any. */
export function LogoCloudBlock({ props, ctx }: { props: LogoCloudProps; ctx: SiteRenderContext }) {
  const items = props.items.filter((item) => item.name?.trim());
  if (!items.length) return null;
  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 border-b border-line py-12">
      <Container>
        {props.heading && <h2 className="text-center text-sm font-medium text-muted">{fill(props.heading, ctx)}</h2>}
        <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-10 gap-y-6">
          {items.map((item, i) => {
            const src = safeSrc(item.imageUrl);
            const mark = src ? (
              // Editors' logos come from anywhere https; next/image would need every host configured.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={item.name} loading="lazy" className="h-8 w-auto max-w-[9rem] object-contain opacity-80 grayscale transition hover:opacity-100 hover:grayscale-0" />
            ) : (
              <span className="text-base font-semibold text-subtle">{item.name}</span>
            );
            return <li key={i}>{safeHref(item.href) ? <SiteAnchor href={item.href!}>{mark}</SiteAnchor> : mark}</li>;
          })}
        </ul>
      </Container>
    </section>
  );
}
