import { Building2, Mail } from "lucide-react";
import type { SiteRenderContext, WorkspaceSigninProps } from "@/components/site/blocks/types";
import { FindWorkspacesForm } from "@/components/site/forms/find-workspaces";
import { GoToWorkspaceForm } from "@/components/site/forms/go-to-workspace";
import { anchorId, fill } from "@/components/site/links";
import { Container } from "@/components/site/ui";

/**
 * The two ways to sign in from the public site: to a workspace by its name (the browser goes to that
 * workspace's own sign-in page), or "find my workspaces" by email (`#find`).
 */
export function WorkspaceSigninBlock({ props, ctx }: { props: WorkspaceSigninProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 py-12 sm:py-16">
      <Container>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-brand-subtle text-brand">
              <Building2 aria-hidden="true" className="h-5 w-5" />
            </span>
            <h2 className="mt-5 text-xl font-semibold text-text">{t(props.goHeading)}</h2>
            {props.goBody && <p className="mt-2 text-sm leading-6 text-muted">{t(props.goBody)}</p>}
            <div className="mt-6">
              <GoToWorkspaceForm suffix={ctx.workspaceSuffix} />
            </div>
          </div>
          <div id="find" className="flex scroll-mt-24 flex-col rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-brand-subtle text-brand">
              <Mail aria-hidden="true" className="h-5 w-5" />
            </span>
            <h2 className="mt-5 text-xl font-semibold text-text">{t(props.findHeading)}</h2>
            {props.findBody && <p className="mt-2 text-sm leading-6 text-muted">{t(props.findBody)}</p>}
            <div className="mt-6">
              <FindWorkspacesForm confirmationHeading={t(props.confirmationHeading)} confirmationBody={t(props.confirmationBody)} />
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
