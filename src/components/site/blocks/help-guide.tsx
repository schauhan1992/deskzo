import type { HelpGuideProps, SiteRenderContext } from "@/components/site/blocks/types";
import { HelpGuideView } from "@/components/site/blocks/help-guide-view";
import { listHelpGuides, type SiteGuideSummary } from "@/lib/platform/site-content";

/**
 * A module's guide on the site (./help-guide-view.tsx draws it). Its related guides are linked only
 * once they are published, so a guide never links to a not-found page.
 */
export async function HelpGuideBlock({ props, ctx }: { props: HelpGuideProps; ctx: SiteRenderContext }) {
  let published: SiteGuideSummary[] = [];
  try {
    published = await listHelpGuides();
  } catch {
    published = [];
  }
  const related = (props.related ?? []).map((key) => published.find((g) => g.module === key)).filter((g): g is SiteGuideSummary => !!g);
  return <HelpGuideView props={props} ctx={ctx} related={related} />;
}
