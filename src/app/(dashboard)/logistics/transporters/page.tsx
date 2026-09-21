import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listTransporters } from "@/actions/transporter";
import { Card } from "@/components/ui/card";
import { TransporterManager } from "@/components/logistics/transporter-manager";

export default async function TransportersPage({
  searchParams,
}: {
  searchParams: Promise<{ retired?: string }>;
}) {
  const enabled = await isModuleEnabled("it_assets");
  if (!enabled) return <ModuleDisabledNotice moduleKey="it_assets" />;

  const showRetired = (await searchParams).retired === "1";
  const result = await listTransporters({ includeRetired: showRetired });
  if (!result.ok) {
    return <Card className="px-6 py-10 text-center text-sm text-muted">{result.error}</Card>;
  }

  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Transporters</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          The couriers and carriers you use, kept as records rather than typed afresh on every consignment. Their GSTIN
          or TRANSIN is what lets an e-way bill be raised before the vehicle is known, and having them in one place is
          what makes &ldquo;who carried it&rdquo; a question with an answer.
        </p>
      </div>

      <TransporterManager transporters={result.data} showRetired={showRetired} />
    </div>
  );
}
