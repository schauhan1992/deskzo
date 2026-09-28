import type { CtaProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill, resolveAction } from "@/components/site/links";
import { ButtonLink, Container } from "@/components/site/ui";

/** A call to action: a band in the brand colour, or a quieter panel. */
export function CtaBlock({ props, ctx }: { props: CtaProps; ctx: SiteRenderContext }) {
  const primary = props.primary ? resolveAction(props.primary, ctx) : null;
  const secondary = props.secondary ? resolveAction(props.secondary, ctx) : null;
  const heading = fill(props.heading, ctx);
  const body = fill(props.body, ctx);

  if (props.variant === "band") {
    return (
      <section id={anchorId(props.anchor)} className="scroll-mt-20 py-16 sm:py-24">
        <Container>
          <div className="relative overflow-hidden rounded-3xl bg-brand px-6 py-14 text-center shadow-lg sm:px-12 sm:py-20">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_20%_0%,var(--brand-contrast),transparent_45%),radial-gradient(circle_at_90%_110%,var(--brand-contrast),transparent_40%)]"
            />
            <div className="relative mx-auto max-w-2xl">
              <h2 className="text-3xl font-semibold tracking-tight text-brand-contrast text-balance sm:text-4xl">{heading}</h2>
              {body && <p className="mt-4 text-base leading-7 text-brand-contrast/85 sm:text-lg">{body}</p>}
              {(primary || secondary) && (
                <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
                  {primary && <ButtonLink href={primary.href} label={primary.label} tone="inverse" size="lg" arrow />}
                  {secondary && <ButtonLink href={secondary.href} label={secondary.label} tone="outlineInverse" size="lg" />}
                </div>
              )}
            </div>
          </div>
        </Container>
      </section>
    );
  }

  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 py-12 sm:py-16">
      <Container>
        <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-8 shadow-sm sm:p-12">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_120%_at_100%_0%,color-mix(in_srgb,var(--brand)_12%,transparent),transparent_70%)]" />
          <div className="relative flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-2xl font-semibold tracking-tight text-text text-balance sm:text-3xl">{heading}</h2>
              {body && <p className="mt-3 text-base leading-7 text-muted">{body}</p>}
            </div>
            {(primary || secondary) && (
              <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
                {primary && <ButtonLink href={primary.href} label={primary.label} size="lg" arrow />}
                {secondary && <ButtonLink href={secondary.href} label={secondary.label} tone="secondary" size="lg" />}
              </div>
            )}
          </div>
        </div>
      </Container>
    </section>
  );
}
