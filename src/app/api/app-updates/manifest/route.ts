import { NextResponse } from "next/server";
import { answerFor, isAppUpdatePlatform, noUpdate } from "@/lib/app-updates/protocol";
import { latestAppUpdate, updatesNotMigrated } from "@/lib/app-updates/store";

export const dynamic = "force-dynamic";

/**
 * Where the Deskzo phone app asks, at each launch, whether its screens have a newer version (owner, 23 Oct 2026 —
 * expo-updates, mobile/app.config.ts `updates.url`). On the platform's own address (deskzo.com) only, for every
 * workspace's phones alike: it reads no workspace and is told only which build and update the phone runs.
 *
 * The answer is the newest update published for the phone's native build, signed — or nothing (204) when it runs
 * that already, when nothing's been published, or before the control plane has the tables.
 */
export async function GET(req: Request) {
  const platform = req.headers.get("expo-platform") ?? new URL(req.url).searchParams.get("platform");
  const runtimeVersion = req.headers.get("expo-runtime-version") ?? new URL(req.url).searchParams.get("runtime-version");
  if (!isAppUpdatePlatform(platform) || !runtimeVersion || runtimeVersion.length > 200) {
    return NextResponse.json({ error: "Say which platform and native build this is." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  try {
    const latest = await latestAppUpdate(platform, runtimeVersion);
    return answerFor(latest, { currentUpdateId: req.headers.get("expo-current-update-id"), embeddedUpdateId: req.headers.get("expo-embedded-update-id") });
  } catch (err) {
    if (updatesNotMigrated(err)) return noUpdate();
    throw err;
  }
}
