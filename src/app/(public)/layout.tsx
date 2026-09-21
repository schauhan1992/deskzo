/**
 * A shell for the handful of pages somebody reaches without signing in.
 *
 * Separate from the dashboard layout because there is no sidebar, no notification bell and no
 * session to read — and separate from the print layout because these are screens people fill in
 * rather than pages they print.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-bg px-4 py-10">{children}</div>;
}
