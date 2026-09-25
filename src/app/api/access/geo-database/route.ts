import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { NextResponse } from "next/server";
import { Reader } from "mmdb-lib";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { geoDirectory, reloadGeoDatabase } from "@/lib/access/geo";
import { logActivity } from "@/lib/activity";

/**
 * Replaces the IP location database with this month's file.
 *
 * The body is the file — `.mmdb`, or `.mmdb.gz` as DB-IP and MaxMind publish it, unzipped on the way
 * in — streamed to disk beside the current one and only swapped in once it has been opened and found
 * to be a city database. A wrong file therefore leaves the working one alone. The old file is removed
 * afterwards: at ~125 MB, keeping every month is a disk filling up for nothing.
 *
 * Under /api, so outside the proxy's gate; `currentUser` applies it instead.
 */

const MAX_BYTES = 1024 * 1024 * 1024;

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await can(user.id, "security.manage"))) return NextResponse.json({ error: "You can't change the location database." }, { status: 403 });
  if (!request.body) return NextResponse.json({ error: "No file was sent." }, { status: 400 });

  const name = decodeURIComponent(request.headers.get("x-file-name") ?? "upload.mmdb");
  const gzipped = /\.gz$/i.test(name);
  if (!/\.mmdb(\.gz)?$/i.test(name)) return NextResponse.json({ error: "Send the .mmdb or .mmdb.gz file." }, { status: 400 });

  const dir = geoDirectory();
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const partial = path.join(dir, `upload-${Date.now().toString(36)}.part`);
  const final = path.join(dir, `city-${stamp}-${Date.now().toString(36)}.mmdb`);

  let received = 0;
  try {
    const source = Readable.fromWeb(request.body as import("node:stream/web").ReadableStream);
    const limit = async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        received += chunk.length;
        if (received > MAX_BYTES) throw new Error("TOO_LARGE");
        yield chunk;
      }
    };
    if (gzipped) await pipeline(source, createGunzip(), limit, createWriteStream(partial));
    else await pipeline(source, limit, createWriteStream(partial));
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {});
    return NextResponse.json(
      { error: (err as Error).message === "TOO_LARGE" ? "That file is far larger than a location database." : "The upload didn't finish, or the file isn't gzip. Nothing was changed." },
      { status: 400 },
    );
  }

  let type = "";
  try {
    const reader = new Reader(await readFile(partial));
    type = reader.metadata.databaseType;
    if (!/city/i.test(type)) throw new Error(`a ${type} database`);
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {});
    return NextResponse.json({ error: `That isn't a city location database (${(err as Error).message}). Nothing was changed.` }, { status: 400 });
  }

  await rename(partial, final);
  for (const old of await readdir(dir)) {
    const file = path.join(dir, old);
    if (file !== final && /\.mmdb$/i.test(old)) await rm(file, { force: true }).catch(() => {});
  }
  reloadGeoDatabase();
  await logActivity({ kind: "SECURITY_POLICY_CHANGED", summary: `Replaced the IP location database (${type}, ${Math.round(received / 1048576)} MB)` });
  return NextResponse.json({ ok: true, type });
}
