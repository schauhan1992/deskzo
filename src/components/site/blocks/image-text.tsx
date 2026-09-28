import { Check } from "lucide-react";
import type { ImageTextProps, SiteRenderContext } from "@/components/site/blocks/types";
import { MediaView } from "@/components/site/blocks/media";
import { anchorId, fill, resolveAction } from "@/components/site/links";
import { ButtonLink, Section, SectionHeading } from "@/components/site/ui";
import { cn } from "@/lib/utils";

/** Words on one side, a picture on the other. */
export function ImageTextBlock({ props, ctx }: { props: ImageTextProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const action = props.action ? resolveAction(props.action, ctx) : null;
  return (
    <Section id={anchorId(props.anchor)}>
      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div className={cn(props.mediaSide === "left" && "lg:order-2")}>
          <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
          {props.body?.map((paragraph, i) => (
            <p key={i} className="mt-4 text-base leading-7 text-muted">
              {t(paragraph)}
            </p>
          ))}
          {!!props.bullets?.length && (
            <ul className="mt-6 space-y-3">
              {props.bullets.map((bullet, i) => (
                <li key={i} className="flex gap-3 text-sm leading-6 text-text">
                  <Check aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-brand" />
                  <span>{t(bullet)}</span>
                </li>
              ))}
            </ul>
          )}
          {action && <ButtonLink href={action.href} label={action.label} className="mt-8" arrow />}
        </div>
        <div className={cn("min-w-0", props.mediaSide === "left" && "lg:order-1")}>
          <MediaView media={props.media} />
        </div>
      </div>
    </Section>
  );
}
