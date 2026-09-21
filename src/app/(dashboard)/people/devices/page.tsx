import { headers } from "next/headers";
import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities, listPeople } from "@/actions/hr";
import {
  listBiometricDevices,
  mappedEnrolments,
  recentPunches,
  unmappedEnrolments,
} from "@/actions/biometric";
import { Card } from "@/components/ui/card";
import { BiometricDevices } from "@/components/hr/biometric-devices";

export default async function DevicesPage() {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const caps = await hrCapabilities();
  if (!caps.manage) {
    return (
      <Card className="px-4 py-12 text-center text-sm text-subtle">
        Only HR can manage biometric terminals.{" "}
        <Link href="/people/attendance" className="text-brand hover:underline">
          Back to attendance
        </Link>
      </Card>
    );
  }

  const [devices, unmapped, mapped, punches, people, requestHeaders] = await Promise.all([
    listBiometricDevices(),
    unmappedEnrolments(),
    mappedEnrolments(),
    recentPunches(),
    listPeople({ status: "active" }),
    headers(),
  ]);

  // Read from the request so the setup card shows the address this deployment is actually reachable
  // at, rather than a placeholder somebody has to work out for themselves.
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const proto = requestHeaders.get("x-forwarded-proto") ?? "http";

  return (
    <div className="animate-fade-rise">
      <Link href="/people/attendance" className="text-sm text-muted hover:text-text">
        ← Attendance
      </Link>
      <div className="mt-2">
        <h1 className="text-xl font-semibold text-text">Biometric terminals</h1>
        <p className="mt-1 text-sm text-muted">
          eSSL and other ZKTeco-based terminals push their punches here. The first punch of a day becomes the check-in
          and the last the check-out — leave and manual corrections are never overwritten.
        </p>
      </div>

      <div className="mt-5">
        <BiometricDevices
          devices={devices}
          unmapped={unmapped}
          mapped={mapped}
          punches={punches}
          people={people.map((p) => ({ id: p.id, name: p.name }))}
          serverUrl={`${proto}://${host}`}
        />
      </div>
    </div>
  );
}
