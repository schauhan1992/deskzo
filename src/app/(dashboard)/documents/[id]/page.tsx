import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { mayAccess } from "@/lib/authz/access";
import { DocumentDetail } from "@/components/documents/document-detail";
import { viewerHas } from "@/actions/permission";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, requireUser()]);
  if (!(await viewerHas("documents.view"))) notFound();

  /**
   * The access engine answers whether this document is in reach, asked of the same fragment the list
   * uses — a missing id answers no as well. With no level set it follows `company`, the other party
   * (the customer on a sales document, the vendor on a purchase one); `leadId` is the other route to
   * a company here and is deliberately not used: it is nullable, so half the documents would fall
   * through it, and it reaches the same company anyway.
   *
   * A purchase bill's party is a vendor and so has no account manager, which hides it from anyone
   * without `companies.viewAll` — correct, because purchasing and accounts both hold that key.
   */
  if (!(await mayAccess(user.id, "documents", "view", id))) notFound();

  return <DocumentDetail id={id} />;
}
