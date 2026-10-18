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
import { pathToFileURL } from "node:url";

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
  const { code } = await supervise({
    app: ["node_modules/.bin/next", "start"],
    worker: inApp ? ["node_modules/.bin/tsx", "scripts/platform-worker.ts"] : null,
  });
  process.exit(code);
}
