/**
 * check:cluster — several web processes in one container (owner, 23 Oct 2026; deploy/start.mjs,
 * src/lib/cluster/hub.ts).
 *
 * Runs deploy/start.mjs's cluster for real — three processes on one port, round robin — with a small
 * probe server (scripts/cluster-probe-worker.ts) in place of `next start`, over the modules that must
 * agree between processes, and asks it over HTTP, each request on a connection of its own:
 *
 *   1. DESKZO_WEB_PROCESSES: one unless set, at most sixteen.
 *   2. The sign-in lockout counts failures across processes: eight, wherever they land, lock everywhere.
 *   3. A throttle's window opened in one process is open in all.
 *   4. A shared cache clear runs in every process.
 *   5. Chat: a person listening in one process is "online" in all, and hears what another publishes;
 *      when their stream closes they are offline everywhere.
 *   6. A process that dies: the others forget what it held, and a new one is started that learns who is
 *      listening.
 *
 *   npm run check:cluster
 */
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = 39_000 + Math.floor(Math.random() * 900);
const agent = new http.Agent({ keepAlive: false });

type Answer = { pid: number } & Record<string, unknown>;
function ask(pathname: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: pathname, agent }, (res) => {
      let body = "";
      res.on("data", (c) => (body += String(c)));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as Answer);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timed out")));
  });
}

/** Asks until every one of `pids` has answered — round robin gets there in a few — and returns each one's answer. */
async function fromEach(pathname: string, pids: Set<number>, tries = 60): Promise<Map<number, Answer>> {
  const seen = new Map<number, Answer>();
  for (let i = 0; i < tries && seen.size < pids.size; i++) {
    const a = await ask(pathname);
    if (pids.has(a.pid) && !seen.has(a.pid)) seen.set(a.pid, a);
  }
  return seen;
}

/** Opens a live stream; resolves with the process holding it and a way to read what arrives. */
function listen(user: string): Promise<{ pid: number; events: unknown[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    const req = http.get({ host: "127.0.0.1", port: PORT, path: `/listen?u=${user}`, agent }, (res) => {
      const pid = Number(res.headers["x-pid"]);
      let buffer = "";
      res.on("data", (c) => {
        buffer += String(c);
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
        }
      });
      resolve({ pid, events, close: () => req.destroy() });
    });
    req.on("error", (err) => (String(err.message).includes("socket hang up") ? undefined : reject(err)));
  });
}

