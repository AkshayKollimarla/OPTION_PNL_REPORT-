#!/usr/bin/env node
//
// Who can sign in to this dashboard.
//
//   node scripts/users.js list
//   node scripts/users.js add <username> [--admin]
//   node scripts/users.js passwd <username>
//   node scripts/users.js remove <username> [--drop-db]
//   node scripts/users.js adopt-admin        (register the .env login as admin)
//   node scripts/users.js check              (what exists, and what is missing)
//
// The password is read from the terminal, never from an argument: an argument
// goes into shell history, into `ps` while it runs, and into any shell
// logging the box happens to have on.
//
// Adding a user BUILDS BOTH of their databases -- the options book and the
// bot entries. Both, because this app keeps data in two of them, and giving
// a new user only the first is what let them read every bot entry on the box
// while their options book sat correctly empty.
//
// The tables are copied from the live schema rather than from schema.sql:
// several routes add their own columns on first use, so the file on disk
// drifts behind what the app has actually migrated itself to. Structure
// only -- not one row comes across.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const mysql = require("mysql2/promise");

loadEnv();

const ARGS = process.argv.slice(2);
const CMD = ARGS[0];
const flag = (name) => ARGS.includes(`--${name}`);

const AUTH_DB = process.env.AUTH_MYSQL_DATABASE || "trading_dashboard_auth";

// The two databases this app keeps data in, each on its own connection
// profile with its own environment variables.
const REALMS = [
  { key: "options", label: "options book", env: "OPTIONS_MYSQL", fallback: "options_pnl_report" },
  { key: "bot",     label: "bot entries",  env: "MYSQL",         fallback: "trading_dashboard"  },
];
const baseOf = (r) => process.env[`${r.env}_DATABASE`] || r.fallback;
const dbFor = (r, slug) => (slug ? `${baseOf(r)}_${slug}` : baseOf(r));

const conn = (realm, database) => mysql.createConnection({
  host:     process.env[`${realm.env}_HOST`] || "localhost",
  port:     Number(process.env[`${realm.env}_PORT`]) || 3306,
  user:     process.env[`${realm.env}_USER`] || "root",
  password: process.env[`${realm.env}_PASSWORD`] || "",
  ...(database ? { database } : {}),
  multipleStatements: false,
});

main().catch((e) => { console.error("\n" + e.message + "\n"); process.exit(1); });

