import { notFound } from "next/navigation";
import { getLetter } from "@/actions/employee-docs";
import { getOrganisation, foreignCountry } from "@/lib/organisation";
import { getBranding } from "@/actions/branding";
import { PrintButton } from "@/components/documents/print-button";
import { formatDate } from "@/lib/utils";
import { letterTypeLabels, type LetterPayload } from "@/lib/hr/letters";

/**
 * A letter on company paper.
 *
 * The body is read from the row, not re-rendered from the employee record — a letter is a statement
 * made on a particular day, and an experience letter reprinted after somebody's next appraisal must
 * still say what it said when it was signed. See the note in src/lib/hr/letters.ts.
 *
 * The letterhead around it is the opposite: it comes from settings as they are *now*, because a
 * company that has moved office wants its current address on a reprint. The distinction is between
 * what the letter asserts, which is frozen, and whose paper it is on, which is not.
 *
 * A REVOKED letter still prints, with the fact stamped across it. Withdrawing a letter does not
 * make the reference number somebody was given disappear, and a number that resolves to nothing is
 * worse than one that resolves to "this was withdrawn".
 */
export default async function PrintLetterPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const [{ id }, { embed }] = await Promise.all([params, searchParams]);
  const [letter, org, branding] = await Promise.all([getLetter(id), getOrganisation(), getBranding()]);
  if (!letter) notFound();

  const payload = letter.payload as unknown as LetterPayload;
  const revoked = letter.status === "REVOKED";
  // The employer's mark if one is set, otherwise the app's — better a logo than a blank space.
  const logo = org.letterheadLogoDataUrl || branding.logoDataUrl;
  const addressLines = [
    org.addressLine1,
    org.addressLine2,
    [org.city, org.state, org.pincode, foreignCountry(org)].filter(Boolean).join(", ") || null,
  ].filter(Boolean) as string[];
  const contactLine = [org.phone, org.email].filter(Boolean).join("  ·  ");

  return (
    <div className="mx-auto max-w-3xl bg-white p-12 text-[13px] leading-relaxed text-neutral-900 shadow-sm print:p-0 print:shadow-none">
      {embed !== "1" && (
        <div className="mb-6 flex justify-end print:hidden">
          <PrintButton />
        </div>
      )}

      {revoked && (
        <div className="mb-6 border-2 border-red-700 px-4 py-2 text-center text-sm font-bold uppercase tracking-widest text-red-700">
          Withdrawn — this letter is no longer valid
        </div>
      )}

      <header className="flex items-start justify-between gap-6 border-b-2 border-neutral-800 pb-4">
        <div className="min-w-0">
          <h1 className="text-lg font-bold uppercase tracking-wide">{org.legalName || payload.companyName}</h1>
          {org.tradeName && org.tradeName !== org.legalName && (
            <p className="text-xs text-neutral-600">{org.tradeName}</p>
          )}
          {addressLines.map((line) => (
            <p key={line} className="mt-0.5 text-xs text-neutral-600">
              {line}
            </p>
          ))}
          {contactLine && <p className="mt-0.5 text-xs text-neutral-600">{contactLine}</p>}
          {org.gstin && <p className="text-xs text-neutral-600">GSTIN {org.gstin}</p>}
        </div>
        {logo && (
          /* eslint-disable-next-line @next/next/no-img-element -- a data URL, printed as-is */
          <img src={logo} alt="" className="h-14 w-auto shrink-0 object-contain" />
        )}
      </header>

      <div className="mt-6 flex items-start justify-between text-xs">
        <span className="font-mono text-neutral-600">{letter.letterNumber}</span>
        <span className="text-neutral-600">{formatDate(letter.issuedOn)}</span>
      </div>

      <p className="mt-6 text-sm font-semibold underline">{letter.subject}</p>

      {/* The body is stored as plain paragraphs so HR can edit it before issue; preserving the
          newlines is what makes that edit look the same on paper as it did in the textarea. */}
      <div className="mt-5 whitespace-pre-wrap">{letter.body}</div>

      {/* The signature block. The names come from the frozen payload, because "signed by" is part of
          what the letter asserts — reprinting it after the signatory has left must not silently
          reassign their signature to their successor. Only the image is read from settings. */}
      {(payload.signatoryName || org.signatureDataUrl) && (
        <div className="mt-10 break-inside-avoid">
          {org.signatureDataUrl && (
            /* eslint-disable-next-line @next/next/no-img-element -- a data URL, printed as-is */
            <img src={org.signatureDataUrl} alt="" className="mb-1 h-14 w-auto object-contain" />
          )}
          <div className="w-56 border-t border-neutral-400 pt-1">
            <p className="text-sm font-medium">{payload.signatoryName ?? "—"}</p>
            {payload.signatoryTitle && <p className="text-xs text-neutral-600">{payload.signatoryTitle}</p>}
          </div>
        </div>
      )}

      <footer className="mt-12 border-t border-neutral-300 pt-3 text-[10px] text-neutral-500">
        {org.letterheadFooter && <p className="mb-1 whitespace-pre-wrap">{org.letterheadFooter}</p>}
        <p>
          {letterTypeLabels[letter.type]} · {letter.letterNumber}
          {letter.issuedBy && ` · issued by ${letter.issuedBy.name}`}
          {letter.status === "DRAFT" && " · DRAFT, not yet issued"}
        </p>
      </footer>
    </div>
  );
}
