/**
 * A bare shell for printable documents: no sidebar, no header, no theme. Whatever the viewer's
 * dark-mode preference, an invoice renders as black on white, because that's what comes out of the
 * printer and what gets emailed to a customer.
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-neutral-100 py-6 print:bg-white print:py-0">{children}</div>;
}
