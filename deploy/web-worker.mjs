/**
 * One copy of the web app in deploy/start.mjs's cluster (DESKZO_WEB_PROCESSES above one): `next start`,
 * as the container runs it alone. Next starts its server in this process, so the copies share the port
 * the cluster hands out.
 */
process.argv = [process.argv[0], "next", "start"];
await import("next/dist/bin/next");
