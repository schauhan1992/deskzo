import { listIndustries } from "@/actions/industry";
import { listBrands } from "@/actions/brand";
import { listProjectTypes } from "@/actions/project-document";
import { listCredentialTags } from "@/actions/vault";
import { SettingsPage } from "@/components/settings/settings-page";
import { IndustriesManager } from "@/components/settings/industries-manager";
import { BrandsManager } from "@/components/settings/brands-manager";
import { ProjectTypesManager } from "@/components/settings/project-types-manager";
import { CredentialTagsManager } from "@/components/settings/credential-tags-manager";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * The lists the rest of the app picks from.
 *
 * Together on one page because they are the same kind of thing — a short editable vocabulary that
 * something else has a dropdown of — and separately they would each be a page with four rows on it.
 */
export default async function Page() {
  const [industries, brands, projectTypes, credentialTags] = await Promise.all([
    listIndustries(),
    listBrands(),
    listProjectTypes(true),
    listCredentialTags(true),
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
          <p className="mb-3 text-sm text-muted">
            Who makes the products you sell, and the lines within each brand — Microsoft &rarr; Microsoft 365,
            Autodesk &rarr; AutoCAD. Items pick a brand and then one of its families.
          </p>
          <BrandsManager brands={brands} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Project types</CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted">The kinds of work you deliver, and the standard plan each one starts from.</p>
          <ProjectTypesManager types={projectTypes} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Credential vault tags</CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted">The categories the vault files logins under.</p>
          <CredentialTagsManager tags={credentialTags} />
        </CardContent>
      </Card>
    </SettingsPage>
  );
}
