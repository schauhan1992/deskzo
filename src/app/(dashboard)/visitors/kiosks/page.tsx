import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listKiosks } from "@/actions/visitor";
import { KioskManager } from "@/components/visitors/kiosk-manager";

export default async function KiosksPage() {
  if (!(await isModuleEnabled("visitors"))) return <ModuleDisabledNotice moduleKey="visitors" />;

  const kiosks = await listKiosks();
  if (kiosks === null) redirect("/visitors");

  // Read from the request rather than an env var, so the link is right whether this is reached on
  // localhost, a LAN address or the public host — a reception tablet is usually on the LAN.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");

  return (
    <div className="animate-fade-rise">
      <Link href="/visitors" className="text-sm text-muted hover:text-text">
        ← Visitors
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-text">Reception tablets</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        One link per desk. Open it on the tablet and add it to the home screen — it then runs full screen with no
        address bar.
      </p>
      <div className="mt-5">
        <KioskManager kiosks={kiosks} origin={`${proto}://${host}`} />
      </div>
    </div>
  );
}
