// Makes the platform's three databases if they don't exist yet: the first workspace's (DATABASE_URL),
// the control plane's (CONTROL_DATABASE_URL) and the reference data's (REFERENCE_DATABASE_URL). It
// connects through PLATFORM_PROVISIONER_URL, the role that may create databases. Safe to run again:
// one that exists is left exactly as it is. Prints names only, never an address.
//   node deploy/create-databases.mjs
import pg from "pg";

const provisioner = process.env.PLATFORM_PROVISIONER_URL?.trim();
if (!provisioner) {
  console.error("PLATFORM_PROVISIONER_URL is not set.");
  process.exit(1);
}

const wanted = ["DATABASE_URL", "CONTROL_DATABASE_URL", "REFERENCE_DATABASE_URL"].map((key) => {
  const url = process.env[key]?.trim();
  if (!url) throw new Error(`${key} is not set.`);
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`${key} names a database "${name}": use lower-case letters, digits and _ only.`);
  return name;
});

const client = new pg.Client({ connectionString: provisioner });
await client.connect();
try {
  for (const name of new Set(wanted)) {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (rowCount) {
      console.log(`  ${name}: already there`);
    } else {
      await client.query(`create database "${name}"`);
      console.log(`  ${name}: made`);
    }
  }
} finally {
  await client.end();
}
