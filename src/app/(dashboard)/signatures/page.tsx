import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getMySignature } from "@/actions/signatures";
import { MySignatureView } from "@/components/signatures/my-signature";

export const metadata = { title: "Email signature" };

/**
 * Your email signature (docs/digital-cards-and-signatures.md §5): built from your record, in the
 * company's template or one you pick, ready to copy into your mail. The company's settings below it
 * for whoever may change them.
 */
export default async function SignaturePage() {
  if (!(await isModuleEnabled("signatures"))) return <ModuleDisabledNotice moduleKey="signatures" />;
  const result = await getMySignature();
  if (!result.ok) notFound();
  return <MySignatureView data={result.data} />;
}
