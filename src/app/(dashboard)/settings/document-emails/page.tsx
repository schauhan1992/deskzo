import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { getDocumentEmailTemplates } from "@/actions/document-mail";
import { DocumentEmailTemplates } from "@/components/settings/document-email-templates";

export const metadata = { title: "Document emails" };

/** The wording that goes with an emailed proposal, proforma, tax invoice or credit note. */
export default async function DocumentEmailsSettingsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Document emails</h1>
        <p className="mt-2 text-sm text-muted">Only somebody who can change organisation settings can change this wording.</p>
      </div>
    );
  }
  const templates = await getDocumentEmailTemplates();

  return (
    <div className="max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Document emails</h1>
        <p className="mt-1 text-sm text-muted">
          The subject and message filled in when somebody presses Mail on a proposal, proforma, tax invoice or credit note. It goes from their own Outlook,
          with the document attached as a PDF.
        </p>
      </div>
      <DocumentEmailTemplates templates={templates ?? []} />
    </div>
  );
}
