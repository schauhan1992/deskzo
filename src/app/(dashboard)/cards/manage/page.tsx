import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getCardsOverview } from "@/actions/cards";
import { CardsManager } from "@/components/cards/cards-manager";

export const metadata = { title: "Digital cards" };

/**
 * The company's digital cards (docs/digital-cards-and-signatures.md §3.1–3.2, §3.6): who has one and
 * how each is doing, issuing them in bulk, the templates, and — with "See leads from every card" —
 * everybody who shared their details back.
 */
export default async function DigitalCardsPage() {
  if (!(await isModuleEnabled("cards"))) return <ModuleDisabledNotice moduleKey="cards" />;
  const result = await getCardsOverview();
  if (!result.ok) notFound();
  return <CardsManager data={result.data} />;
}
