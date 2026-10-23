/**
 * check:app-updates — over-the-air updates of the Deskzo phone app (src/lib/app-updates, src/app/api/app-updates;
 * owner, 23 Oct 2026), through their real route handlers against this installation's control plane.
 *
 *   · An update signed with a key of the suite's own is kept, and a phone on its native build is handed it — the
 *     manifest byte for byte, signed, in the multipart answer of the Expo Updates protocol; one already running it,
 *     or on another build, is told there's nothing (204).
 *   · Its files come back by their hashes, cacheable for good; an unknown hash is a 404.
 *   · Nothing unsigned is kept: the publish address refuses the suite's key (only Deskzo's certificate is trusted),
 *     and the store refuses a body changed after signing, a file that doesn't match its hash, a missing file, the
 *     same update twice, and one older than what's already out.
 *   · A rollback to the screens inside the app is handed out as a directive — and not to a phone already on them.
 *   · The history lists both, newest first.
 *   · The certificate the server trusts is the one the app is built with (mobile/certs/certificate.pem), and the
 *     proxy lets exactly these addresses through on the platform's host.
 *
 * Everything is for a native build named check-…, removed at the end.
 *
 *   npm run check:app-updates
 */
import "dotenv/config";
import { createHash, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const RV = `check-${randomUUID()}`;
const SERVER = "http://localhost:3000";

let failures = 0;
let passes = 0;
function ok(label: string, cond: unknown, detail?: unknown) {
  if (cond) {
    passes++;
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(` FAIL  ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}
const section = (name: string) => console.log(`\n— ${name} —\n`);

const hashOf = (b: Uint8Array) => createHash("sha256").update(b).digest("base64url");
const signatureOf = (body: string, key: KeyObject) => `sig="${sign("sha256", Buffer.from(body), key).toString("base64")}", keyid="main", alg="rsa-v1_5-sha256"`;

/** A phone's question, as expo-updates asks it. */
function ask(headers: Record<string, string>) {
  return new Request(`${SERVER}/api/app-updates/manifest`, { headers: { "expo-protocol-version": "1", "expo-platform": "android", "expo-runtime-version": RV, "expo-expect-signature": "sig, keyid, alg", ...headers } });
}

/** The parts of a multipart answer, with their headers. */
async function partsOf(res: Response) {
  const type = res.headers.get("content-type") ?? "";
  const boundary = /boundary=([^;]+)/.exec(type)?.[1];
  if (!boundary) return [];
  const text = await res.text();
  return text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((chunk) => {
      const [head, ...rest] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
      const headers = Object.fromEntries(head!.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      return { headers, body: rest.join("\r\n\r\n").replace(/\r\n$/, "") };
    });
}

function manifestFor(files: { bytes: Uint8Array; contentType: string; ext: string }[], createdAt: Date, id = randomUUID()) {
  const asFile = (f: { bytes: Uint8Array; contentType: string; ext: string }) => {
    const hash = hashOf(f.bytes);
    return { hash, key: createHash("md5").update(f.bytes).digest("hex"), contentType: f.contentType, fileExtension: `.${f.ext}`, url: `${SERVER}/api/app-updates/assets/${hash}` };
  };
  return { id, createdAt: createdAt.toISOString(), runtimeVersion: RV, launchAsset: asFile(files[0]!), assets: files.slice(1).map(asFile), metadata: { platform: "android", commit: "abc1234" }, extra: { expoClient: { name: "Deskzo" } } };
}

async function main() {
  const { controlDb, closeControlDb } = await import("../src/lib/platform/control-db");
  const { publishAppUpdate } = await import("../src/lib/app-updates/store");
  const { APP_UPDATE_CERTIFICATE } = await import("../src/lib/app-updates/certificate");
  const manifestRoute = await import("../src/app/api/app-updates/manifest/route");
  const assetRoute = await import("../src/app/api/app-updates/assets/[hash]/route");
  const publishRoute = await import("../src/app/api/app-updates/publish/route");
  const historyRoute = await import("../src/app/api/app-updates/history/route");

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const bundle = { bytes: new TextEncoder().encode(`// ${RV}\nconsole.log("screens");`), contentType: "application/javascript", ext: "bundle" };
  const image = { bytes: new Uint8Array([137, 80, 78, 71, ...Array.from(randomUUID(), (c) => c.charCodeAt(0))]), contentType: "image/png", ext: "png" };
  const files = (list: typeof bundle[]) => new Map(list.map((f) => [hashOf(f.bytes), { bytes: f.bytes, contentType: f.contentType }]));
  const createdHashes = [hashOf(bundle.bytes), hashOf(image.bytes)];

  try {
    section("The certificate and the addresses");
    ok("the server trusts the certificate the app is built with", APP_UPDATE_CERTIFICATE.trim() === readFileSync(path.join(ROOT, "mobile", "certs", "certificate.pem"), "utf8").replace(/\r\n/g, "\n").trim());
    const proxy = readFileSync(path.join(ROOT, "src", "proxy.ts"), "utf8");
    const pattern = /const PLATFORM_API = (\/.+\/);/.exec(proxy)?.[1];
    const allowed = pattern ? new RegExp(pattern.slice(1, -1)) : null;
    const hash = createdHashes[0]!;
    ok(
      "the proxy lets the manifest, files, publishing and history through on the platform's host",
      !!allowed && ["/api/app-updates/manifest", `/api/app-updates/assets/${hash}`, "/api/app-updates/publish", "/api/app-updates/history"].every((p) => allowed.test(p)),
    );
    ok("…and nothing else under it", !!allowed && !["/api/app-updates", "/api/app-updates/assets/x", "/api/app-updates/assets/../manifest", "/api/app-updates/admin"].some((p) => allowed.test(p)));

    section("Before anything is published");
    const nothing = await manifestRoute.GET(ask({ "expo-current-update-id": randomUUID(), "expo-embedded-update-id": randomUUID() }));
    ok("a phone is told there's nothing (204, protocol 1)", nothing.status === 204 && nothing.headers.get("expo-protocol-version") === "1", nothing.status);
    const bad = await manifestRoute.GET(new Request(`${SERVER}/api/app-updates/manifest`, { headers: { "expo-platform": "windows", "expo-runtime-version": RV } }));
    ok("a platform it doesn't serve: 400", bad.status === 400, bad.status);

    section("Publishing");
    const first = manifestFor([bundle, image], new Date(Date.now() - 60_000));
    const firstBody = JSON.stringify(first);
    const viaRoute = new FormData();
    viaRoute.append("package", JSON.stringify({ kind: "UPDATE", body: firstBody, signature: signatureOf(firstBody, privateKey) }));
    for (const f of [bundle, image]) viaRoute.append(hashOf(f.bytes), new Blob([new Uint8Array(f.bytes)], { type: f.contentType }), `x.${f.ext}`);
    const refused = await publishRoute.POST(new Request(`${SERVER}/api/app-updates/publish`, { method: "POST", body: viaRoute }));
    ok("the publish address refuses an update not signed with Deskzo's key", refused.status === 403, `${refused.status} ${JSON.stringify(await refused.json().catch(() => null))}`);

    const tampered = await publishAppUpdate({ kind: "UPDATE", body: firstBody.replace('"abc1234"', '"evil000"'), signature: signatureOf(firstBody, privateKey), files: files([bundle, image]) }, publicKey);
    ok("a body changed after signing: refused", !tampered.ok && tampered.status === 403, tampered);
    const wrongFile = await publishAppUpdate({ kind: "UPDATE", body: firstBody, signature: signatureOf(firstBody, privateKey), files: new Map([[hashOf(bundle.bytes), { bytes: new TextEncoder().encode("not it"), contentType: "application/javascript" }], [hashOf(image.bytes), { bytes: image.bytes, contentType: "image/png" }]]) }, publicKey);
    ok("a file that doesn't match its hash: refused", !wrongFile.ok && wrongFile.status === 422, wrongFile);
    const missing = await publishAppUpdate({ kind: "UPDATE", body: firstBody, signature: signatureOf(firstBody, privateKey), files: files([bundle]) }, publicKey);
    ok("a file left out: refused", !missing.ok && missing.status === 422, missing);

    const published = await publishAppUpdate({ kind: "UPDATE", body: firstBody, signature: signatureOf(firstBody, privateKey), files: files([bundle, image]) }, publicKey);
    ok("signed with the trusted key and every file there: kept", published.ok, published);
    const again = await publishAppUpdate({ kind: "UPDATE", body: firstBody, signature: signatureOf(firstBody, privateKey), files: new Map() }, publicKey);
    ok("the same update twice: refused", !again.ok && again.status === 409, again);
    const older = manifestFor([bundle], new Date(Date.now() - 120_000));
    const olderBody = JSON.stringify(older);
    const stale = await publishAppUpdate({ kind: "UPDATE", body: olderBody, signature: signatureOf(olderBody, privateKey), files: new Map() }, publicKey);
    ok("one older than what's out: refused (phones run the newest they have)", !stale.ok && stale.status === 409, stale);

    section("A phone asks");
    const handed = await manifestRoute.GET(ask({ "expo-current-update-id": randomUUID(), "expo-embedded-update-id": randomUUID() }));
    const parts = await partsOf(handed);
    const manifestPart = parts.find((p) => /name="manifest"/.test(p.headers["content-disposition"] ?? ""));
    ok("a phone on the build is handed the update (multipart, protocol 1, not cached)", handed.status === 200 && !!manifestPart && handed.headers.get("expo-protocol-version") === "1" && /max-age=0/.test(handed.headers.get("cache-control") ?? ""), handed.status);
    ok("…the manifest byte for byte as it was signed", manifestPart?.body === firstBody);
    const sig = /sig="([^"]+)"/.exec(manifestPart?.headers["expo-signature"] ?? "")?.[1];
    ok("…with a signature the app's check accepts", !!sig && verify("sha256", Buffer.from(manifestPart!.body), publicKey, Buffer.from(sig, "base64")));
    const already = await manifestRoute.GET(ask({ "expo-current-update-id": first.id.toUpperCase() }));
    ok("a phone already running it: nothing (204)", already.status === 204, already.status);
    const otherBuild = await manifestRoute.GET(new Request(`${SERVER}/api/app-updates/manifest`, { headers: { "expo-protocol-version": "1", "expo-platform": "android", "expo-runtime-version": `${RV}-other` } }));
    ok("a phone on another native build: nothing", otherBuild.status === 204, otherBuild.status);

    section("Its files");
    const file = await assetRoute.GET(new Request(`${SERVER}/api/app-updates/assets/${hashOf(bundle.bytes)}`), { params: Promise.resolve({ hash: hashOf(bundle.bytes) }) });
    const bytes = new Uint8Array(await file.arrayBuffer());
    ok("the JavaScript, by its hash — the same bytes, its type, cacheable for good", file.status === 200 && hashOf(bytes) === hashOf(bundle.bytes) && file.headers.get("content-type") === "application/javascript" && /immutable/.test(file.headers.get("cache-control") ?? ""), file.status);
    const unknown = await assetRoute.GET(new Request(`${SERVER}/x`), { params: Promise.resolve({ hash: hashOf(new TextEncoder().encode(randomUUID())) }) });
    const notAHash = await assetRoute.GET(new Request(`${SERVER}/x`), { params: Promise.resolve({ hash: "../../etc" }) });
    ok("an unknown hash, or something that isn't one: 404", unknown.status === 404 && notAHash.status === 404, [unknown.status, notAHash.status]);

    section("Rolling back");
    const directive = JSON.stringify({ type: "rollBackToEmbedded", parameters: { commitTime: new Date().toISOString() }, extra: { id: randomUUID(), runtimeVersion: RV, platform: "android" } });
    const rolled = await publishAppUpdate({ kind: "ROLL_BACK_TO_EMBEDDED", body: directive, signature: signatureOf(directive, privateKey), files: new Map() }, publicKey);
    ok("a signed rollback to the screens inside the app: kept", rolled.ok, rolled);
    const back = await partsOf(await manifestRoute.GET(ask({ "expo-current-update-id": first.id, "expo-embedded-update-id": randomUUID() })));
    const directivePart = back.find((p) => /name="directive"/.test(p.headers["content-disposition"] ?? ""));
    ok("a phone on the update is handed the directive, signed", directivePart?.body === directive && /sig="/.test(directivePart?.headers["expo-signature"] ?? ""));
    const embedded = randomUUID();
    const onEmbedded = await manifestRoute.GET(ask({ "expo-current-update-id": embedded, "expo-embedded-update-id": embedded }));
    ok("a phone already on the screens inside the app: nothing", onEmbedded.status === 204, onEmbedded.status);

    section("History");
    const hist = await historyRoute.GET(new Request(`${SERVER}/api/app-updates/history?platform=android&runtime-version=${RV}`));
    const rows = ((await hist.json()) as { updates: { id: string; kind: string; commit: string | null }[] }).updates;
    ok("both, newest first — the rollback, then the update with its commit", rows.length === 2 && rows[0]!.kind === "ROLL_BACK_TO_EMBEDDED" && rows[1]!.id === first.id && rows[1]!.commit === "abc1234", rows);
  } finally {
    const db = controlDb();
    await db.appUpdate.deleteMany({ where: { runtimeVersion: { startsWith: RV } } });
    const stillUsed = await db.appUpdate.findMany({ where: { assetHashes: { hasSome: createdHashes } }, select: { id: true } });
    if (!stillUsed.length) await db.appUpdateAsset.deleteMany({ where: { hash: { in: createdHashes } } });
    await closeControlDb();
  }

  console.log(failures ? `\n${failures} check(s) FAILED (${passes} passed).` : `\nAll ${passes} app update checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
