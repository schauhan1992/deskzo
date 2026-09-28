import { PartnerShell } from "@/components/partners/shell/portal-shell";
import { partnerPage } from "@/lib/partners/guard";
import { partnerPagesFor } from "@/lib/partners/nav";
import { platformEnv } from "@/lib/platform/console-page";
import { getSiteSettings, siteOrigin } from "@/lib/platform/site-content";

/**
 * The partner portal's frame, on partners. only (src/proxy.ts rewrites there into this folder and
 * refuses the folder anywhere else). Signed out, it sends the visitor to /login; through sign-in but
 * not two-factor, to /enrol (src/lib/partners/guard.ts partnerPage). Each page below checks the
 * session itself too: the App Router keeps this layout across navigations without running it again.
 *
 * Everything the shell shows is worked out here, as plain props — never the session's id, and never
 * staff's reason for the partner's status: who is signed in, which partner they sign in for (its name,
 * kind and status, for the top bar and the status banner), the pages their role may open, which
 * installation this is, and where the public site lives and what it is called.
 */
export default async function PartnerPortalLayout({ children }: LayoutProps<"/platform-partners">) {
  const { user } = await partnerPage();
  const visibleKeys = partnerPagesFor(user.role, user.partner.kind).map((page) => page.key);
  const url = siteOrigin();
  const settings = await getSiteSettings();

  return (
    <PartnerShell
      me={{ id: user.id, name: user.name, email: user.email, role: user.role }}
      partner={{ displayName: user.partner.displayName, kind: user.partner.kind, status: user.partner.status }}
      env={platformEnv()}
      visibleKeys={visibleKeys}
      site={{ url, host: new URL(url).host, name: settings.siteName }}
    >
      {children}
    </PartnerShell>
  );
}