async function until(test: () => Promise<boolean> | boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  const start = (await import(pathToFileURL(path.join(process.cwd(), "deploy", "start.mjs")).href)) as {
    webProcesses: (env: Record<string, string | undefined>) => number;
    superviseCluster: (opts: Record<string, unknown>) => Promise<{ code: number }>;
  };

  section("1. How many");
  ok("one unless set", start.webProcesses({}) === 1 && start.webProcesses({ DESKZO_WEB_PROCESSES: "" }) === 1 && start.webProcesses({ DESKZO_WEB_PROCESSES: "lots" }) === 1);
  ok("  as set, from one to sixteen", start.webProcesses({ DESKZO_WEB_PROCESSES: "4" }) === 4 && start.webProcesses({ DESKZO_WEB_PROCESSES: "0" }) === 1 && start.webProcesses({ DESKZO_WEB_PROCESSES: "99" }) === 16);

  const logs: string[] = [];
  const running = start.superviseCluster({
    processes: 3,
    exec: path.join(process.cwd(), "scripts", "cluster-probe-worker.ts"),
    execArgv: ["--import", "tsx"],
    restartMs: 300,
    env: { PORT: String(PORT) },
    log: (line: string) => logs.push(line),
  });

  try {
    const pids = new Set<number>();
    const up = await until(async () => {
      try {
        pids.add((await ask("/pid")).pid);
      } catch {
        // Not listening yet.
      }
      return pids.size === 3;
    }, 60_000);
    ok("three processes answer on the one port, in turn", up, [...pids]);
    if (!up) throw new Error("the cluster never came up");

    section("2. The sign-in lockout");
    const landed = new Set<number>();
    for (let i = 0; i < 8; i++) landed.add((await ask("/fail?key=zz-asha")).pid);
    ok("eight failures, spread over the processes", landed.size > 1, [...landed]);
    await sleep(200);
    const locked = await fromEach("/locked?key=zz-asha", pids);
    ok("  lock the account in every one of them", locked.size === 3 && [...locked.values()].every((a) => (a.state as { lockedOut: boolean }).lockedOut), [...locked.values()].map((a) => a.state));
    const unrelated = await fromEach("/locked?key=zz-ravi", pids);
    ok("  and nobody else", [...unrelated.values()].every((a) => !(a.state as { lockedOut: boolean }).lockedOut));

    section("3. A throttle's window");
    const first = await ask("/throttle?key=zz-window");
    await sleep(200);
    const others = await fromEach("/throttle?key=zz-window", new Set([...pids].filter((p) => p !== first.pid)));
    ok(
      "written once — every other process finds the window open",
      (first.outcome as { write: boolean }).write && others.size === 2 && [...others.values()].every((a) => !(a.outcome as { write: boolean }).write),
      [first.outcome, ...[...others.values()].map((a) => a.outcome)],
    );

    section("4. A shared cache clear");
    const cleared = await ask("/clear");
    await sleep(200);
    const counts = await fromEach("/cleared", pids);
    ok("cleared in one, run in all", cleared.cleared === 1 && counts.size === 3 && [...counts.values()].every((a) => a.cleared === 1), [...counts.values()].map((a) => [a.pid, a.cleared]));

    section("5. Chat");
    const stream = await listen("zz-asha");
    await sleep(300);
    const online = await fromEach("/online?u=zz-asha", pids);
    ok("listening in one process: online in every one", online.size === 3 && [...online.values()].every((a) => a.online === true), [...online.values()].map((a) => [a.pid, a.online]));
    let elsewhere = false;
    for (let i = 0; i < 20 && !elsewhere; i++) elsewhere = (await ask(`/publish?u=zz-asha&text=hello-${i}`)).pid !== stream.pid;
    const heard = await until(() => stream.events.length > 0);
    ok("  a message published by another process reaches the stream", elsewhere && heard, stream.events.slice(0, 2));
    stream.close();
    const offline = await until(async () => {
      const each = await fromEach("/online?u=zz-asha", pids);
      return each.size === 3 && [...each.values()].every((a) => a.online === false);
    });
    ok("  the stream closed: offline everywhere", offline);

    section("6. A process that dies");
    const held = await listen("zz-kiran");
    await sleep(300);
    const victim = held.pid;
    // /exit lands where round robin sends it — keep asking until the victim itself took it.
    let killed = false;
    for (let i = 0; i < 20 && !killed; i++) killed = (await ask(`/exit?pid=${victim}`)).exiting === true;
    const survivors = new Set([...pids].filter((p) => p !== victim));
    const forgot = await until(async () => {
      const each = await fromEach("/online?u=zz-kiran", survivors);
      return each.size === survivors.size && [...each.values()].every((a) => a.online === false);
    }, 8000);
    ok("the others forget who was listening in it", forgot);
    const replaced = await until(async () => {
      const seen = new Set<number>();
      for (let i = 0; i < 12; i++) seen.add((await ask("/pid").catch(() => ({ pid: 0 }))).pid);
      return [...seen].some((p) => p && !pids.has(p));
    }, 15_000);
    ok("  and a new one is started in its place", replaced, logs.filter((l) => l.includes("stopped")));
    const fresh = await listen("zz-mira");
    await sleep(300);
    const asked = await until(async () => {
      const all = new Set<number>();
      for (let i = 0; i < 12; i++) all.add((await ask("/pid")).pid);
      const each = await fromEach("/online?u=zz-mira", all);
      return [...each.values()].every((a) => a.online === true) && each.size >= 3;
    }, 8000);
    ok("  which knows who is listening in the others", asked);
    fresh.close();
    held.close();
  } finally {
    process.emit("SIGTERM");
    await Promise.race([running, sleep(10_000)]);
  }

  console.log(failures ? `\n${failures} cluster check(s) FAILED (${passes} passed).` : `\nAll ${passes} cluster checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
