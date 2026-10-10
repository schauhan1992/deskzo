import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { getBranding } from "@/actions/branding";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { cardContacts, myCardView } from "@/lib/cards/views";
import { RECORD_FIELDS } from "@/lib/cards/fields";
import { Card } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { CardFace } from "@/components/cards/card-face";
import { CardShare } from "@/components/cards/card-share";
import { MyCardEditor } from "@/components/cards/my-card-editor";
import { CardContactsList } from "@/components/cards/card-contacts-list";
import { CardNumbersStrip } from "@/components/cards/card-numbers";

/**
 * My card: the card as people see it, its QR and link, what it has done this week, the holder's own
 * choices, and everyone who shared their details back.
 *
 * Reached from the menu only by somebody with a live card (NavItem.onlyFor); anybody else who opens
 * it is told how cards are issued rather than shown an empty editor.
 */
export default async function MyCardPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  if (!(await isModuleEnabled("cards"))) return <ModuleDisabledNotice moduleKey="cards" />;
  const me = await requireUser();
  const { tab: rawTab } = await searchParams;
  const tab = rawTab === "contacts" ? "contacts" : "card";
  const [view, manages, branding] = await Promise.all([myCardView(me.id), hasEffectivePermission(me.id, "cards.manage"), getBranding()]);

  if (!view) {
    return (
      <div className="animate-fade-rise space-y-4">
        <h1 className="text-xl font-semibold text-text">My card</h1>
        <Card className="px-6 py-10 text-center">
          <p className="text-sm font-medium text-text">You don&apos;t have a digital card yet.</p>
          <p className="mt-1 text-sm text-muted">
            {manages ? (
              <>
                You can issue one to yourself, and to anybody else, from{" "}
                <Link href="/cards/manage" className="text-brand hover:underline">
                  Digital cards
                </Link>
                .
              </>
            ) : (
              "HR or an admin issues them. Ask them for one."
            )}
          </p>
        </Card>
      </div>
    );
  }

  const contacts = tab === "contacts" ? await cardContacts({ ownerUserId: me.id }) : [];
  const logoUrl = view.template.showLogo && branding.logoDataUrl ? "/api/brand/mark" : null;
  const photoUrl = view.card.showPhoto && view.photoVersion ? `/api/users/${me.id}/photo?v=${view.photoVersion}` : null;
  const hideable = view.template.recordFields
    .filter((f) => f.show && !f.locked)
    .map((f) => ({ key: f.key, label: RECORD_FIELDS.find((r) => r.key === f.key)?.label ?? f.key }));

  return (
    <div className="animate-fade-rise space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-text">My card</h1>
        {manages && (
          <Link href="/cards/manage" className="text-sm text-brand hover:underline">
            Manage everybody&apos;s cards
          </Link>
        )}
      </div>

      {!view.live && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          Your card is switched off. Its link shows your company&apos;s details instead of yours until it&apos;s switched back on.
        </Card>
      )}

      <TabNav
        tabs={[
          { key: "card", label: "Card" },
          { key: "contacts", label: "Contacts", count: view.ever.shared },
        ]}
        activeKey={tab}
        basePath="/cards"
      />

      {tab === "contacts" ? (
        <CardContactsList rows={contacts} showHolder={false} empty="Nobody has shared their details from your card yet. The form is under your card, on its page." />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <div className="space-y-4">
            <CardFace card={view.card} color={view.template.color} layout={view.template.layout} logoUrl={logoUrl} photoUrl={photoUrl} inert />
            <CardNumbersStrip week={view.week} ever={view.ever} />
          </div>
          <div className="space-y-6">
            <CardShare url={view.url} qr={view.qr} logoUrl={logoUrl} name={view.card.name} live={view.live} />
            <MyCardEditor
              hideable={hideable}
              hidden={view.hidden}
              allowOwnFields={view.template.allowOwnFields}
              ownFields={view.ownFields}
            />
          </div>
        </div>
      )}
    </div>
  );
}
