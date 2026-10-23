/**
 * The container's command (Dockerfile): the web app — and, with DESKZO_WORKER=in-app, the platform
 * worker beside it (owner, 18 Oct 2026: the worker runs for good, not every five minutes).
 *
 * Beside the app rather than a second container because on Coolify the two would not share /data,
 * and the worker must see a workspace's restore lock there (src/lib/backup/maintenance.ts) to leave
 * that workspace alone while it is put back. The Compose deployment (deploy/azure) runs the worker as
 * its own service on the same volume instead, and leaves DESKZO_WORKER unset.
 *
 *   · The app is the container's life: when it stops, the worker is stopped and the container exits
 *     with the app's code, for Coolify to restart.
 *   · The worker is restarted when it stops, a few seconds later — never taking the app down with it.
 *   · SIGTERM and SIGINT (tini passes them on) go to both, so a deploy stops them cleanly; the worker
 *     finishes its pass under its leases, which a worker in the next container takes over.
 */
import { spawn } from "node:child_process";
import cluster from "node:cluster";
import { pathToFileURL } from "node:url";

/**
 * How many copies of the web app run in the container (DESKZO_WEB_PROCESSES, 1–16; one when unset).
 *
 * The app answers a page on one thread, and a page that has to work something out holds every other
 * request of every workspace while it does (the large-workspace load test, 23 Oct 2026). Several copies
 * share the one port — Node's cluster, round robin — and what each keeps in memory and must agree on is
 * passed between them by `superviseCluster` (src/lib/cluster/hub.ts): caches cleared, sign-in failures
 * counted, chat delivered. Each copy holds its own database pools, so the connections are shared out.
 */
export function webProcesses(env = process.env) {
  const n = Number.parseInt(String(env.DESKZO_WEB_PROCESSES ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(16, Math.max(1, n)) : 1;
}

/**
 * Runs `processes` copies of the web app (`exec`, deploy/web-worker.mjs: `next start`) on the one port,
 * keeps `worker` running beside them as `supervise` does, and passes the copies' broadcasts between
 * them. A copy that stops is started again `restartMs` later and the others are told it has gone; the
 * container lives as long as this does. Resolves when stopped.
 */
export function superviseCluster({ processes, exec, execArgv = [], worker = null, restartMs = 5000, env = {}, log = console.error }) {
  return new Promise((resolve) => {
    let stopping = false;
    let platform = null;
    // Round robin on every platform — Windows would otherwise hand the port to whichever copy wins.
    cluster.schedulingPolicy = cluster.SCHED_RR;
    cluster.setupPrimary({ exec, execArgv });
    const copies = () => Object.values(cluster.workers ?? {}).filter((w) => w && w.isConnected());
    // Database pools are per copy: the budget one process was given is shared out, unless set.
    const pools = (process.env.TENANCY_MAX_CLIENTS ?? "").trim() || String(Math.max(4, Math.floor(35 / processes)));
    const fork = () => {
      const copy = cluster.fork({ ...env, DESKZO_WEB_WORKER: "1", TENANCY_MAX_CLIENTS: pools });
      copy.on("message", (message) => {
        if (!message || message.deskzo !== "hub") return;
        for (const other of copies()) if (other !== copy) other.send(message);
      });
    };

    const startPlatform = () => {
      platform = spawn(worker[0], worker.slice(1), { stdio: "inherit", env: process.env });
      platform.on("exit", (code, signal) => {
        platform = null;
        if (stopping) return;
        log(`[start] the platform worker stopped (${signal ?? `code ${code}`}); starting it again in ${restartMs / 1000} s`);
        setTimeout(() => {
          if (!stopping) startPlatform();
        }, restartMs);
      });
      platform.on("error", (err) => log(`[start] the platform worker could not start: ${err.message}`));
    };

    cluster.on("exit", (copy, code, signal) => {
      const gone = { deskzo: "hub", topic: "process:gone", payload: { pid: copy.process.pid }, from: 0 };
      for (const other of copies()) other.send(gone);
      if (stopping) {
        if (copies().length === 0 && Object.keys(cluster.workers ?? {}).length === 0) resolve({ code: 0 });
        return;
      }
      log(`[start] a web process stopped (${signal ?? `code ${code}`}); starting another in ${restartMs / 1000} s`);
      setTimeout(() => {
        if (!stopping) fork();
      }, restartMs);
    });

    for (let i = 0; i < processes; i++) fork();
    if (worker) startPlatform();
    log(`[start] ${processes} web processes, ${pools} database pools each`);

    const stop = (signal) => {
      if (stopping) return;
      stopping = true;
      platform?.kill(signal);
      const running = Object.values(cluster.workers ?? {}).filter(Boolean);
      if (running.length === 0) resolve({ code: 0 });
      for (const copy of running) copy.process.kill(signal);
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
  });
}

/** Runs `app` and, when given, keeps `worker` running beside it. Resolves with the app's exit code. */
export function supervise({ app, worker = null, restartMs = 5000, log = console.error }) {
  return new Promise((resolve) => {
    let stopping = false;
    let running = null;
    let restarts = 0;

    const startWorker = () => {
      running = spawn(worker[0], worker.slice(1), { stdio: "inherit", env: process.env });
      running.on("exit", (code, signal) => {
        running = null;
        if (stopping) return;
        restarts += 1;
        log(`[start] the platform worker stopped (${signal ?? `code ${code}`}); starting it again in ${restartMs / 1000} s`);
        setTimeout(() => {
          if (!stopping) startWorker();
        }, restartMs);
      });
      running.on("error", (err) => log(`[start] the platform worker could not start: ${err.message}`));
    };

    const web = spawn(app[0], app.slice(1), { stdio: "inherit", env: process.env });
    if (worker) startWorker();

    const stop = (signal) => {
      stopping = true;
      web.kill(signal);
      running?.kill(signal);
    };
    const onSignal = (signal) => () => stop(signal);
    process.on("SIGTERM", onSignal("SIGTERM"));
    process.on("SIGINT", onSignal("SIGINT"));

    web.on("exit", (code, signal) => {
      stopping = true;
      running?.kill("SIGTERM");
      resolve({ code: code ?? (signal ? 1 : 0), restarts });
    });
    web.on("error", (err) => {
      log(`[start] the app could not start: ${err.message}`);
      stopping = true;
      running?.kill("SIGTERM");
      resolve({ code: 1, restarts });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const inApp = (process.env.DESKZO_WORKER ?? "").trim() === "in-app";
  const worker = inApp ? ["node_modules/.bin/tsx", "scripts/platform-worker.ts"] : null;
  const processes = webProcesses();
  const { code } =
    processes > 1
      ? await superviseCluster({ processes, exec: "deploy/web-worker.mjs", worker })
      : await supervise({ app: ["node_modules/.bin/next", "start"], worker });
  process.exit(code);
}
