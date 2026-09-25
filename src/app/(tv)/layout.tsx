/**
 * The screens left running on a wall — no sidebar, no bell, nothing to click. Dark whatever the
 * theme, because a bright white screen in a sales bay is a lamp, not a display.
 *
 * Still behind a sign-in and the access gate like every other page: a TV is signed in as somebody,
 * and a revoked TV stops showing the board.
 */
export default function TvLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[#0b1020] text-white">{children}</div>;
}
