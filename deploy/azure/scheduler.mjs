// The platform's scheduled calls (docs/runbook.md §1), made to the app inside the server rather than
// through the internet: on the console's address, so each one runs for every workspace.
//
//   every 5 minutes   /api/marketing/tick   campaigns, lead scores, sales wins    MARKETING_TICK_SECRET
//   every 15 minutes  /api/backup/tick      each workspace's scheduled backups     BACKUP_TICK_SECRET
//   every hour        /api/platform/tick    trials, holds, billing, partners       PLATFORM_TICK_SECRET
//
// Runs as the `scheduler` service (deploy/azure/docker-compose.yml). A call that fails is logged and
// tried again at its next turn; nothing here ever stops the loop.
import http from "node:http";

const DOMAIN = process.env.PLATFORM_DOMAIN?.trim();
const APP = { host: process.env.SCHEDULER_APP_HOST || "app", port: Number(process.env.SCHEDULER_APP_PORT || 3000) };
if (!DOMAIN) throw new Error("PLATFORM_DOMAIN is not set.");

const MINUTE = 60_000;
const JOBS = [
  { path: "/api/marketing/tick", secret: "MARKETING_TICK_SECRET", every: 5 * MINUTE },
  { path: "/api/backup/tick", secret: "BACKUP_TICK_SECRET", every: 15 * MINUTE },
  { path: "/api/platform/tick", secret: "PLATFORM_TICK_SECRET", every: 60 * MINUTE },
];

function call(job) {
  const secret = process.env[job.secret]?.trim();
  if (!secret) return Promise.resolve(`skipped: ${job.secret} is not set`);
  return new Promise((resolve) => {
    const req = http.request(
      {
        ...APP,
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
        res.on("end", () => resolve(`${res.statusCode}${res.statusCode === 200 ? "" : ` ${body.slice(0, 300)}`}`));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve(`failed: ${err.message}`));
    req.end();
  });
}

for (const job of JOBS) {
  let running = false;
  const run = async () => {
    if (running) return; // the last one is still going: never two at once
    running = true;
    try {
      const outcome = await call(job);
      console.log(`${new Date().toISOString()} ${job.path} ${outcome}`);
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
console.log(`scheduler: ${JOBS.map((j) => `${j.path} every ${j.every / MINUTE} min`).join(", ")}`);
