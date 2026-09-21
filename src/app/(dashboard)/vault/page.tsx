import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listVault, vaultOptions } from "@/actions/vault";
import { VAULT_PAGE_SIZES } from "@/lib/vault/policy";
import { VaultList } from "@/components/vault/vault-list";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { PersonParamFilter } from "@/components/ui/person-param-filter";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import Link from "next/link";
import { Archive } from "lucide-react";
import { Pagination } from "@/components/ui/pagination";
import { Card, CardContent } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";

/**
 * The company's own logins.
 *
 * Everything on this page comes from `listVault`, which composes the one visibility filter. There
 * is no second query and no "just for the count" shortcut — a number that outruns the list it sits
 * above is the same disclosure, only quieter.
 */
export default async function VaultPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    categoryId?: string;
    ownerId?: string;
    ownership?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  if (!(await isModuleEnabled("vault"))) return <ModuleDisabledNotice moduleKey="vault" />;

  const params = await searchParams;
  const me = await requireUser();
  const [result, options, mode, canSeeArchive] = await Promise.all([
    listVault({
      q: params.q,
      categoryId: params.categoryId,
      ownerId: params.ownerId,
      ownership: params.ownership === "CLIENT" || params.ownership === "OURS" ? params.ownership : undefined,
      page: Number(params.page) || 1,
      pageSize: Number(params.pageSize) || 25,
    }),
    vaultOptions(),
    getViewMode("vault"),
    // The same permission the archive action checks. The link is a convenience, not the guard.
    hasEffectivePermission(me.id, "vault.viewAll"),
  ]);

  return (
    <div className="animate-fade-rise">
      {/*
        Title, filters and the new-record button on one line. The caveat below is worth saying once
        and not worth three lines of the screen every time somebody opens the page — it is a fact
        about the system, not a notice that needs re-reading, so it folds away.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold text-text">Credential vault</h1>
        <SearchParamInput paramName="q" placeholder="Search name, username, email or URL…" />
        <SelectParamFilter
          paramName="categoryId"
          allLabel="Any category"
          options={options.categories.map((c) => ({ value: c.id, label: c.name }))}
        />
        <SelectParamFilter
          paramName="ownership"
          allLabel="Ours and clients&apos;"
          options={[
            { value: "OURS", label: "Ours" },
            { value: "CLIENT", label: "A client&apos;s" },
          ]}
        />
        {/* Typed, not scrolled — a hundred colleagues do not fit in a dropdown. */}
        <PersonParamFilter
          paramName="ownerId"
          placeholder="Any owner"
          people={options.users.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            photoUpdatedAt: u.photoUpdatedAt,
          }))}
        />
        <ViewModeToggle viewKey="vault" mode={mode} />
        {canSeeArchive && (
          <Link
            href="/vault/archive"
            className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"
          >
            <Archive className="h-4 w-4" />
            Archive
          </Link>
        )}
      </div>

      <Disclosure summary="Your own logins and the ones shared with you — how this is stored">
        Encrypted at rest; opening one needs your password and is recorded on the record. Anyone with access to
        the server can still decrypt these — this is a shared cupboard with a good lock, not a hardware vault.
      </Disclosure>

      <div className="mt-3">
        {result.ok ? (
          <>
            <VaultList
              rows={result.data.rows}
              options={options}
              pinnedCount={result.data.pinnedCount}
              expiringCount={result.data.expiringCount}
              mode={mode}
              total={result.data.total}
            />
            {result.data.total > 0 && (
              <div className="mt-4">
                <Pagination
                  page={result.data.page}
                  pageSize={result.data.pageSize}
                  total={result.data.total}
                  totalPages={result.data.totalPages}
                  pageSizes={VAULT_PAGE_SIZES}
                  label="credentials"
                />
              </div>
            )}
          </>
        ) : (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted">{result.error}</CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
