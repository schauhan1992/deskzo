import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getPerson, hrCapabilities } from "@/actions/hr";
import { getSettlement } from "@/actions/settlement";
import { Card } from "@/components/ui/card";
import { SettlementView } from "@/components/hr/settlement-view";

export default async function SettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("payroll");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payroll" />;

  const { id } = await params;
  const [person, caps, settlement] = await Promise.all([getPerson(id), hrCapabilities(), getSettlement(id)]);
  if (!person) notFound();

  const isSelf = caps.userId === person.id;
  if (!caps.payroll && !isSelf) {
    return (
      <Card className="px-4 py-12 text-center text-sm text-subtle">
        A settlement is a payment — only payroll, or the person it belongs to, can see one.
      </Card>
    );
  }

  return (
    <div className="animate-fade-rise">
      <Link href={`/people/${person.id}`} className="text-sm text-muted hover:text-text">
        ← {person.name}
      </Link>
      <div className="mt-3">
        <SettlementView
          settlement={settlement}
          userId={person.id}
          userName={person.name}
          canManage={caps.payroll}
        />
      </div>
    </div>
  );
}
