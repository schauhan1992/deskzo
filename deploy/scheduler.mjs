// The platform's scheduled calls (docs/runbook.md §1), made to the app inside the server rather than
// through the internet: on the console's address, so each one runs for every workspace.
//
//   marketing   every 5 minutes    /api/marketing/tick   campaigns, lead scores, sales wins
//   backup      every 15 minutes   /api/backup/tick      each workspace's scheduled backups
//   platform    every hour         /api/platform/tick    trials, holds, billing, partners
//
//   node deploy/scheduler.mjs                 keep going: all three on their intervals, to the app at
//                                             SCHEDULER_APP_HOST (default `app`) — the `scheduler`
//                                             service in deploy/azure/docker-compose.yml
//   node deploy/scheduler.mjs once <name>     one call, to the app in this same container
//                                             (127.0.0.1), then exit — non-zero if it failed. For a
//                                             platform's own scheduler, e.g. Coolify's Scheduled Tasks
//
// A call that fails in the loop is logged and tried again at its next turn; nothing stops the loop.
import http from "node:http";

const DOMAIN = process.env.PLATFORM_DOMAIN?.trim();
if (!DOMAIN) {
  console.error("PLATFORM_DOMAIN is not set.");
  process.exit(1);
}

const MINUTE = 60_000;
const JOBS = {
  marketing: { path: "/api/marketing/tick", secret: "MARKETING_TICK_SECRET", every: 5 * MINUTE },
  backup: { path: "/api/backup/tick", secret: "BACKUP_TICK_SECRET", every: 15 * MINUTE },
  platform: { path: "/api/platform/tick", secret: "PLATFORM_TICK_SECRET", every: 60 * MINUTE },
};

/** One call. Resolves with whether it worked and what to log. */
function call(job, app) {
  const secret = process.env[job.secret]?.trim();
  if (!secret) return Promise.resolve({ ok: false, said: `not called: ${job.secret} is not set` });
  return new Promise((resolve) => {
    const req = http.request(
      {
        ...app,
        path: job.path,
        method: "GET",
        // The console's address: on it a tick runs for every workspace (src/lib/platform/fanout.ts).
        headers: { host: `admin.${DOMAIN}`, authorization: `Bearer ${secret}` },
        timeout: 10 * MINUTE,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body.length < 2000 ? (body += chunk) : null));
        res.on("end", () => resolve({ ok: res.statusCode === 200, said: `${res.statusCode}${res.statusCode === 200 ? "" : ` ${body.slice(0, 300)}`}` }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve({ ok: false, said: `failed: ${err.message}` }));
    req.end();
  });
}

const [mode, name] = process.argv.slice(2);

if (mode === "once") {
  const job = JOBS[name];
  if (!job) {
    console.error(`usage: node deploy/scheduler.mjs once <${Object.keys(JOBS).join("|")}>`);
    process.exit(2);
  }
  const app = { host: process.env.SCHEDULER_APP_HOST || "127.0.0.1", port: Number(process.env.SCHEDULER_APP_PORT || process.env.PORT || 3000) };
  const outcome = await call(job, app);
  console.log(`${new Date().toISOString()} ${job.path} ${outcome.said}`);
  process.exit(outcome.ok ? 0 : 1);
}

const app = { host: process.env.SCHEDULER_APP_HOST || "app", port: Number(process.env.SCHEDULER_APP_PORT || 3000) };
for (const job of Object.values(JOBS)) {
  let running = false;
  const run = async () => {
    if (running) return; // the last one is still going: never two at once
    running = true;
    try {
      const outcome = await call(job, app);
      console.log(`${new Date().toISOString()} ${job.path} ${outcome.said}`);
    } finally {
      running = false;
    }
  };
  // A minute after start, so the app is up; then on the interval.
  setTimeout(() => {
    run();
    setInterval(run, job.every);
  }, MINUTE);
}
console.log(`scheduler: ${Object.values(JOBS).map((j) => `${j.path} every ${j.every / MINUTE} min`).join(", ")}`);
