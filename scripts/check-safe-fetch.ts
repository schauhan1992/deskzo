/**
 * Fetching somebody else's URL without reaching inside our own network (src/lib/net/safe-fetch.ts),
 * and Domain Intel going through it (2026-10-17: its homepage fetch took an IP address as a
 * "domain" and followed redirects anywhere).
 *
 *   npm run check:safe-fetch
 *
 * No outside network: hostnames are resolved by a stub, and the one live server is this script's own
 * on 127.0.0.1 — reached only where a check deliberately lets that address through.
 */
import http from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import { parseIp } from "../src/lib/access/ip";
import { isBlockedAddress, safeFetch, SafeFetchError, type SafeFetchErrorCode, type SafeFetchOptions } from "../src/lib/net/safe-fetch";
import { lookupSite } from "../src/lib/domain-intel/lookup";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

/** The code a refusal carries, or "fetched" when nothing refused it. */
async function outcome(url: string, options: SafeFetchOptions): Promise<SafeFetchErrorCode | "fetched"> {
  try {
    await safeFetch(url, options);
    return "fetched";
  } catch (error) {
    return error instanceof SafeFetchError ? error.code : "network";
  }
}

/** A resolver that answers from a table, and says so if it's asked about anything else. */
function stubDns(table: Record<string, string[]>) {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (host: string) => {
      asked.push(host);
      return table[host] ?? [];
    },
  };
}

