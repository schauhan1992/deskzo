import { ChevronDown, KeyRound, Settings2 } from "lucide-react";
import type { HelpGuideProps, SiteRenderContext } from "@/components/site/blocks/types";
import { RichContent } from "@/components/site/blocks/rich-text";
import { anchorId, fill } from "@/components/site/links";
import { Container, Eyebrow, SiteAnchor } from "@/components/site/ui";
import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";
import { GUIDE_SECTIONS, HELP_PATH, moduleAvailability, type ModuleAvailability } from "@/lib/help/guides";
import { getPermissionDefinition } from "@/lib/permissions";
import type { SiteGuideSummary } from "@/lib/platform/site-content";
import { PRODUCT_FAMILY } from "@/lib/products";
import { slugify } from "@/lib/cms/validate";

/**
 * A module's guide (src/lib/help/guides.ts), as drawn: the page's h1 and summary, a table of contents,
 * then the outline every guide shares, under the block's own headings — what it is for, who can use it,
 * setting it up, everyday tasks, each setting, questions — and last which products include it, read
 * from src/lib/products.ts and src/lib/modules.ts rather than written.
 *
 * Pure, so the CMS's live preview draws it in the browser: the published guides it links to under
 * "Read next" are worked out by whoever renders it (./help-guide.tsx on the site, none in the preview).
 */
