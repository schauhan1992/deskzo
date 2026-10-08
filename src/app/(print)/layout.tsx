/**
 * A bare shell for printable documents: no sidebar, no header, no theme. Whatever the viewer's
 * dark-mode preference, an invoice renders as black on white, because that's what comes out of the
 * printer and what gets emailed to a customer.
 *
 * Printed and made into a PDF on A4 with even 10 mm margins (owner, 8 Oct 2026). Without a page size,
 * Chrome's PDF used its own default — US Letter — and the browser's print dialog whatever it last had,
 * so the same invoice came out at different widths. A row is never split across two pages.
 */
const PRINT_PAGE = `
@page { size: A4; margin: 10mm; }
@media print {
  html, body { background: #fff !important; }
  tr, .print-keep { break-inside: avoid; }
}
`;

export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-100 py-6 print:bg-white print:py-0">
      <style>{PRINT_PAGE}</style>
      {children}
    </div>
  );
}
