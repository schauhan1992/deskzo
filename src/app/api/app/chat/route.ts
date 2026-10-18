import { appRoute } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { chatBootstrap } from "@/actions/chat";

/**
 * Team chat in the Deskzo app (owner, 18 Oct 2026): the chat list, the people to start one with and who is online
 * — the web's own chatBootstrap (src/actions/chat.ts), as the phone's person, with every rule it keeps.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor }) => {
  await needAppModule("chat", actor.userId);
  return { data: await chatBootstrap() };
});