export function HelpGuideView({ props, ctx, related }: { props: HelpGuideProps; ctx: SiteRenderContext; related: Pick<SiteGuideSummary, "slug" | "path" | "title" | "summary">[] }) {
  const t = (s?: string) => fill(s, ctx);
  const availability = moduleAvailability(props.module);
  const sections = GUIDE_SECTIONS.filter((s) => s.key !== "products" || availability);
  const tasks = props.tasks ?? [];
  const taskAnchor = (task: HelpGuideProps["tasks"][number]) => anchorId(task.anchor) ?? `task-${slugify(task.title, 40) || "step"}`;

  return (
    <article className="py-10 sm:py-14" data-guide-module={props.module}>
      <Container>
        <div className="grid gap-10 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-14">
          <nav aria-label="On this page" className="order-2 hidden lg:order-1 lg:block">
            <div className="sticky top-24 space-y-3 text-sm">
              <p className="font-semibold text-text">On this page</p>
              <ul className="space-y-2 border-l border-line">
                {sections.map((s) => (
                  <li key={s.key}>
                    <a href={`#${s.anchor}`} className="-ml-px block border-l border-transparent pl-3 text-muted hover:border-brand hover:text-text">
                      {s.heading}
                    </a>
                    {s.key === "tasks" && tasks.length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {tasks.map((task, i) => (
                          <li key={i}>
                            <a href={`#${taskAnchor(task)}`} className="block pl-6 text-[13px] text-subtle hover:text-text">
                              {t(task.title)}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          <div className="order-1 min-w-0 max-w-3xl lg:order-2">
            <header>
              <Eyebrow>
                <SiteAnchor href={HELP_PATH} className="hover:underline">
                  Help Center
                </SiteAnchor>
                {availability && <span className="text-subtle"> · {availability.module.label}</span>}
              </Eyebrow>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text text-balance sm:text-4xl">{t(props.heading)}</h1>
              {props.summary && <p className="mt-4 text-lg leading-8 text-muted text-pretty">{t(props.summary)}</p>}
            </header>

            <GuideSection id="what-its-for" heading={headingOf("purpose")}>
              <RichContent nodes={props.purpose} ctx={ctx} />
            </GuideSection>

            <GuideSection id="who-can-use-it" heading={headingOf("access")}>
              <RichContent nodes={props.access} ctx={ctx} />
              {props.permissions?.length > 0 && (
                <div className="mt-6 rounded-xl border border-line">
                  <dl className="divide-y divide-line">
                    {props.permissions.map((perm, i) => (
                      <div key={i} className="grid gap-1 px-4 py-3 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4">
                        <dt className="flex items-start gap-2 text-sm font-medium text-text">
                          <KeyRound aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                          {getPermissionDefinition(perm.key)?.label ?? perm.key}
                        </dt>
                        <dd className="text-sm leading-6 text-muted">{t(perm.text)}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="border-t border-line bg-surface-sunken px-4 py-2.5 text-xs text-subtle">
                    An admin gives and takes these away in Settings › Roles &amp; Permissions.
                  </p>
                </div>
              )}
            </GuideSection>

            <GuideSection id="setting-it-up" heading={headingOf("setup")}>
              <RichContent nodes={props.setup} ctx={ctx} />
            </GuideSection>

            <GuideSection id="everyday-tasks" heading={headingOf("tasks")}>
              <div className="space-y-10">
                {tasks.map((task, i) => (
                  <section key={i} id={taskAnchor(task)} className="scroll-mt-24">
                    <h3 className="text-lg font-semibold text-text">{t(task.title)}</h3>
                    <div className="mt-3">
                      <RichContent nodes={task.body} ctx={ctx} />
                    </div>
                  </section>
                ))}
              </div>
            </GuideSection>

            <GuideSection id="settings" heading={headingOf("settings")}>
              {props.settings?.length ? (
                <div className="space-y-8">
                  {props.settings.map((s, i) => (
                    <section key={i}>
                      <h3 className="flex items-center gap-2 text-lg font-semibold text-text">
                        <Settings2 aria-hidden="true" className="h-4 w-4 shrink-0 text-brand" />
                        {t(s.name)}
                      </h3>
                      {s.where && <p className="mt-1 text-sm text-subtle">{t(s.where)}</p>}
                      <div className="mt-3">
                        <RichContent nodes={s.body} ctx={ctx} />
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="text-base leading-7 text-muted">This module has no settings of its own.</p>
              )}
            </GuideSection>

            <GuideSection id="questions" heading={headingOf("faq")}>
              <div className="divide-y divide-line border-y border-line">
                {(props.faq ?? []).map((item, i) => (
                  <details key={i} className="group py-4">
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-6 rounded-md text-left text-base font-medium text-text [&::-webkit-details-marker]:hidden">
                      {t(item.question)}
                      <ChevronDown aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-subtle transition-transform duration-200 group-open:rotate-180" />
                    </summary>
                    <div className="mt-3 pr-10">
                      <RichContent nodes={item.answer} ctx={ctx} />
                    </div>
                  </details>
                ))}
              </div>
            </GuideSection>

            {availability && (
              <GuideSection id="products" heading={headingOf("products")}>
                <ProductsIncluding availability={availability} />
              </GuideSection>
            )}

            {related.length > 0 && (
              <section className="mt-14 border-t border-line pt-8">
                <h2 className="text-lg font-semibold text-text">Read next</h2>
                <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                  {related.map((g) => (
                    <li key={g.slug}>
                      <SiteAnchor href={g.path} className="block h-full rounded-xl border border-line p-4 hover:border-brand/40 hover:bg-surface-sunken">
                        <span className="block text-sm font-semibold text-text">{t(g.title)}</span>
                        {g.summary && <span className="mt-1 block text-sm leading-6 text-muted">{t(g.summary)}</span>}
                      </SiteAnchor>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      </Container>
    </article>
  );
}

const headingOf = (key: (typeof GUIDE_SECTIONS)[number]["key"]) => GUIDE_SECTIONS.find((s) => s.key === key)!.heading;

function GuideSection({ id, heading, children }: { id: string; heading: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-12 scroll-mt-24">
      <h2 className="text-2xl font-semibold tracking-tight text-text">{heading}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const countryName = (code: string) => WORLD_COUNTRIES.find((c) => c.code === code)?.name ?? code;

function listInWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Which products include the module — every word of it from products.ts and modules.ts. */
export function ProductsIncluding({ availability }: { availability: ModuleAvailability }) {
  const { everywhere, products, addOn, countries, requires } = availability;
  return (
    <div className="space-y-4 text-base leading-7 text-muted">
      {everywhere ? (
        <p>Every {PRODUCT_FAMILY} product comes with it.</p>
      ) : addOn ? (
        <p>
          {addOn.addOn.name} is an add-on
          {addOn.on ? (
            <>
              {" "}
              to <ProductLink name={addOn.on.name} path={addOn.on.path} />
            </>
          ) : null}
          {addOn.includedIn.length > 0 && (
            <>
              , and comes with{" "}
              {addOn.includedIn.map((p, i) => (
                <span key={p.key}>
                  {i > 0 && (i === addOn.includedIn.length - 1 ? " and " : ", ")}
                  <ProductLink name={p.name} path={p.path} />
                </span>
              ))}
            </>
          )}
          .
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Products that include it">
          {products.map((p) => (
            <li key={p.key}>
              <SiteAnchor href={p.path} className="block h-full rounded-xl border border-line p-4 hover:border-brand/40 hover:bg-surface-sunken">
                <span className="block text-sm font-semibold text-text">{p.name}</span>
                <span className="mt-1 block text-sm leading-6 text-muted">{p.tagline}</span>
              </SiteAnchor>
            </li>
          ))}
        </ul>
      )}
      {countries.length > 0 && <p>Sold in {listInWords(countries.map(countryName))} only.</p>}
      {requires.length > 0 && <p>It works with {listInWords(requires.map((m) => m.label))}, which come with it.</p>}
      <p>
        <SiteAnchor href="/pricing" className="font-medium text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand">
          See the plans and prices
        </SiteAnchor>
      </p>
    </div>
  );
}

function ProductLink({ name, path }: { name: string; path: string }) {
  return (
    <SiteAnchor href={path} className="font-medium text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand">
      {name}
    </SiteAnchor>
  );
}
