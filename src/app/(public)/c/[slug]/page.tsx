import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { countCardEvent, publicCard } from "@/lib/cards/public";
import { PublicCardView } from "@/components/cards/public-card";

/**
 * A digital card's public page (docs/digital-cards-and-signatures.md §3.5): no sign-in, no app, no
 * tracking scripts. Save contact comes first and biggest; sharing back is below it and never required.
 *
 * `noindex`: a card is handed to people, not published to search engines. `no-referrer`: links the
 * card opens learn nothing about where they were tapped.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const found = await publicCard(slug);
  const live = found && found.card.offReason === null;
  return {
    title: live ? `${found.card.resolved.name}${found.company.name ? ` — ${found.company.name}` : ""}` : "Digital card",
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function DigitalCardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = await publicCard(slug);

  if (!found) {
    return (
      <Card className="mx-auto max-w-sm px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">No card here</h1>
        <p className="mt-2 text-sm text-muted">Check the address, or ask the person for their card again.</p>
      </Card>
    );
  }

  const { card, company } = found;
  if (card.offReason !== null) {
    // §3.7: the address keeps working and points to the company, so a card in somebody's wallet still leads somewhere.
    const contacts = [company.phone, company.email].filter(Boolean).join(" · ");
    return (
      <Card className="mx-auto max-w-sm px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">
          {card.offReason === "manual"
            ? "This card is no longer in use"
            : `${card.resolved.name} is no longer with ${company.name || "the company"}`}
        </h1>
        {company.name && (
          <p className="mt-2 text-sm text-muted">
            To reach {company.name}
            {contacts ? `: ${contacts}` : ", contact the company directly."}
          </p>
        )}
      </Card>
    );
  }

  await countCardEvent(card.id, "VIEW");
  return (
    <PublicCardView
      slug={card.slug}
      name={card.resolved.name}
      title={card.resolved.title}
      about={card.resolved.about}
      photoUrl={card.resolved.showPhoto && card.photoVersion ? `/c/${card.slug}/photo?v=${card.photoVersion}` : null}
      lines={card.resolved.lines}
      company={company.name}
      logoDataUrl={card.template.showLogo ? company.logoDataUrl : null}
      accentColor={card.template.accentColor}
      coverColor={card.template.coverColor}
      questions={card.template.questions}
    />
  );
}
