import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { listAllContactsPaged } from "@/actions/contact";
import { listIndustries } from "@/actions/industry";
import { listDesignationsForSettings } from "@/actions/designation";
import { isModuleEnabled } from "@/actions/module";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ContactsTable } from "@/components/contacts/contacts-table";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { contactDesignationValues, relationshipTypeValues, relationshipTypeLabels, isContactDetailField } from "@/lib/validation/company";
import type { ContactDesignation, CompanyRelationshipType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { fieldsFor, listColumns } from "@/lib/custom-fields/server";
import { customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import { CustomFieldFilters } from "@/components/custom-fields/custom-field-filters";

export default async function ContactsLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    designation?: string;
    status?: string;
    relationshipType?: string;
    industryId?: string;
    primaryOnly?: string;
    page?: string;
    pageSize?: string;
  } & CustomFilterParams>;
}) {
  const enabled = await isModuleEnabled("contacts_library");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="contacts_library" />;
  }

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const customFilters = parseCustomFilters(params);
  // A designation from the list by its id; a link from before the list names one of the eight types.
  const byType = (contactDesignationValues as readonly string[]).includes(params.designation ?? "");
  const status = params.status === "left" || params.status === "all" ? params.status : "current";
  const [result, industries, designations] = await Promise.all([
    listAllContactsPaged({
      page,
      pageSize,
      search: params.q,
      designation: byType ? (params.designation as ContactDesignation) : undefined,
      designationId: !byType && params.designation ? params.designation : undefined,
      status,
      relationshipType: params.relationshipType as CompanyRelationshipType | undefined,
      industryId: params.industryId,
      primaryOnly: params.primaryOnly === "yes",
      customFilters,
    }),
    listIndustries(),
    listDesignationsForSettings(),
  ]);
  const user = await requireUser();
  const [customColumns, fieldFilters] = await Promise.all([
    contactColumns(user.id, result.rows),
    customFilterSetup("CONTACT", user.id, customFilters),
  ]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">{slot(await getWording(), "Contacts", "contact")}</h1>
          <p className="mt-1 text-sm text-muted">
            {result.total} contact(s) across every company
            {status === "current" ? " — not counting those who have left" : status === "left" ? " who have left their company" : ""}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search name, email, phone, or company…" />
        <SelectParamFilter
          paramName="relationshipType"
          label="Relationship"
          options={relationshipTypeValues.map((t) => ({ value: t, label: relationshipTypeLabels[t] }))}
        />
        <SelectParamFilter
          paramName="designation"
          label="Designation"
          options={designations.map((d) => ({ value: d.id, label: d.name }))}
        />
        <SelectParamFilter
          paramName="industryId"
          label="Industry"
          options={industries.map((i) => ({ value: i.id, label: i.name }))}
        />
        {/* Those still at their company unless asked — src/lib/contacts/left.ts. */}
        <SelectParamFilter
          paramName="status"
          label="Status"
          allLabel="Still there"
          options={[
            { value: "left", label: "Left the company" },
            { value: "all", label: "Everybody" },
          ]}
        />
        <SelectParamFilter
          paramName="primaryOnly"
          label="Primary only"
          allLabel="All contacts"
          options={[{ value: "yes", label: "Primary only" }]}
        />
        <CustomFieldFilters setup={fieldFilters} />
      </div>

      <div className="mt-6">
        <ContactsTable contacts={result.rows} customColumns={customColumns} canMeet={await isModuleEnabled("calendar")} />
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={result.total}
        totalPages={totalPages(result.total, pageSize)}
        pageSizes={PAGE_SIZES}
      />
    </div>
  );
}

/**
 * The workspace's own fields marked "a column in the list" (src/lib/custom-fields) — this table has no
 * column picker, so those and only those. On a reseller's end customer the contact-detail ones
 * (`isContactDetailField`) stay blank, as its email and phone do (src/lib/reseller.ts) — left out
 * here, so they never reach the browser.
 */
async function contactColumns(userId: string, rows: { id: string; detailsRedacted: boolean }[]) {
  const [columns, { visible }] = await Promise.all([listColumns("CONTACT", userId, rows.map((r) => r.id), { listedOnly: true }), fieldsFor("CONTACT", userId)]);
  const hidden = new Set(visible.filter((d) => isContactDetailField(d.type)).map((d) => d.key));
  if (hidden.size === 0 || !rows.some((r) => r.detailsRedacted)) return columns;
  const texts: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    const own = columns.texts[r.id] ?? {};
    texts[r.id] = r.detailsRedacted ? Object.fromEntries(Object.entries(own).filter(([key]) => !hidden.has(key))) : own;
  }
  return { columns: columns.columns, texts };
}
