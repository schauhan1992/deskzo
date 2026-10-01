import type { SiteRenderContext } from "@/components/site/blocks/types";
import { fill, linkShown, safeHref } from "@/components/site/links";
import { SiteLogo } from "@/components/site/logo";
import { Container, SiteAnchor } from "@/components/site/ui";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { parseEmailAddress } from "@/lib/email-verification";
import { cn } from "@/lib/utils";

const SOCIAL_NAMES: Record<string, string> = { linkedin: "LinkedIn", x: "X", youtube: "YouTube", facebook: "Facebook", instagram: "Instagram", github: "GitHub" };

/** The link columns' grid on a wide screen, by how many there are (up to six). */
const COLUMN_GRID: Record<number, string> = { 1: "lg:grid-cols-3", 2: "lg:grid-cols-3", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5", 6: "lg:grid-cols-3 xl:grid-cols-6" };

/**
 * The public site's footer: the columns of links (up to six), the sales address, the theme switch and
 * the year — worked out on the server (India's calendar), so no client clock is ever asked.
 */
export function SiteFooter({ ctx, year }: { ctx: Pick<SiteRenderContext, "settings" | "trialDays" | "hiddenPaths">; year: number }) {
  const { settings } = ctx;
  const t = (s?: string) => fill(s, ctx);
  const sales = parseEmailAddress(settings.salesEmail);
  const social = settings.social.filter((s) => safeHref(s.href));
  // A link to a page switched off for now is left out, and a column left empty with it.
  const columns = (Array.isArray(settings.footer.columns) ? settings.footer.columns : [])
    .slice(0, 6)
    .map((column) => ({ ...column, links: column.links.filter((link) => linkShown(link.href, ctx)) }))
    .filter((column) => column.links.length);
  return (
    <footer className="border-t border-line bg-surface-sunken">
      <Container className="py-14">
        <div className="grid gap-10 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-12">
          <div>
            <SiteLogo name={settings.siteName} />
            {settings.footer.note && <p className="mt-4 max-w-xs text-sm leading-6 text-muted">{t(settings.footer.note)}</p>}
            {sales && (
              <a href={`mailto:${sales.local}@${sales.domain}`} className="mt-3 inline-block text-sm font-medium text-text hover:text-brand">
                {sales.local}@{sales.domain}
              </a>
            )}
            <div className="mt-6 flex items-center gap-3">
              <span className="text-xs text-subtle">Theme</span>
              <ThemeToggle defaultTheme="system" />
            </div>
          </div>
          {!!columns.length && (
            <div className={cn("grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3", COLUMN_GRID[columns.length])}>
              {columns.map((column, i) => (
                <nav key={i} aria-label={t(column.title)} className="min-w-0">
                  <h2 className="text-sm font-semibold text-text">{t(column.title)}</h2>
                  <ul className="mt-4 space-y-3">
                    {column.links.map((link, j) => (
                      <li key={j}>
                        <SiteAnchor href={link.href} className="text-sm text-muted transition-colors hover:text-text">
                          {t(link.label)}
                        </SiteAnchor>
                      </li>
                    ))}
                  </ul>
                </nav>
              ))}
            </div>
          )}
        </div>
        <div className="mt-12 flex flex-col gap-4 border-t border-line pt-6 text-sm text-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {settings.siteName}
          </p>
          {!!social.length && (
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {social.map((s, i) => (
                <li key={i}>
                  <SiteAnchor href={s.href} className="hover:text-text">
                    {s.label?.trim() || SOCIAL_NAMES[s.network] || "Elsewhere"}
                  </SiteAnchor>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Container>
    </footer>
  );
}
