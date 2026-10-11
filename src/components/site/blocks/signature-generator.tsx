import { Users } from "lucide-react";
import type { SignatureGeneratorProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill, resolveAction } from "@/components/site/links";
import { ButtonLink, Container, SectionHeading } from "@/components/site/ui";
import { SignatureGenerator } from "@/components/site/signature-generator";

/**
 * The free email signature generator, and — under it — what a whole company gets from the paid
 * product. The generator's credit links back to this page; it says the site's own name.
 */
export function SignatureGeneratorBlock({ props, ctx }: { props: SignatureGeneratorProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const action = props.upsellAction ? resolveAction(props.upsellAction, ctx) : null;
  return (
    <section id={anchorId(props.anchor) ?? "generator"} className="scroll-mt-20 py-10 sm:py-14">
      <Container>
        {props.heading && <SectionHeading heading={t(props.heading)} intro={t(props.intro)} className="mb-8" />}
        <SignatureGenerator siteName={ctx.settings.siteName} fallbackHref={`https://${ctx.settings.displayDomain}`} privacyNote={t(props.privacyNote)} />
        <div className="mt-10 flex flex-col gap-6 rounded-3xl border border-line bg-surface p-6 shadow-sm sm:p-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex gap-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line bg-brand-subtle text-brand">
              <Users aria-hidden="true" className="h-5 w-5" />
            </span>
            <div className="max-w-2xl">
              <h2 className="text-xl font-semibold tracking-tight text-text">{t(props.upsellHeading)}</h2>
              {props.upsellBody && <p className="mt-2 text-sm leading-6 text-muted">{t(props.upsellBody)}</p>}
            </div>
          </div>
          {action && <ButtonLink href={action.href} label={action.label} size="lg" arrow className="shrink-0" />}
        </div>
      </Container>
    </section>
  );
}
