import type { Metadata } from "next";
import { requestOrigin } from "@/components/site/page-view";
import { Eyebrow, Section } from "@/components/site/ui";
import { SignatureGenerator } from "@/components/signatures/generator";
import { FREE_LAYOUTS, PREMIUM_TEASERS } from "@/lib/signatures/render";

/**
 * The free email signature generator (docs/digital-cards-and-signatures.md §5.1): no sign-up, copy
 * into Gmail, Outlook or Apple Mail. Four templates anybody may use; eight premium ones shown as
 * watermarked previews, usable with Deskzo Signatures (owner, 10 Oct 2026). Indexable — it is the top
 * of the funnel.
 */
export const metadata: Metadata = {
  title: "Free email signature generator",
  description:
    "Make a professional email signature in a minute — no sign-up. Copy it into Gmail, Outlook or Apple Mail. Premium templates and company-wide signatures with Deskzo Signatures.",
};

export default async function EmailSignatureGeneratorPage() {
  const origin = (await requestOrigin())?.origin ?? "";
  return (
    <Section>
      <div className="max-w-2xl">
        <Eyebrow>Free tool</Eyebrow>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text text-balance sm:text-4xl">Email signature generator</h1>
        <p className="mt-4 text-base leading-7 text-muted sm:text-lg">Fill in your details, pick a template, copy it into your email. Free, no sign-up.</p>
      </div>
        <div className="mt-8">
          <SignatureGenerator
            freeLayouts={[...FREE_LAYOUTS]}
            premium={[...PREMIUM_TEASERS]}
            madeWithHref={`${origin}/email-signature-generator`}
            previewPath="/email-signature-generator/preview"
            upgradeHref="/pricing"
            demoHref="/contact?topic=demo"
          />
        </div>
    </Section>
  );
}
