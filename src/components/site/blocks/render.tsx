import type { ReactNode } from "react";
import type { SiteBlock, SiteRenderContext } from "@/components/site/blocks/types";
import { ContactFormBlock } from "@/components/site/blocks/contact-form";
import { ComparisonTableBlock } from "@/components/site/blocks/comparison-table";
import { CtaBlock } from "@/components/site/blocks/cta";
import { FaqBlock } from "@/components/site/blocks/faq";
import { FeatureGridBlock } from "@/components/site/blocks/feature-grid";
import { HeroBlock } from "@/components/site/blocks/hero";
import { ImageTextBlock } from "@/components/site/blocks/image-text";
import { LogoCloudBlock } from "@/components/site/blocks/logo-cloud";
import { ModuleGridBlock } from "@/components/site/blocks/module-grid";
import { ModuleHighlightsBlock } from "@/components/site/blocks/module-highlights";
import { PageHeaderBlock } from "@/components/site/blocks/page-header";
import { PricingTableBlock } from "@/components/site/blocks/pricing-table";
import { ProductPreviewsBlock } from "@/components/site/blocks/product-previews";
import { RelatedLinksBlock } from "@/components/site/blocks/related-links";
import { RichTextBlock } from "@/components/site/blocks/rich-text";
import { SecurityHighlightsBlock } from "@/components/site/blocks/security-highlights";
import { SignupFormBlock } from "@/components/site/blocks/signup-form";
import { StatsBlock } from "@/components/site/blocks/stats";
import { TestimonialBlock } from "@/components/site/blocks/testimonial";
import { WorkspaceSigninBlock } from "@/components/site/blocks/workspace-signin";

/**
 * A page's blocks, in order. A block of a type this code does not know — content saved by a newer
 * CMS — is skipped, not an error: the rest of the page still renders.
 */
export async function SiteBlocks({ blocks, ctx }: { blocks: SiteBlock[]; ctx: SiteRenderContext }) {
  return <>{blocks.map((block, i) => renderBlock(block, ctx, `${block.id || "block"}-${i}`))}</>;
}

function renderBlock(block: SiteBlock, ctx: SiteRenderContext, key: string): ReactNode {
  switch (block.type) {
    case "hero":
      return <HeroBlock key={key} props={block.props} ctx={ctx} />;
    case "pageHeader":
      return <PageHeaderBlock key={key} props={block.props} ctx={ctx} />;
    case "featureGrid":
      return <FeatureGridBlock key={key} props={block.props} ctx={ctx} />;
    case "moduleGrid":
      return <ModuleGridBlock key={key} props={block.props} ctx={ctx} />;
    case "richText":
      return <RichTextBlock key={key} props={block.props} ctx={ctx} />;
    case "imageText":
      return <ImageTextBlock key={key} props={block.props} ctx={ctx} />;
    case "stats":
      return <StatsBlock key={key} props={block.props} ctx={ctx} />;
    case "faq":
      return <FaqBlock key={key} props={block.props} ctx={ctx} />;
    case "cta":
      return <CtaBlock key={key} props={block.props} ctx={ctx} />;
    case "pricingTable":
      return <PricingTableBlock key={key} props={block.props} ctx={ctx} />;
    case "securityHighlights":
      return <SecurityHighlightsBlock key={key} props={block.props} ctx={ctx} />;
    case "contactForm":
      return <ContactFormBlock key={key} props={block.props} ctx={ctx} />;
    case "logoCloud":
      return <LogoCloudBlock key={key} props={block.props} ctx={ctx} />;
    case "testimonial":
      return <TestimonialBlock key={key} props={block.props} ctx={ctx} />;
    case "productPreviews":
      return <ProductPreviewsBlock key={key} props={block.props} ctx={ctx} />;
    case "workspaceSignin":
      return <WorkspaceSigninBlock key={key} props={block.props} ctx={ctx} />;
    case "signupForm":
      return <SignupFormBlock key={key} props={block.props} ctx={ctx} />;
    case "comparisonTable":
      return <ComparisonTableBlock key={key} props={block.props} ctx={ctx} />;
    case "relatedLinks":
      return <RelatedLinksBlock key={key} props={block.props} ctx={ctx} />;
    case "moduleHighlights":
      return <ModuleHighlightsBlock key={key} props={block.props} ctx={ctx} />;
    default:
      return null;
  }
}
