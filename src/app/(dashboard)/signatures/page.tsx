import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import { signatureText } from "@/lib/signatures/render";
import { loadPerson, personSignature, signatureContext } from "@/lib/signatures/person";
import { readSignatureSettings } from "@/lib/signatures/sync";
import { Badge, Card } from "@/components/ui/card";
import { SignatureCopy } from "@/components/signatures/signature-copy";

const SUITE: Record<string, string> = { GOOGLE: "Gmail", ZOHO: "Zoho Mail" };

const PASTE_STEPS: { app: string; steps: string[] }[] = [
  { app: "Outlook (new, and on the web)", steps: ["Settings → Account → Signatures.", "+ New signature, paste, choose it for new messages and replies, Save."] },
  { app: "Outlook for Windows (classic)", steps: ["File → Options → Mail → Signatures → New.", "Paste, pick it for new messages and replies, OK."] },
  { app: "Gmail", steps: ["Settings → See all settings → General → Signature → Create new.", "Paste, choose it for new emails and replies, Save changes."] },
  { app: "Apple Mail", steps: ["Mail → Settings → Signatures, then +.", "Untick “Always match my default message font”, then paste."] },
];

/**
 * My email signature: the company's signature, drawn from this person's record — and whether it is in
 * their Gmail or Zoho Mail yet, or what Outlook's add-in last fetched. Where the company hasn't
 * connected its mail, they copy it and paste it in themselves.
 */
export default async function MySignaturePage() {
  if (!(await isModuleEnabled("signatures"))) return <ModuleDisabledNotice moduleKey="signatures" />;
  const me = await requireUser();
  const [person, ctx, settings, row, manages] = await Promise.all([
    loadPerson(me.id),
    signatureContext(),
    readSignatureSettings(),
    db.signatureSync.findUnique({ where: { userId: me.id } }),
    hasEffectivePermission(me.id, "signatures.manage"),
  ]);
  if (!person) return null;
  const sig = await personSignature(person, ctx);
  const outlookOn = !!settings?.outlookOn;
  const outlook = outlookOn ? await db.signatureOutlook.findUnique({ where: { userId: me.id } }) : null;
  const clock = await workspaceClock();
  const suite = settings?.provider ? SUITE[settings.provider] : null;
  const current = !!row && row.status === "SYNCED" && row.syncedHash === sig.hash && row.provider === settings?.provider;

  return (
    <div className="animate-fade-rise space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-text">My email signature</h1>
        {manages && (
          <Link href="/signatures/manage" className="text-sm text-brand hover:underline">
            Manage the company&apos;s signatures
          </Link>
        )}
      </div>

      <Card className="space-y-2 px-4 py-3 text-sm">
        {suite && (
          <div className="flex flex-wrap items-center gap-2">
            {current ? (
              <>
                <Badge tone="green">In your {suite}</Badge>
                <span className="text-muted">Since {clock.dateTimeShort(row!.syncedAt)}. It changes there when your details do.</span>
              </>
            ) : row?.status === "FAILED" ? (
              <>
                <Badge tone="red">Not in your {suite} yet</Badge>
                <span className="text-muted">{row.lastError} It is tried again on its own.</span>
              </>
            ) : row?.status === "SKIPPED" ? (
              <>
                <Badge>Not for {suite}</Badge>
                <span className="text-muted">{row.lastError} Copy it below and paste it into the mail program you use.</span>
              </>
            ) : (
              <>
                <Badge tone="amber">On its way to your {suite}</Badge>
                <span className="text-muted">It goes in within a few minutes.</span>
              </>
            )}
          </div>
        )}
        {outlookOn && (
          <div className="flex flex-wrap items-center gap-2">
            {outlook && outlook.hash === sig.hash ? (
              <>
                <Badge tone="green">In your Outlook</Badge>
                <span className="text-muted">Outlook last put it in {clock.dateTimeShort(outlook.fetchedAt)}, and puts it into every new message.</span>
              </>
            ) : outlook ? (
              <>
                <Badge tone="amber">Outlook has an older one</Badge>
                <span className="text-muted">Your next new message in Outlook gets this one.</span>
              </>
            ) : (
              <>
                <Badge>Outlook add-in</Badge>
                <span className="text-muted">Outlook puts this into every new message once your company&apos;s add-in reaches you — that can take a few hours after it is set up.</span>
              </>
            )}
          </div>
        )}
        {!suite && !outlookOn && <p className="text-muted">Your company hasn&apos;t connected its mail yet, so copy your signature and paste it into your mail program.</p>}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <SignatureCopy html={sig.html} text={signatureText(sig.details, null)} />
          {sig.reply && sig.reply.html !== sig.html && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-text">On replies and forwards</h2>
              <p className="text-sm text-muted">
                A shorter one, for the replies-and-forwards signature in your mail program{outlookOn ? " — Outlook puts it in by itself" : ""}.
              </p>
              <SignatureCopy html={sig.reply.html} text={sig.reply.text} />
            </div>
          )}
        </div>
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Your name, title, phone and photo come from your profile — change them there and your signature follows. The design is your company&apos;s.
          </p>
          <div className="rounded-xl border border-line bg-surface">
            <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-text">Pasting it in yourself</h2>
            {PASTE_STEPS.map((s) => (
              <details key={s.app} className="border-b border-line last:border-b-0">
                <summary className="cursor-pointer px-4 py-2.5 text-sm text-text">{s.app}</summary>
                <ol className="list-decimal space-y-1 px-4 pb-3 pl-9 text-sm text-muted">
                  {s.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
