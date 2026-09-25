import { redirect } from "next/navigation";

/** Moved to the wins wall. Kept so an old link or notification still lands somewhere. */
export default function ActivityAwardsMovedPage() {
  redirect("/wins/most-active");
}
