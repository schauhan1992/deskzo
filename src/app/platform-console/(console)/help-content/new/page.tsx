import type { Metadata } from "next";
import { HelpContentEditor } from "@/components/console/help-content/help-content-editor";
import { tabOf, type HelpItemKind } from "@/components/console/help-content/shared";
import { PageHeader } from "@/components/console/kit/page-header";
import { one } from "@/lib/console-shared/params";
import { MANAGERS, capsFor } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { helpEditorChoices } from "../load";

export const metadata: Metadata = { title: "New help item" };

/** `?kind=` in the address; an article when it is missing or something else. */
function kindOf(value: string | undefined): HelpItemKind {
  switch (value) {
    case "video":
      return "VIDEO";
    case "post":
      return "POST";
    default:
      return "ARTICLE";
  }
}

const HEADING: Record<HelpItemKind, { title: string; subtitle: string }> = {
  ARTICLE: { title: "New help article", subtitle: "A link to a page on deskzo.com or in the app, listed in every workspace it is for under “From Deskzo”." },
  VIDEO: { title: "New walkthrough video", subtitle: "A link to a video on YouTube, Vimeo or Loom — never uploaded or embedded — listed under “From Deskzo”." },
  POST: { title: "New What's new post", subtitle: "A release note in plain text, shown in What's new under “From Deskzo”, apart from each company's own news." },
};

/**
 * A new help article, walkthrough video or What's new post from Deskzo (`?kind=article|video|post`).
 * It starts as a draft unless published or scheduled from the editor. Owners and admins only;
 * everybody else gets "not found".
 */
export default async function ConsoleNewHelpItemPage({ searchParams }: PageProps<"/platform-console/help-content/new">) {
  const staff = await consoleStaff(MANAGERS);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const kind = kindOf(one(sp, "kind", 20));
  const choices = await helpEditorChoices();
  const tab = tabOf(kind);

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Help and What's new", href: tab === "articles" ? "/help-content" : `/help-content?tab=${tab}` }, { label: HEADING[kind].title }]}
        title={HEADING[kind].title}
        subtitle={HEADING[kind].subtitle}
      />
      <HelpContentEditor kind={kind} initial={null} choices={choices} caps={caps} mode="create" />
    </>
  );
}
