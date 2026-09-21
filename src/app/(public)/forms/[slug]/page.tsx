import type { Metadata } from "next";
import { getForm } from "@/actions/marketing-public";
import { Card } from "@/components/ui/card";
import { InboundForm } from "@/components/marketing/inbound-form";

/**
 * Unlike the other public pages, this one *wants* to be found — it is a landing page, and its URL
 * is a slug rather than a token, so there is nothing in it to leak.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const form = await getForm(slug);
  return { title: form ? `${form.headline ?? form.name} — ${form.ourName}` : "Not available" };
}

export default async function FormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const form = await getForm(slug);

  if (!form) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This form isn&apos;t available</h1>
        <p className="mt-2 text-sm text-muted">It may have been closed. Try the address it was linked from.</p>
      </Card>
    );
  }

  return <InboundForm form={form} />;
}
