#!/usr/bin/env node
//
// Who can sign in to this dashboard.
//
//   node scripts/users.js list
//   node scripts/users.js add <username> [--admin] [--db <name>]
//   node scripts/users.js passwd <username>
//   node scripts/users.js remove <username> [--drop-db]
//   node scripts/users.js adopt-admin        (register the .env login as admin)
//
// The password is read from the terminal, never from an argument: an argument
// goes into shell history, into `ps` while it runs, and into any shell
// logging the box happens to have on.
//
// Adding a user also BUILDS their database: the same tables as the admin's,
// structure for structure, with no rows in them. Copied from the live schema
// rather than from schema.sql, because the live one is what the app has
// actually migrated itself to -- several routes add their own columns on
// first use, and a file on disk drifts behind that silently.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const mysql = require("mysql2/promise");

loadEnv();

const ARGS = process.argv.slice(2);
const CMD = ARGS[0];
const flag = (name) => ARGS.includes(`--${name}`);
const opt = (name) => {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 ? ARGS[i + 1] : null;
};

const BASE_DB = process.env.OPTIONS_MYSQL_DATABASE || "options_pnl_report";
const AUTH_DB = process.env.AUTH_MYSQL_DATABASE || "trading_dashboard_auth";

const conn = (database) => mysql.createConnection({
  host:     process.env.OPTIONS_MYSQL_HOST || "localhost",
  port:     Number(process.env.OPTIONS_MYSQL_PORT) || 3306,
  user:     process.env.OPTIONS_MYSQL_USER || "root",
  password: process.env.OPTIONS_MYSQL_PASSWORD || "",
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
    default:
      console.log(fs.readFileSync(__filename, "utf8")
        .split("\n").slice(2, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
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
  console.log("USERNAME".padEnd(20) + "DATABASE".padEnd(34) + "ROLE".padEnd(8) + "LAST LOGIN");
  for (const r of rows) {
    console.log(String(r.username).padEnd(20)
      + String(r.db_name).padEnd(34)
      + (r.is_admin ? "admin" : "user").padEnd(8)
      + (r.last_login || "never"));
  }
  console.log("");
  return done();
}

async function add() {
  const { upsertUser, findUser, databaseFor } = await lib();
  const username = ARGS[1];
  if (!username) throw new Error("Usage: node scripts/users.js add <username> [--admin] [--db <name>]");
  if (await findUser(username)) {
    throw new Error(`${username} already exists. Use \`passwd\` to change their password.`);
  }

  const admin = flag("admin");
  const db = opt("db") || databaseFor(username, admin);
  const password = await askPassword(`Password for ${username}`);

  // The database first: a user who can sign in to a database that does not
  // exist gets an error on every page, which is worse than not existing.
  await provision(db);
  await upsertUser({ username, password, db, admin });

  console.log(`\n  ${username} added${admin ? " as admin" : ""}, working in ${db}.\n`);
  if (!admin) console.log("  They start with no accounts and no trades — their own empty book.\n");
  return done();
}

async function passwd() {
  const { upsertUser, findUser } = await lib();
  const username = ARGS[1];
  if (!username) throw new Error("Usage: node scripts/users.js passwd <username>");
  const existing = await findUser(username);
  if (!existing) throw new Error(`No user called ${username}.`);
  const password = await askPassword(`New password for ${username}`);
  await upsertUser({ username, password, db: existing.db, admin: existing.admin });
  console.log(`\n  Password changed for ${username}.\n`);
  return done();
}

async function remove() {
  const { deleteUser, findUser } = await lib();
  const username = ARGS[1];
  if (!username) throw new Error("Usage: node scripts/users.js remove <username> [--drop-db]");
  const existing = await findUser(username);
  if (!existing) throw new Error(`No user called ${username}.`);
  if (existing.db === BASE_DB && flag("drop-db")) {
    throw new Error(`${username} works in the main database. Refusing to drop ${BASE_DB}.`);
  }

  const ok = await ask(`Remove ${username}${flag("drop-db") ? ` AND DROP ${existing.db} with everything in it` : ""}? [y/N] `);
  if (!/^y/i.test(ok)) { console.log("\n  Left alone.\n"); return done(); }

  await deleteUser(username);
  if (flag("drop-db")) {
    const c = await conn();
    try { await c.query(`DROP DATABASE IF EXISTS \`${existing.db}\``); } finally { await c.end(); }
    console.log(`\n  ${username} removed and ${existing.db} dropped.\n`);
  } else {
    console.log(`\n  ${username} removed. ${existing.db} is left in place — drop it by hand if you want it gone.\n`);
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

  await upsertUser({ username, password, db: BASE_DB, admin: true });
  console.log(`\n  ${username} registered as admin, working in ${BASE_DB} — the book as it already is.`);
  console.log("  Nothing moved: this only writes down what the .env login already meant.\n");
  return done();
}

/* ── the database behind a user ─────────────────────── */

/**
 * An empty copy of the admin's schema.
 *
 * CREATE TABLE ... LIKE, table by table, so the structure matches exactly
 * what the app has migrated itself to and not one row comes across. Existing
 * tables are left alone, so running this twice is safe and so is running it
 * after a new table has appeared.
 */
async function provision(db) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(db)) throw new Error(`Not a usable database name: ${db}`);

  const root = await conn();
  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${db}\`
                      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (e) {
    throw new Error(`Could not create ${db}: ${e.message}\n`
      + `  The MySQL user needs CREATE rights. Check OPTIONS_MYSQL_USER in .env.`);
  } finally {
    await root.end();
  }

  const src = await conn(BASE_DB);
  const dst = await conn(db);
  try {
    const [tables] = await src.query(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [BASE_DB]);
    const [have] = await dst.query(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [db]);
    const already = new Set(have.map((r) => r.t));

    let made = 0;
    for (const { t } of tables) {
      if (already.has(t)) continue;
      await dst.query(`CREATE TABLE \`${db}\`.\`${t}\` LIKE \`${BASE_DB}\`.\`${t}\``);
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
 *
 * Not perfect concealment -- a terminal that does not support it still shows
 * nothing useful, because the characters are simply not written back.
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
