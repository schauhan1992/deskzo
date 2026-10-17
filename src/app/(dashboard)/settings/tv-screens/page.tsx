import { notFound } from "next/navigation";
import { listTvScreens } from "@/actions/tv";
import { planGate } from "@/components/settings/module-disabled-notice";
import { TvScreensManager } from "@/components/tv/tv-screens-manager";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";

/**
 * Settings → TV screens (owner, 17 Oct 2026): the TVs showing the wins board, each a branch's or the whole
 * company's — paired by the code a TV shows at /tv. "Put Deskzo on a TV" (wins.tv); anybody else gets a
 * 404, as every refused page does. A TV's QR code lands here with its code filled in.
 */
export default async function TvScreensPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const gate = await planGate("wins", "TV screens");
  if (gate) return gate;
  const user = await currentUser();
  if (!user || !(await can(user.id, "wins.tv"))) notFound();
  const [data, params, origin] = await Promise.all([listTvScreens(), searchParams, tenantOrigin()]);
  if (!data) notFound();

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">TV screens</h1>
        <p className="mt-1 text-sm text-muted">
          TVs on the wall showing the wins board — each one a branch&apos;s, or the whole company&apos;s. No sign-in and no seat; take one off here and it goes back to
          showing a code.
        </p>
      </div>
      <TvScreensManager screens={data.screens} branches={data.branches} initialCode={(params.code ?? "").replace(/\D/g, "").slice(0, 6)} origin={origin} />
    </div>
  );
}
