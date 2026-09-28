import { ArrowRight } from "lucide-react";
import type { ContactFormProps, SiteRenderContext } from "@/components/site/blocks/types";
import { CONTACT_TOPICS, type ContactTopic } from "@/components/site/contact-fields";
import { ContactForm } from "@/components/site/forms/contact-form";
import { anchorId, fill } from "@/components/site/links";
import { Container, SiteAnchor } from "@/components/site/ui";
import { parseEmailAddress } from "@/lib/email-verification";

/** The contact form, and beside it the other ways in. `?topic=demo` (etc.) picks the topic. */
export function ContactFormBlock({ props, ctx }: { props: ContactFormProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const asked = String(ctx.searchParams.topic ?? "") as ContactTopic;
  const defaultTopic: ContactTopic = CONTACT_TOPICS.includes(asked) ? asked : "demo";
  const topics = { demo: t(props.topics.demo), sales: t(props.topics.sales), support: t(props.topics.support), other: t(props.topics.other) };
  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 py-12 sm:py-16">
      <Container>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-16">
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
            <h2 className="text-xl font-semibold text-text">{t(props.heading)}</h2>
            {props.intro && <p className="mt-2 text-sm leading-6 text-muted">{t(props.intro)}</p>}
            <div className="mt-6">
              <ContactForm topics={topics} defaultTopic={defaultTopic} submitLabel={t(props.submitLabel)} successHeading={t(props.successHeading)} successBody={t(props.successBody)} />
            </div>
          </div>
          {!!props.aside?.length && (
            <aside aria-label={t(props.asideHeading) || undefined}>
              {props.asideHeading && <h2 className="text-sm font-semibold text-text">{t(props.asideHeading)}</h2>}
              <ul className="mt-6 space-y-8">
                {props.aside.map((item, i) => {
                  const body = t(item.body);
                  // The one mail link on the site, built from an address checked here, never an href from content.
                  const address = parseEmailAddress(body);
                  return (
                    <li key={i}>
                      <p className="text-sm font-semibold text-text">{t(item.title)}</p>
                      {address ? (
                        <a href={`mailto:${address.local}@${address.domain}`} className="mt-1 inline-block text-sm text-brand hover:underline">
                          {body}
                        </a>
                      ) : (
                        <p className="mt-1 text-sm leading-6 text-muted">{body}</p>
                      )}
                      {item.link && (
                        <SiteAnchor href={item.link.href} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
                          {t(item.link.label)}
                          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                        </SiteAnchor>
                      )}
                    </li>
                  );
                })}
              </ul>
            </aside>
          )}
        </div>
      </Container>
    </section>
  );
}
