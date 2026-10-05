/**
 * check:auth-host — Auth.js's requests put back on the browser's host (src/lib/tenancy/own-host.ts).
 * In production a workspace's host has no port; the server's own address is http://localhost:3000.
 * The rebuilt address must take the host's port — none — and its scheme, never keep :3000: that
 * sent Microsoft sign-in to https://wroffy.deskzo.com:3000 (owner's report, 5 Oct 2026).
 */
import { NextRequest } from "next/server";

process.env.TRUST_PROXY = "";
process.env.TRUST_PROXY_HOPS = "";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { onItsOwnHost } = require("../src/lib/tenancy/own-host") as typeof import("../src/lib/tenancy/own-host");
  const inside = (path: string, host: string) => new NextRequest(`http://localhost:3000${path}`, { headers: { host } });
  const CALLBACK = "/api/auth/callback/microsoft-entra-id?code=zz&state=yy";

  const prod = onItsOwnHost(inside(CALLBACK, "wroffy.deskzo.com"));
  ok("a production host: https, no port — never the server's :3000", prod.nextUrl.href === `https://wroffy.deskzo.com${CALLBACK}`, prod.nextUrl.href);
  const dev = onItsOwnHost(inside(CALLBACK, "wroffy.localhost:3000"));
  ok("a development host keeps its own port, over http", dev.nextUrl.href === `http://wroffy.localhost:3000${CALLBACK}`, dev.nextUrl.href);
  const custom = onItsOwnHost(inside("/api/auth/session", "crm.acme.example:8443"));
  ok("a host with its own port keeps that port", custom.nextUrl.href === "https://crm.acme.example:8443/api/auth/session", custom.nextUrl.href);
  const post = onItsOwnHost(new NextRequest(`http://localhost:3000/api/auth/callback/credentials`, { method: "POST", headers: { host: "acme.deskzo.com", "content-type": "application/x-www-form-urlencoded" }, body: "a=1" }));
  ok("a POST keeps its method, headers and body", post.method === "POST" && post.headers.get("content-type") === "application/x-www-form-urlencoded" && (await post.text()) === "a=1" && post.nextUrl.host === "acme.deskzo.com");
  const already = inside("/api/auth/csrf", "localhost:3000");
  ok("a request already on its host is passed on as it is", onItsOwnHost(already) === already);
  const none = new NextRequest("http://localhost:3000/api/auth/csrf");
  ok("no host header: passed on as it is", onItsOwnHost(none) === none);

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll auth host checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