async function main() {
  switch (CMD) {
    case "list":        return list();
    case "add":         return add();
    case "passwd":      return passwd();
    case "remove":      return remove();
    case "adopt-admin": return adoptAdmin();
    case "check":       return check();
    default:
      console.log(fs.readFileSync(__filename, "utf8")
        .split("\n").slice(2, 10).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(CMD ? 1 : 0);
  }
}

/* ── commands ───────────────────────────────────────── */

async function list() {
  const { listUsers } = await lib();
  const rows = await listUsers();
  if (!rows.length) {
    console.log("\nNo users registered. The .env login still works as admin until one is.\n");
    console.log("  node scripts/users.js adopt-admin     register it properly");
    console.log("  node scripts/users.js add akshay      add a second user\n");
    return done();
  }
  console.log("");
  console.log("USERNAME".padEnd(18) + "ROLE".padEnd(8) + "DATABASES".padEnd(46) + "LAST LOGIN");
  for (const r of rows) {
    const slug = r.is_admin ? "" : r.slug;
    console.log(String(r.username).padEnd(18)
      + (r.is_admin ? "admin" : "user").padEnd(8)
      + REALMS.map((x) => dbFor(x, slug)).join("  ").padEnd(46)
      + (r.last_login || "never"));
  }
  console.log("");
  return done();
}

async function add() {
  const { upsertUser, findUser, slugOf } = await lib();
  const username = ARGS[1];
  if (!username) throw new Error("Usage: node scripts/users.js add <username> [--admin]");
  if (await findUser(username)) {
    throw new Error(`${username} already exists. Use \`passwd\` to change their password.`);
  }

  const admin = flag("admin");
  const slug = slugOf(username, admin);
  const password = await askPassword(`Password for ${username}`);

  // The databases first: a user who can sign in to databases that do not
  // exist gets an error on every page, which is worse than not existing.
  for (const realm of REALMS) await provision(realm, slug);
  await upsertUser({ username, password, admin });

  console.log(`\n  ${username} added${admin ? " as admin" : ""}.`);
  for (const realm of REALMS) console.log(`    ${realm.label.padEnd(14)} ${dbFor(realm, slug)}`);
  if (!admin) console.log("\n  They start with nothing in either — their own empty dashboard.\n");
  return done();
}

async function passwd() {
  const { upsertUser, findUser } = await lib();
  const username = ARGS[1];
  if (!username) throw new Error("Usage: node scripts/users.js passwd <username>");
  const existing = await findUser(username);
  if (!existing) throw new Error(`No user called ${username}.`);
  const password = await askPassword(`New password for ${username}`);
  await upsertUser({ username, password, admin: existing.admin });
  console.log(`\n  Password changed for ${username}.\n`);
  return done();
}

async function remove() {
  const { deleteUser, findUser } = await lib();
  const username = ARGS[1];
  if (!username) throw new Error("Usage: node scripts/users.js remove <username> [--drop-db]");
  const existing = await findUser(username);
  if (!existing) throw new Error(`No user called ${username}.`);

  const dropping = flag("drop-db");
  if (dropping && !existing.slug) {
    throw new Error(`${username} is the admin and works in the main databases. Refusing to drop them.`);
  }
  const theirs = REALMS.map((r) => dbFor(r, existing.slug));

  const answer = await ask(
    `Remove ${username}${dropping ? ` AND DROP ${theirs.join(" and ")} with everything in them` : ""}? [y/N] `);
  if (!/^y/i.test(answer)) { console.log("\n  Left alone.\n"); return done(); }

  await deleteUser(username);
  if (dropping) {
    for (const realm of REALMS) {
      const c = await conn(realm);
      try { await c.query(`DROP DATABASE IF EXISTS \`${dbFor(realm, existing.slug)}\``); }
      finally { await c.end(); }
    }
    console.log(`\n  ${username} removed, ${theirs.join(" and ")} dropped.\n`);
  } else {
    console.log(`\n  ${username} removed. ${theirs.join(" and ")} are left in place —`);
    console.log("  drop them by hand, or re-run with --drop-db, if you want them gone.\n");
  }
  return done();
}

/** Put the .env credentials into the table, so the fallback stops being load-bearing. */
async function adoptAdmin() {
  const { upsertUser, findUser } = await lib();
  const username = process.env.AUTH_USERNAME;
  if (!username) throw new Error("AUTH_USERNAME is not set in .env, so there is nothing to adopt.");
  if (await findUser(username)) throw new Error(`${username} is already registered.`);
  const password = process.env.AUTH_PASSWORD;
  if (!password) throw new Error("AUTH_PASSWORD is not set in .env.");
  if (password.length < 8) throw new Error("That password is under 8 characters; set a longer one first.");

  await upsertUser({ username, password, admin: true });
  console.log(`\n  ${username} registered as admin, working in ${REALMS.map(baseOf).join(" and ")}`);
  console.log("  — the databases as they already are. Nothing moved: this only writes");
  console.log("  down what the .env login already meant.\n");
  return done();
}

/** What exists and what does not, without changing anything. */
async function check() {
  const { listUsers } = await lib().catch(() => ({ listUsers: null }));
  console.log("");
  for (const realm of REALMS) {
    const c = await conn(realm).catch(() => null);
    if (!c) { console.log(`  ${realm.label.padEnd(14)} cannot connect`); continue; }
    try {
      const [rows] = await c.query("SHOW DATABASES");
      const key = Object.keys(rows[0] || {})[0];
      const have = new Set(rows.map((r) => r[key]));
      const base = baseOf(realm);
      console.log(`  ${realm.label.padEnd(14)} ${base}${have.has(base) ? "" : "   MISSING"}`);
      // The control database shares the bot database's prefix, so it would
      // otherwise be listed as somebody's book.
      const mine = (n) => n.startsWith(base + "_") && n !== AUTH_DB && !n.startsWith(AUTH_DB + "_");
      for (const n of [...have].filter(mine).sort()) {
        console.log(`  ${"".padEnd(14)} ${n}`);
      }
    } finally { await c.end(); }
  }
  if (listUsers) {
    const rows = await listUsers().catch(() => []);
    console.log(`\n  registered users: ${rows.length ? rows.map((r) => r.username).join(", ") : "none (.env login active)"}`);
  }
  console.log("");
  return done();
}

/* ── the databases behind a user ────────────────────── */

/**
 * An empty copy of a realm's schema.
 *
 * CREATE TABLE ... LIKE, table by table, so the structure matches exactly
 * what the app has migrated itself to and not one row comes across.
 * Existing tables are left alone, so running this twice is safe and so is
 * running it after a new table has appeared.
 */
async function provision(realm, slug) {
  const db = dbFor(realm, slug);
  const base = baseOf(realm);
  if (db === base) return;                       // the admin already has it
  if (!/^[A-Za-z0-9_]{1,64}$/.test(db)) throw new Error(`Not a usable database name: ${db}`);

  const root = await conn(realm);
  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${db}\`
                      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (e) {
    // The same advice the library gives, so the two cannot drift into saying
    // different things about the same missing grant.
    const { grantAdvice } = await lib();
    throw new Error(/access denied/i.test(e.message)
      ? grantAdvice(e.message)
      : `Could not create ${db}: ${e.message}`);
  } finally {
    await root.end();
  }

  const src = await conn(realm, base);
  const dst = await conn(realm, db);
  try {
    const [tables] = await src.query(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [base]);
    const [have] = await dst.query(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [db]);
    const already = new Set(have.map((r) => r.t));

    let made = 0;
    for (const { t } of tables) {
      if (already.has(t)) continue;
      await dst.query(`CREATE TABLE \`${db}\`.\`${t}\` LIKE \`${base}\`.\`${t}\``);
      made++;
    }
    console.log(`  ${db}: ${made} table${made === 1 ? "" : "s"} created`
      + `${already.size ? `, ${already.size} already there` : ""} — no rows copied.`);
  } finally {
    await src.end();
    await dst.end();
  }
}

/* ── plumbing ───────────────────────────────────────── */

// The library is ESM and this script is CommonJS, so it is imported rather
// than required. One copy of the password and user rules, not two.
async function lib() {
  const url = "file:///" + path.join(__dirname, "..", "lib", "users.js").replace(/\\/g, "/");
  return import(url);
}

async function done() {
  const { ensureUsersTable } = await lib();
  await ensureUsersTable().catch(() => {});
  process.exit(0);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

/**
 * A password typed without being echoed, asked twice.
 */
function askPassword(prompt) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const mute = () => { rl._writeToOutput = (s) => { if (s.includes(":")) rl.output.write(s); }; };
    rl.question(`${prompt}: `, (first) => {
      rl.question("\nAgain to confirm: ", (second) => {
        rl.close();
        process.stdout.write("\n");
        if (first !== second) return reject(new Error("Those did not match. Nothing was changed."));
        if (first.length < 8) return reject(new Error("A password must be at least 8 characters."));
        resolve(first);
      });
      mute();
    });
    mute();
  });
}

// .env, read here because a bare node script gets none of Next's loading.
function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(__dirname, "..", name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}
