import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { screenForThisTv } from "@/lib/tv/screens";
import { TvPairing } from "@/components/tv/tv-pairing";

export const metadata: Metadata = { title: "TV", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * Where a TV starts (owner, 17 Oct 2026): a paired TV goes to its board, so does somebody signed in; any
 * other TV shows its pairing code (src/lib/tv/screens.ts).
 */
export default async function TvPage() {
  if (await screenForThisTv()) redirect("/tv/wins");
  const session = await auth();
  if (session?.user) redirect("/tv/wins");
  return <TvPairing />;
}
