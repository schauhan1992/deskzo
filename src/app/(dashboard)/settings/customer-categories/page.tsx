import { listCustomerCategories } from "@/actions/customer-category";
import { SettingsPage } from "@/components/settings/settings-page";
import { CategoriesManager } from "@/components/customers/categories-manager";

/**
 * The customer categories — see src/lib/customers/categories.ts. What is decided here is what every
 * chip beside a customer's name says, everywhere.
 */
export default async function Page() {
  const categories = await listCustomerCategories();
  return (
    <SettingsPage
      settingsKey="customer-categories"
      description="Group customers so everybody can tell who they are dealing with. Each category has an icon and a colour shown beside the customer's name, and a note on how to treat them; a sub-category can borrow its category's icon and colour and adds its own note."
    >
      <CategoriesManager categories={categories} />
    </SettingsPage>
  );
}
