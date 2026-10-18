import { appRoute } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { loadEarlierMessages } from "@/actions/chat";

/**
 * The page before the oldest message shown: `?before=<its time>`.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, params, url }) => {
  await needAppModule("chat", actor.userId);
  return { data: await loadEarlierMessages(params.id ?? "", url.searchParams.get("before") ?? "") };
});