async function main() {
  section("Which addresses are refused");

  const refused = [
    "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "192.0.2.10", "::1", "::", "::ffff:127.0.0.1", "::127.0.0.1", "fe80::1", "fc00::1",
    "fd00:ec2::254", "64:ff9b::7f00:1", "2002:7f00:1::1", "ff02::1", "2001:db8::1", "2001::1",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "13.107.42.14", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2404:6800:4009::200e"];
  for (const address of refused) ok(`refuses ${address}`, isBlockedAddress(parseIp(address)!));
  for (const address of allowed) ok(`allows ${address}`, !isBlockedAddress(parseIp(address)!));

  section("Addresses refused before anything is fetched");

  const dns = stubDns({
    "evil.test": ["10.0.0.7"],
    "mixed.test": ["93.184.216.34", "127.0.0.1"],
    "v6local.test": ["fd00::1"],
    "metadata.test": ["169.254.169.254"],
  });
  const noNetwork: SafeFetchOptions = { resolve: dns.resolve, timeoutMs: 2_000 };
  const expect = async (url: string, code: SafeFetchErrorCode, label: string, options = noNetwork) => {
    const got = await outcome(url, options);
    ok(label, got === code, got);
  };
  await expect("http://127.0.0.1/", "blocked-address", "a loopback address");
  await expect("http://2130706433/", "blocked-address", "  127.0.0.1 written as one number");
  await expect("http://0x7f.1/", "blocked-address", "  …in hex");
  await expect("http://017700000001/", "blocked-address", "  …in octal");
  await expect("http://[::1]/", "blocked-address", "  …as IPv6");
  await expect("http://[::ffff:127.0.0.1]/", "blocked-address", "  …as IPv4 inside IPv6");
  await expect("http://169.254.169.254/latest/meta-data/", "blocked-address", "the cloud metadata address");
  await expect("http://0.0.0.0/", "blocked-address", "0.0.0.0, which many systems treat as this machine");
  await expect("http://evil.test/", "blocked-address", "a name that resolves to a private address");
  await expect("http://mixed.test/", "blocked-address", "  …even beside a public one");
  await expect("http://v6local.test/", "blocked-address", "  …or to a local IPv6 address");
  await expect("http://metadata.test/", "blocked-address", "  …or to the metadata address");
  await expect("http://nowhere.test/", "no-address", "a name with no address");
  await expect("ftp://example.com/", "bad-url", "ftp");
  await expect("file:///etc/passwd", "bad-url", "a file path");
  await expect("http://user:secret@example.com/", "bad-url", "a username and password in the address");
  await expect("http://example.com:8080/", "bad-port", "a port other than 80 or 443");
  await expect("not a url", "bad-url", "something that isn't an address");
  ok(
    "IP addresses never go to DNS",
    !dns.asked.some((h) => /^[\d.:[\]x]+$/i.test(h)),
    dns.asked.join(", "),
  );

  section("A live fetch, its redirects and its limits");

  let hits = 0;
  let lastHost = "";
  const big = "x".repeat(300_000);
  const server = http.createServer((req, res) => {
    hits += 1;
    lastHost = req.headers.host ?? "";
    const port = (server.address() as AddressInfo).port;
    switch (req.url) {
      case "/":
        res.writeHead(200, { "content-type": "text/html", server: "test" });
        return res.end("<title>Hello</title>");
      case "/gz":
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        return res.end(gzipSync("<title>Squeezed</title>"));
      case "/big":
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(big);
      case "/hop":
        res.writeHead(302, { location: "/" });
        return res.end();
      case "/to-private":
        res.writeHead(302, { location: `http://10.0.0.9:${port}/` });
        return res.end();
      case "/to-metadata-name":
        res.writeHead(302, { location: `http://metadata.test:${port}/` });
        return res.end();
      case "/loop":
        res.writeHead(302, { location: "/loop" });
        return res.end();
      case "/slow":
        return; // never answers
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  // The default rules refuse this server outright — and it never hears about it.
  const before = hits;
  ok("the default rules refuse our own server", (await outcome(`${base}/`, { ports: [port] })) === "blocked-address");
  ok("  and it received no request", hits === before, `${hits - before} request(s)`);

  // From here 127.0.0.1 stands in for a public site: only that one address is let through.
  const live: SafeFetchOptions = {
    ports: [port],
    timeoutMs: 2_000,
    resolve: stubDns({ "site.test": ["127.0.0.1"], "metadata.test": ["169.254.169.254"] }).resolve,
    blocked: (ip) => !(ip.version === 4 && ip.value === parseIp("127.0.0.1")!.value),
  };
  const page = await safeFetch(`${base}/`, live);
  ok("a page is fetched", page.status === 200 && page.body.includes("<title>Hello</title>"), page.status);
  ok("  with its headers", page.headers.get("server") === "test");

  // site.test exists only in the stub: reaching the server at all proves the socket used the checked
  // address rather than asking the system's DNS again.
  const named = await safeFetch(`http://site.test:${port}/`, live).catch((error: Error) => error);
  ok(
    "a name is fetched from the address it was checked at",
    !(named instanceof Error) && named.status === 200 && lastHost === `site.test:${port}`,
    named instanceof Error ? named.message : lastHost,
  );

  const squeezed = await safeFetch(`${base}/gz`, live);
  ok("a gzipped page is unpacked", squeezed.body.includes("Squeezed"), squeezed.body.slice(0, 40));

  const capped = await safeFetch(`${base}/big`, { ...live, maxBytes: 200_000 });
  ok("a long page is cut at the cap", capped.body.length === 200_000 && capped.truncated, capped.body.length);

  const hopped = await safeFetch(`${base}/hop`, live);
  ok("a redirect is followed", hopped.status === 200 && hopped.url === `${base}/`, hopped.url);
  ok("a redirect to a private address is refused", (await outcome(`${base}/to-private`, live)) === "blocked-address");
  ok("a redirect to a name that resolves inside is refused", (await outcome(`${base}/to-metadata-name`, live)) === "blocked-address");
  ok("a redirect loop stops", (await outcome(`${base}/loop`, live)) === "too-many-redirects");

  const started = Date.now();
  const slow = await outcome(`${base}/slow`, { ...live, timeoutMs: 400 });
  ok("a site that never answers times out", slow === "timeout" && Date.now() - started < 1_500, `${slow} after ${Date.now() - started} ms`);

  server.close();

  section("Domain Intel goes through the guard");

  const source = fs.readFileSync("src/lib/domain-intel/lookup.ts", "utf8").replace(/\r\n/g, "\n");
  const site = source.slice(source.indexOf("export async function lookupSite"), source.indexOf("export type RegistrationFindings"));
  ok("the homepage is read with safeFetch", site.includes("safeFetch(") && !/\bfetch\(/.test(site.replace(/safeFetch\(/g, "")));

  for (const domain of ["127.0.0.1", "169.254.169.254", "10.0.0.1"]) {
    const t0 = Date.now();
    const found = await lookupSite(domain, []);
    const ms = Date.now() - t0;
    // Refused at once: a real attempt at an unroutable address would wait out the 8-second timeout.
    ok(`a company website of ${domain} reads as no response, at once`, found.httpStatus === null && found.siteTitle === null && ms < 2_000, `${ms} ms`);
  }

  console.log(failures === 0 ? "\nAll safe-fetch checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
