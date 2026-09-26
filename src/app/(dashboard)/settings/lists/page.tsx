import Link from "next/link";
import { listIndustries } from "@/actions/industry";
import { listProjectTypes } from "@/actions/project-document";
import { listCredentialTags } from "@/actions/vault";
import { SettingsPage } from "@/components/settings/settings-page";
import { IndustriesManager } from "@/components/settings/industries-manager";
import { ProjectTypesManager } from "@/components/settings/project-types-manager";
import { CredentialTagsManager } from "@/components/settings/credential-tags-manager";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { isModuleEntitled } from "@/lib/modules-access";

/**
 * The lists the rest of the app picks from.
 *
 * Together on one page because they are the same kind of thing — a short editable vocabulary that
 * something else has a dropdown of — and separately they would each be a page with four rows on it.
 */
export default async function Page() {
  // Project types and vault tags belong to their modules; a plan without one shows no list for it.
  const [hasProjects, hasVault] = await Promise.all([isModuleEntitled("projects"), isModuleEntitled("vault")]);
  const [industries, projectTypes, credentialTags] = await Promise.all([
    listIndustries(),
    hasProjects ? listProjectTypes(true) : null,
    hasVault ? listCredentialTags(true) : null,
  ]);

  return (
    <SettingsPage
      title="Lists"
      description="The vocabularies the rest of the app picks from. Each one is a dropdown somewhere — add whatever this company actually deals in."
      settingsKey="lists"
    >
      <Card>
        <CardHeader className="text-sm font-medium text-text">Industries</CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted">What a company does, as offered on its record.</p>
          <IndustriesManager industries={industries} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Brands &amp; product families</CardHeader>
        <CardContent>
          {/* Moved, not removed: a catalogue of a thousand brands is searched and paged through with
              the items it describes. Left here as a signpost for anyone who knows the old place. */}
          <p className="text-sm text-muted">
            Brands and their product families now live with the catalogue, where they can be searched and paged
            through —{" "}
            <Link href="/items/brands" className="font-medium text-text underline underline-offset-2">
              Items &amp; Inventory &rarr; Brands &amp; families
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      {projectTypes && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Project types</CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted">The kinds of work you deliver, and the standard plan each one starts from.</p>
            <ProjectTypesManager types={projectTypes} />
          </CardContent>
        </Card>
      )}

      {credentialTags && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Credential vault tags</CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted">The categories the vault files logins under.</p>
            <CredentialTagsManager tags={credentialTags} />
          </CardContent>
        </Card>
      )}
    </SettingsPage>
  );
}
