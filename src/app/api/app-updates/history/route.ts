import { NextResponse } from "next/server";
import { isAppUpdatePlatform } from "@/lib/app-updates/protocol";
import { appUpdateHistory, updatesNotMigrated } from "@/lib/app-updates/store";

export const dynamic = "force-dynamic";

/**
 * What's been published for the phone app, newest first (owner, 23 Oct 2026) — for `npm run app:update -- list`, and
 * for a rollback, which republishes an earlier update's files. Nothing here a phone isn't served anyway: the updates
 * themselves, which build each is for, and the commit it was made from.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") ?? "android";
  const runtimeVersion = url.searchParams.get("runtime-version");
  if (!isAppUpdatePlatform(platform)) return NextResponse.json({ error: "No such platform." }, { status: 400 });
  try {
    const rows = await appUpdateHistory(platform, runtimeVersion);
    return NextResponse.json(
      { updates: rows.map((r) => ({ id: r.id, kind: r.kind, runtimeVersion: r.runtimeVersion, createdAt: r.createdAt.toISOString(), publishedAt: r.publishedAt.toISOString(), commit: r.commit, body: r.kind === "UPDATE" ? r.body : null })) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (updatesNotMigrated(err)) return NextResponse.json({ updates: [] }, { headers: { "cache-control": "no-store" } });
    throw err;
  }
}
