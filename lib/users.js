// Who can sign in, and which database each of them works in.
//
// This lives in a control database of its own rather than in anyone's book.
// Every user's database is an identical, independent copy of the schema, and
// a table listing the users could only sit in one of them -- which would make
// that one special, and make deleting it a way to lock everybody out.
//
// Passwords are stored as scrypt hashes. Not plain text, which is what the
// single env-var login used, and not a bare SHA: a password hash has to be
// SLOW or a leaked table is a wordlist away from being a list of passwords.
// scrypt is in Node's standard library, so this needs nothing installed.

import mysql from "mysql2/promise";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { PROFILES, databaseFor as dbForRealm, slugFor, safeSlug } from "./db-pools.js";

const AUTH_DB = process.env.AUTH_MYSQL_DATABASE || "trading_dashboard_auth";
const TABLE = "dashboard_users";

// Cost parameters. N is the work factor; 16384 is a few tens of milliseconds
// here, which is nothing on a login and a great deal across a dictionary.
const N = 16384, R = 8, P = 1, KEYLEN = 64;

const CACHE = "_dashboardUsersPool_v1";
let pool = global[CACHE];

function usersPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.OPTIONS_MYSQL_HOST     || "localhost",
      port:     Number(process.env.OPTIONS_MYSQL_PORT) || 3306,
      user:     process.env.OPTIONS_MYSQL_USER     || "root",
      password: process.env.OPTIONS_MYSQL_PASSWORD || "",
      database: AUTH_DB,
      waitForConnections: true,
      connectionLimit: 4,
      dateStrings: true,
    });
    global[CACHE] = pool;
  }
  return pool;
}

export const authDatabase = () => AUTH_DB;

/**
 * What to do about "Access denied ... to database".
 *
 * The driver's own message names the problem and not one thing to do about
 * it, and the fix -- a grant -- is not something to guess at: in a MySQL
 * grant pattern a bare underscore is a single-character wildcard, so the
 * obvious attempt at `options_pnl_report_%` hands out rights over far more
 * than was meant. The command is spelled out, escapes included.
 */
export function grantAdvice(message) {
  const BT = String.fromCharCode(96);           // a backtick, unquotable here
  const esc = (n) => String(n).replace(/_/g, "\\_");

  // One line per realm, because a user needs an empty copy of BOTH
  // databases and the two sit on different connection profiles -- often as
  // different MySQL users, so granting for one proves nothing about the
  // other. Deduplicated where they share a user, which is the common case.
  const grants = new Map();
  for (const realm of Object.keys(PROFILES)) {
    const who = process.env[`${PROFILES[realm].env}_USER`] || "root";
    const base = process.env[`${PROFILES[realm].env}_DATABASE`] || PROFILES[realm].base;
    if (!grants.has(who)) grants.set(who, new Set());
    grants.get(who).add(`${esc(base)}\\_%`);
  }
  // The user list lives on the options connection.
  const authUser = process.env[`${PROFILES.options.env}_USER`] || "root";
  if (!grants.has(authUser)) grants.set(authUser, new Set());
  grants.get(authUser).add(esc(AUTH_DB));

  const sql = [...grants.entries()].map(([who, patterns]) =>
    [...patterns].map((p) => `GRANT ALL PRIVILEGES ON ${BT}${p}${BT}.* TO '${who}'@'localhost';`).join(" ")
  ).join(" ");

  return [
    message,
    "",
    "  That MySQL user may not create databases, so there is nowhere to keep",
    "  the user list and nowhere to put a new user's data. This app uses TWO",
    "  databases and a new user needs an empty copy of each. As MySQL root:",
    "",
    `    sudo mysql -e "${sql} FLUSH PRIVILEGES;"`,
    "",
    "  The backslashes matter: a bare _ is a wildcard in a grant pattern, so",
    "  without them this hands out far more than it should.",
    "",
    "  Nothing is down while this is sorted out -- signing in keeps working",
    "  from .env, and existing data is untouched.",
  ].join("\n");
}

