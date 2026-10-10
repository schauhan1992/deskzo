import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Mail, Phone } from "lucide-react";
import { getBranding } from "@/actions/branding";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { publicCard, recordCardEvent } from "@/lib/cards/server";
import { PublicCardView } from "@/components/cards/public-card";

type Props = { params: Promise<{ handle: string }> };

/** Link previews and crawlers open the page too; they aren't somebody looking at the card. */
const NOT_A_PERSON = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|linkedin|telegram|discord|skype/i;

async function cardFor(handle: string) {
  if (!(await moduleAvailableForTenant("cards"))) return null;
  return publicCard(handle.toLowerCase());
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const card = await cardFor(handle);
  const title = card?.state === "live" ? [card.card.name, card.card.company].filter(Boolean).join(" — ") : (card?.company ?? "Digital card");
  // Nothing here belongs in a search engine: the card is for the people it is handed to.
  return { title, robots: { index: false, follow: false } };
}

/**
 * A digital card, on the workspace's own address, for anybody — no sign-in, no app. What it shows is
 * exactly what the card shows (src/lib/cards). A card that isn't live answers with the company's own
 * details, so a saved link or an NFC tag keeps pointing somewhere useful; an address that was never a
 * card is a 404.
 */
export default async function PublicCardPage({ params }: Props) {
  const { handle } = await params;
  const card = await cardFor(handle);
  if (!card) notFound();
  const branding = await getBranding();
  const logoUrl = branding.logoDataUrl ? "/api/brand/mark" : null;

  if (card.state === "gone") {
    return (
      <div className="mx-auto w-full max-w-md overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
        <div className="h-16" style={{ backgroundColor: card.color }} />
        <div className="space-y-3 px-5 py-6">
          {card.showLogo && logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-10 max-w-[60%] object-contain" />
          )}
          <h1 className="text-lg font-semibold text-text">This card is no longer in use</h1>
          <p className="text-sm text-muted">
            {card.company ? `${card.company} can still help — ` : "The company can still help — "}
            {card.phone || card.email ? "reach them here." : "get in touch with them directly."}
          </p>
          <div className="space-y-2">
            {card.phone && (
              <a href={`tel:${card.phone.replace(/[^0-9+]/g, "")}`} className="flex items-center gap-2 text-sm text-brand">
                <Phone className="h-4 w-4" aria-hidden />
                {card.phone}
              </a>
            )}
            {card.email && (
              <a href={`mailto:${card.email}`} className="flex items-center gap-2 text-sm text-brand">
                <Mail className="h-4 w-4" aria-hidden />
                {card.email}
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  const agent = (await headers()).get("user-agent") ?? "";
  if (!NOT_A_PERSON.test(agent)) await recordCardEvent(card.cardId, "VIEW");

  return (
    <PublicCardView
      handle={card.handle}
      card={card.card}
      color={card.color}
      layout={card.layout}
      logoUrl={card.showLogo ? logoUrl : null}
      photoUrl={card.photoVersion ? `/c/${card.handle}/photo?v=${card.photoVersion}` : null}
      shareBack={card.shareBack}
      questions={card.questions}
      firstName={card.firstName}
    />
  );
}
