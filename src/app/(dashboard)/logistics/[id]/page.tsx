import { notFound } from "next/navigation";
import Link from "next/link";
import { FileMinus2 } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getConsignment } from "@/actions/consignment";
import { ewayForDocument } from "@/actions/eway";
import { transporterOptions } from "@/actions/transporter";
import { ConsignmentRecord } from "@/components/assets/consignment-record";
import { EwayPanel } from "@/components/logistics/eway-panel";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default async function ConsignmentPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("it_assets");
  if (!enabled) return <ModuleDisabledNotice moduleKey="it_assets" />;

  const { id } = await params;
  const consignment = await getConsignment(id);
  if (!consignment) notFound();

  /**
   * The bill hangs off the challan, not off the consignment.
   *
   * A consignment is a movement we are tracking; the e-way bill names a document the driver is
   * carrying. So there is nothing to show until the challan exists, and once it does this is the
   * same panel the document itself shows — one bill, seen from two places.
   *
   * A refusal from `ewayForDocument` is treated as "not your business" rather than an error: a
   * storeman who can read a consignment but not despatch it has no use for portal buttons.
   */
  const view = consignment.document ? await ewayForDocument(consignment.document.id) : null;
  const transporters = view?.ok ? await transporterOptions() : null;

  return (
    <div className="animate-fade-rise space-y-4">
      <ConsignmentRecord consignment={consignment} />

      {view?.ok && <EwayPanel view={view.data} transporters={transporters?.ok ? transporters.data : []} />}

      {!consignment.document && (
        <Card>
          <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
            <FileMinus2 className="h-4 w-4 text-muted" />
            E-way bill
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted">
              An e-way bill is raised against the document the goods travel on. Raise the delivery challan for this
              consignment first, and the bill can go against it.
            </p>
          </CardContent>
        </Card>
      )}

      {consignment.document && !view?.ok && (
        <p className="text-sm text-muted">
          Paperwork:{" "}
          <Link href={`/documents/${consignment.document.id}`} className="text-brand hover:underline">
            {consignment.document.docNumber}
          </Link>
        </p>
      )}
    </div>
  );
}
