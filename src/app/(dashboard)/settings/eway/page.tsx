import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, Truck, XCircle } from "lucide-react";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { ewaySettings } from "@/actions/eway";
import { listTransporters } from "@/actions/transporter";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { EwaySettingsForm } from "@/components/settings/eway-settings-form";
import { EwayEnableToggle } from "@/components/settings/eway-enable-toggle";
import { EwayFlow } from "@/components/settings/eway-flow";
import { planGate } from "@/components/settings/module-disabled-notice";
import { countryFeatureAvailable } from "@/lib/modules-access";

export default async function EwaySettingsPage() {
  const gate = await planGate("sales_documents", "E-way bills");
  if (gate) return gate;
  if (!(await countryFeatureAvailable("eway"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">E-way bills</h1>
        <p className="mt-2 text-sm text-muted">E-way bills are India&apos;s, and this workspace is set up for another country.</p>
      </div>
    );
  }
  const sessionUser = await currentUser();
  if (!sessionUser || !(await can(sessionUser.id, "settings.manage"))) notFound();

  const [result, transporters] = await Promise.all([ewaySettings(), listTransporters({})]);
  if (!result.ok) {
    return <Card className="px-6 py-10 text-center text-sm text-muted">{result.error}</Card>;
  }
  const settings = result.data;
  const registrations = settings.registrations;

  // The login is the e-invoice one, so a GSTIN is connected only while e-invoicing is on and its provider is set.
  const live = registrations.filter((r) => r.active);
  const connected = live.filter((r) => r.configured && settings.einvoiceEnabled).length;
  const allConnected = live.length > 0 && connected === live.length;
  const onMock = registrations.filter((r) => r.provider === "mock");

  const withoutGstin = transporters.ok ? transporters.data.filter((t) => !t.gstin).length : 0;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">E-way bills</h1>
          <p className="mt-1 text-sm text-muted">
            The portal connection, and the one number that is yours to set.
          </p>
        </div>
        <EwayEnableToggle enabled={settings.enabled} />
      </div>

      {!settings.enabled && (
        <Card className="mt-6 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          {/*
            Stated rather than implied by a greyed-out screen: this is a compliance module, and
            somebody needs to have decided it is off rather than discovered it.
          */}
          E-way bills are switched off. Nothing is filed and the list is hidden — the movements that need one still
          need one.
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-text">Connection and thresholds</span>
          <Badge tone={allConnected ? "green" : "amber"}>
            {allConnected ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
            {allConnected ? "Connected" : connected > 0 ? "Partly set up" : "Not set up"}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          {/*
            No separate credentials here on purpose. Two sets of details for the same NIC login is
            how one of them goes stale unnoticed, and the one that goes stale is always the one you
            need at four o'clock on a Friday. The portal issues one login per GSTIN, so each
            registration below uses its own e-invoice login.
          */}
          <p className="text-sm text-muted">
            E-way bills go through the same NIC portal as e-invoicing, on the same login — one per GSTIN. It is entered once,
            under{" "}
            <Link href="/settings/einvoicing" className="text-brand hover:underline">
              e-Invoicing
            </Link>
            .
          </p>

          {registrations.length === 0 ? (
            <p className="flex items-start gap-2 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                No GST registration yet — add one under{" "}
                <Link href="/settings/branches" className="font-medium underline underline-offset-2">
                  Branches &amp; GST registrations
                </Link>
                . Without your own GSTIN, every movement is read as crossing a state line and no bill can be raised at all.
              </span>
            </p>
          ) : (
            <EwaySettingsForm registrations={registrations} einvoiceEnabled={settings.einvoiceEnabled} />
          )}

          {registrations.length > 0 && !settings.einvoiceEnabled && (
            <p className="flex items-start gap-2 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                E-invoicing is switched off, and e-way bills sign in with its logins — nothing can be filed until it is on,
                under{" "}
                <Link href="/settings/einvoicing" className="font-medium underline underline-offset-2">
                  e-Invoicing
                </Link>
                .
              </span>
            </p>
          )}

          {onMock.length > 0 && (
            <p className="rounded-base bg-surface-sunken px-3 py-2 text-sm text-muted">
              {/* Said out loud, because a mock bill looks exactly like a real one on screen. */}
              {registrations.length === 1 ? "Running" : `GSTIN ${onMock.map((r) => r.gstin).join(", ")} ${onMock.length === 1 ? "runs" : "run"}`}{" "}
              against the mock portal. Numbers it returns are made up — nothing has been filed with NIC.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="text-sm font-medium text-text">How it works</CardHeader>
        <CardContent>
          <EwayFlow />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-text">Transporters</span>
          <Link href="/logistics/transporters" className="text-sm text-brand hover:underline">
            Manage
          </Link>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Truck className="h-4 w-4 text-subtle" />
            {transporters.ok
              ? `${transporters.data.length} transporter${transporters.data.length === 1 ? "" : "s"} on file.`
              : "Not visible with your permissions."}
          </p>
          {withoutGstin > 0 && (
            <p className="text-sm text-muted">
              {withoutGstin} of them {withoutGstin === 1 ? "has" : "have"} no GSTIN or TRANSIN recorded. A bill naming
              one of those has to carry the vehicle number up front, because there is no transporter id for the portal
              to hold it against.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
