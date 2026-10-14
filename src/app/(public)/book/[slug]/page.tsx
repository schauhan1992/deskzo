import type { Metadata } from "next";
import { bookingTimes } from "@/actions/booking-public";
import { Card } from "@/components/ui/card";
import { BookingWidget } from "@/components/booking/booking-widget";

/**
 * A booking page (src/lib/booking), at /book/<slug> on the workspace's address: the times its hosts are
 * free, and booking one. Its address is a name chosen to be shared, not a secret, so it may be found.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await bookingTimes(slug);
  return { title: page ? `${page.title} — ${page.ourName}` : "Not available" };
}

export default async function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await bookingTimes(slug);
  if (!page) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This booking page isn&apos;t available</h1>
        <p className="mt-2 text-sm text-muted">It may have been switched off. Try the address it was linked from.</p>
      </Card>
    );
  }
  return <BookingWidget page={page} />;
}
