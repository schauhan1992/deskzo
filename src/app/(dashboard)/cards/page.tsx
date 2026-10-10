import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getMyCard } from "@/actions/cards";
import { Card } from "@/components/ui/card";
import { MyCardView } from "@/components/cards/my-card";

export const metadata = { title: "My card" };

/**
 * "My card" (docs/digital-cards-and-signatures.md §3.4–3.6): the card as the people you meet see it,
 * its QR code and link to share, what you may change on it, its numbers, and who shared back.
 */
export default async function MyCardPage() {
  if (!(await isModuleEnabled("cards"))) return <ModuleDisabledNotice moduleKey="cards" />;
  const result = await getMyCard();

  // Pages you can't open are a 404, like any address the app doesn't have (owner, 8 Oct 2026).
  if (!result.ok) notFound();
  if (!result.data.card) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-10 text-center">
        <h1 className="text-lg font-semibold text-text">No card yet</h1>
        <p className="mt-2 text-sm text-muted">Nobody has issued you a digital card yet. HR or an admin issues them from Digital cards.</p>
      </Card>
    );
  }

  return <MyCardView data={result.data} card={result.data.card} />;
}