/**
 * The slug a username works under -- empty for the admin, who keeps the
 * databases under the names they already had.
 */
export const slugOf = (username, isAdmin = false) => (isAdmin ? "" : slugFor(username));

/** Every database a slug owns, across both realms. */
export const databasesFor = (slug) =>
  Object.keys(PROFILES).map((realm) => ({ realm, database: dbForRealm(realm, slug) }));

/* ── Passwords ──────────────────────────────────────── */

/** `scrypt$<salt>$<hash>`, both hex. The salt is per password, never shared. */
export function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("A password must be at least 8 characters.");
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Does this password match what was stored?
 *
 * Compared with timingSafeEqual rather than ===, so the time taken does not
 * depend on how many leading bytes were right. A string compare leaks that,
 * and a leak of that shape is enough to find a hash one byte at a time.
 */
export function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const want = Buffer.from(parts[2], "hex");
    const got = scryptSync(String(password ?? ""), salt, want.length, { N, r: R, p: P });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/* ── The table ──────────────────────────────────────── */

const _state = global._dashboardUsersReady || (global._dashboardUsersReady = { ready: null });

/**
 * The control database and its one table.
 *
 * Created on demand, like the rest of this app's tables, so a fresh install
 * and an upgrade take the same path.
 */
export async function ensureUsersTable() {
  if (_state.ready) return _state.ready;
  _state.ready = (async () => {
    // The database itself cannot be created through a pool already bound to
    // it, so this one connection is opened without one.
    const root = await mysql.createConnection({
      host:     process.env.OPTIONS_MYSQL_HOST     || "localhost",
      port:     Number(process.env.OPTIONS_MYSQL_PORT) || 3306,
      user:     process.env.OPTIONS_MYSQL_USER     || "root",
      password: process.env.OPTIONS_MYSQL_PASSWORD || "",
    });
    try {
      await root.query(`CREATE DATABASE IF NOT EXISTS \`${AUTH_DB}\`
                        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } catch (err) {
      // The bare driver message -- "Access denied for user 'x'@'localhost'
      // to database 'y'" -- names the problem and not one thing to do about
      // it. The fix is a grant, and a grant is not something to guess at:
      // an unescaped underscore in a MySQL grant pattern is a wildcard, so
      // the obvious attempt hands out far more than was meant.
      if (/access denied/i.test(err.message)) throw new Error(grantAdvice(err.message));
      throw err;
    } finally {
      await root.end();
    }
    await usersPool().query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        username      VARCHAR(64)  NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        slug          VARCHAR(32)  NOT NULL DEFAULT '',
        is_admin      TINYINT(1)   NOT NULL DEFAULT 0,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login    DATETIME     NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // An install created before the bot database was partitioned has
    // db_name and no slug. Added and backfilled rather than migrated by
    // hand, so an existing user keeps working without anyone remembering to.
    try { await usersPool().query(`ALTER TABLE ${TABLE} ADD COLUMN slug VARCHAR(32) NOT NULL DEFAULT ''`); }
    catch { /* already there */ }
    // db_name was how a user's database was recorded before there were two
    // of them. It is no longer written, so it has to stop being required --
    // otherwise adding a user fails on a column nothing fills in. Relaxed
    // rather than dropped: dropping it would throw away the old mapping
    // while this change is still new enough to want to look back at.
    try { await usersPool().query(`ALTER TABLE ${TABLE} MODIFY db_name VARCHAR(64) NULL DEFAULT NULL`); }
    catch { /* never had the column, or already relaxed */ }
    try {
      await usersPool().query(
        `UPDATE ${TABLE} SET slug = LOWER(username) WHERE slug = '' AND is_admin = 0`);
    } catch { /* nothing to backfill */ }
  })().catch((e) => { _state.ready = null; throw e; });
  return _state.ready;
}

export async function findUser(username) {
  await ensureUsersTable();
  const [rows] = await usersPool().query(
    `SELECT id, username, password_hash, slug, is_admin FROM ${TABLE} WHERE username = ? LIMIT 1`,
    [String(username || "").trim()]);
  if (!rows.length) return null;
  const r = rows[0];
  // A slug that is not a bare identifier is not quietly treated as the
  // admin's empty one: the row is unusable and nobody signs in on it.
  const slug = r.is_admin ? "" : safeSlug(r.slug);
  if (slug === null) return null;
  return { id: r.id, username: r.username, passwordHash: r.password_hash, slug, admin: !!r.is_admin };
}

export async function listUsers() {
  await ensureUsersTable();
  const [rows] = await usersPool().query(
    `SELECT username, slug, is_admin, created_at, last_login
       FROM ${TABLE} ORDER BY is_admin DESC, username`);
  return rows;
}

export async function countUsers() {
  await ensureUsersTable();
  const [[n]] = await usersPool().query(`SELECT COUNT(*) AS c FROM ${TABLE}`);
  return Number(n.c) || 0;
}

export async function upsertUser({ username, password, admin = false }) {
  await ensureUsersTable();
  const name = String(username || "").trim();
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(name)) {
    throw new Error("A username may use letters, digits, dot, dash and underscore only.");
  }
  const slug = slugOf(name, admin);
  if (!admin && !slug) throw new Error(`${name} has no usable slug.`);
  const hash = hashPassword(password);
  await usersPool().query(
    `INSERT INTO ${TABLE} (username, password_hash, slug, is_admin)
          VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash),
                             slug          = VALUES(slug),
                             is_admin      = VALUES(is_admin)`,
    [name, hash, slug, admin ? 1 : 0]);
  return { username: name, slug, admin: !!admin, databases: databasesFor(slug) };
}

export async function deleteUser(username) {
  await ensureUsersTable();
  const [r] = await usersPool().query(`DELETE FROM ${TABLE} WHERE username = ?`, [String(username).trim()]);
  return r.affectedRows;
}

export async function touchLogin(username) {
  try {
    await usersPool().query(`UPDATE ${TABLE} SET last_login = NOW() WHERE username = ?`, [username]);
  } catch {
    // A missed timestamp is not a reason to fail a login.
  }
}

/** Every user the background workers should pass over, as slugs. */
export async function allUserSlugs() {
  try {
    await ensureUsersTable();
    const [rows] = await usersPool().query(`SELECT DISTINCT slug, is_admin FROM ${TABLE}`);
    const slugs = rows.map((r) => (r.is_admin ? "" : safeSlug(r.slug))).filter((x) => x !== null);
    // The admin is included even before anyone is registered, so the workers
    // keep running exactly as they did on an install with no users yet.
    return [...new Set(["", ...slugs])];
  } catch {
    return [""];
  }
}

/**
 * Who is signing in, and into which book -- or null.
 *
 * The users table is the answer wherever it has a row for this name. Where
 * it does not, the environment variables that WERE the whole login still
 * work, as the admin, in the admin's database.
 *
 * That fallback is keyed on the NAME not being registered, not on the table
 * being empty. Gated on emptiness it looked equivalent and was not: adding a
 * second user would have retired the owner's own login and locked them out
 * of their book, from a command whose entire purpose was to let someone else
 * in. Run `node scripts/users.js adopt-admin` to move that login into the
 * table and retire the fallback deliberately.
 *
 * Once a name IS registered the table decides everything for it, so a
 * password changed there is not quietly undone by a stale .env.
 */
export async function authenticate(username, password) {
  const name = String(username ?? "");

  let row = null;
  try {
    row = await findUser(name);
  } catch {
    // The control database is unreachable. Fall through to the env login
    // rather than refusing every sign-in on this box.
  }

  if (row) {
    return verifyPassword(password, row.passwordHash)
      ? { user: row.username, slug: row.slug, admin: row.admin }
      : null;
  }

  const envUser = process.env.AUTH_USERNAME;
  const envPass = process.env.AUTH_PASSWORD;
  if (!envUser || !envPass) return null;
  if (name !== envUser || String(password ?? "") !== envPass) return null;
  return { user: envUser, slug: "", admin: true };
}
