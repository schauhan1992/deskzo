import type { SiteRenderContext, TestimonialProps } from "@/components/site/blocks/types";
import { anchorId, fill, safeSrc } from "@/components/site/links";
import { Container } from "@/components/site/ui";

/** A customer's own words, attributed — only real ones; an empty quote renders nothing. */
export function TestimonialBlock({ props, ctx }: { props: TestimonialProps; ctx: SiteRenderContext }) {
  const quote = fill(props.quote, ctx).trim();
  if (!quote || !props.name?.trim()) return null;
  const src = safeSrc(props.imageUrl);
  const role = [props.role, props.company].filter((s) => s?.trim()).join(", ");
  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 py-16 sm:py-24">
      <Container>
        <figure className="mx-auto max-w-3xl text-center">
          <blockquote className="text-xl font-medium leading-8 tracking-tight text-text text-balance sm:text-2xl sm:leading-9">
            <p>“{quote}”</p>
          </blockquote>
          <figcaption className="mt-8 flex items-center justify-center gap-3">
            {src && (
              // An editor's photo, from anywhere https.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt="" loading="lazy" className="h-10 w-10 rounded-full border border-line object-cover" />
            )}
            <span className="text-left text-sm">
              <span className="block font-semibold text-text">{props.name}</span>
              {role && <span className="block text-muted">{role}</span>}
            </span>
          </figcaption>
        </figure>
      </Container>
    </section>
  );
}
