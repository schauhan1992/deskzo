import type { HeroProps, SiteRenderContext } from "@/components/site/blocks/types";
import { MediaView } from "@/components/site/blocks/media";
import { fill, resolveAction } from "@/components/site/links";
import { ButtonLink, Container } from "@/components/site/ui";

/** The top of the home page: the page's h1, what the product is, the two ways on, and a look at it. */
export function HeroBlock({ props, ctx }: { props: HeroProps; ctx: SiteRenderContext }) {
  const primary = props.primary ? resolveAction(props.primary, ctx) : null;
  const secondary = props.secondary ? resolveAction(props.secondary, ctx) : null;
  const note = fill(ctx.signupOpen ? props.note : props.noteInviteOnly, ctx);
  const eyebrow = fill(props.eyebrow, ctx);
  return (
    <section className="relative overflow-hidden border-b border-line">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_55%_at_50%_0%,color-mix(in_srgb,var(--brand)_16%,transparent),transparent_75%)]" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-50 [background-image:linear-gradient(to_right,var(--line)_1px,transparent_1px),linear-gradient(to_bottom,var(--line)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]"
      />
      <Container className="relative pb-16 pt-14 sm:pb-24 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          {eyebrow && (
            <p className="inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-muted shadow-sm">
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
              <span className="truncate">{eyebrow}</span>
            </p>
          )}
          <h1 className="mt-6 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl lg:text-6xl">{fill(props.heading, ctx)}</h1>
          {props.subheading && <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-muted text-pretty sm:text-lg sm:leading-8">{fill(props.subheading, ctx)}</p>}
          {(primary || secondary) && (
            <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              {primary && <ButtonLink href={primary.href} label={primary.label} size="lg" arrow />}
              {secondary && <ButtonLink href={secondary.href} label={secondary.label} size="lg" tone="secondary" />}
            </div>
          )}
          {note && <p className="mt-4 text-sm text-subtle">{note}</p>}
        </div>
        {props.media && (
          <div className="mx-auto mt-14 max-w-5xl sm:mt-20">
            <div className="rounded-[1.25rem] border border-line bg-surface-sunken p-1.5 shadow-lg sm:p-2">
              <MediaView media={props.media} className="shadow-none" />
            </div>
          </div>
        )}
      </Container>
    </section>
  );
}
