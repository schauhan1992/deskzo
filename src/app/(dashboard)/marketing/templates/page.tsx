import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listTemplates } from "@/actions/marketing";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { Badge, Card } from "@/components/ui/card";
import { TemplateEditor } from "@/components/marketing/template-editor";
import { TOPICS } from "@/lib/marketing/topics";
import { requiredFields } from "@/lib/marketing/merge";
import { formatDate } from "@/lib/utils";

export default async function TemplatesPage() {
  const enabled = await isModuleEnabled("marketing");
  if (!enabled) return <ModuleDisabledNotice moduleKey="marketing" />;

  const user = await currentUser();
  const [templates, canManage] = await Promise.all([
    listTemplates(),
    user ? hasEffectivePermission(user.id, "marketing.manage") : Promise.resolve(false),
  ]);

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Templates</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            The wording. A template is frozen onto each message as it is queued, so editing one next month never
            rewrites what went out last month.
          </p>
        </div>
        {canManage && <TemplateEditor />}
      </div>

      <div className="mt-5 space-y-3">
        {templates.length === 0 ? (
          <Card className="px-4 py-12 text-center text-sm text-subtle">
            No templates yet. A campaign needs one — it is the thing that actually gets sent.
          </Card>
        ) : (
          templates.map((t) => {
            const required = requiredFields(`${t.subject ?? ""} ${t.body}`);
            return (
              <Card key={t.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-text">{t.name}</span>
                      <Badge tone="blue">{t.channel === "WHATSAPP" ? "WhatsApp" : "Email"}</Badge>
                      <Badge tone="default">{TOPICS.find((x) => x.key === t.topic)?.label ?? t.topic}</Badge>
                      {!t.active && <Badge tone="amber">Retired</Badge>}
                    </div>
                    {t.subject && <p className="text-xs text-muted">{t.subject}</p>}
                    <p className="text-[11px] text-subtle">
                      {t.createdBy.name} · updated {formatDate(t.updatedAt)}
                      {required.length > 0 && (
                        <> · every recipient must have: {required.map((r) => `{{${r}}}`).join(", ")}</>
                      )}
                    </p>
                  </div>
                  {canManage && <TemplateEditor template={t} />}
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
