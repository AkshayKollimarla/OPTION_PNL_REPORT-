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
import { safeDbName } from "./session.js";

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
  const user = process.env.OPTIONS_MYSQL_USER || "root";
  const base = process.env.OPTIONS_MYSQL_DATABASE || "options_pnl_report";
  const esc = (n) => String(n).replace(/_/g, "\\_");
  const on = (pattern) => `${BT}${pattern}${BT}.* TO '${user}'@'localhost'`;

  return [
    message,
    "",
    `  '${user}' may not create databases, so there is nowhere to keep the user`,
    "  list and nowhere to put a new user's book. As MySQL root:",
    "",
    `    sudo mysql -e "GRANT ALL PRIVILEGES ON ${on(esc(base) + "\\_%")};`
      + ` GRANT ALL PRIVILEGES ON ${on(esc(AUTH_DB))}; FLUSH PRIVILEGES;"`,
    "",
    "  The backslashes matter: a bare _ is a wildcard in a grant pattern.",
    "  Nothing else is affected -- signing in keeps working from .env until a",
    "  user exists, so the dashboard is not down while this is sorted out.",
  ].join("\n");
}

/** The database a username works in, by convention. */
export function databaseFor(username, isAdmin = false) {
  const base = process.env.OPTIONS_MYSQL_DATABASE || "options_pnl_report";
  if (isAdmin) return base;
  const slug = String(username).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
  return `${base}_${slug}`;
}

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
        db_name       VARCHAR(64)  NOT NULL,
        is_admin      TINYINT(1)   NOT NULL DEFAULT 0,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login    DATETIME     NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  })().catch((e) => { _state.ready = null; throw e; });
  return _state.ready;
}

export async function findUser(username) {
  await ensureUsersTable();
  const [rows] = await usersPool().query(
    `SELECT id, username, password_hash, db_name, is_admin FROM ${TABLE} WHERE username = ? LIMIT 1`,
    [String(username || "").trim()]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    db: safeDbName(r.db_name),
    admin: !!r.is_admin,
  };
}

export async function listUsers() {
  await ensureUsersTable();
  const [rows] = await usersPool().query(
    `SELECT username, db_name, is_admin, created_at, last_login
       FROM ${TABLE} ORDER BY is_admin DESC, username`);
  return rows;
}

export async function countUsers() {
  await ensureUsersTable();
  const [[n]] = await usersPool().query(`SELECT COUNT(*) AS c FROM ${TABLE}`);
  return Number(n.c) || 0;
}

export async function upsertUser({ username, password, db, admin = false }) {
  await ensureUsersTable();
  const name = String(username || "").trim();
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(name)) {
    throw new Error("A username may use letters, digits, dot, dash and underscore only.");
  }
  const dbName = safeDbName(db || databaseFor(name, admin));
  if (!dbName) throw new Error(`Not a usable database name: ${db}`);
  const hash = hashPassword(password);
  await usersPool().query(
    `INSERT INTO ${TABLE} (username, password_hash, db_name, is_admin)
          VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash),
                             db_name       = VALUES(db_name),
                             is_admin      = VALUES(is_admin)`,
    [name, hash, dbName, admin ? 1 : 0]);
  return { username: name, db: dbName, admin: !!admin };
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

/** Every database the app should be working in -- for the background workers. */
export async function allUserDatabases() {
  try {
    await ensureUsersTable();
    const [rows] = await usersPool().query(`SELECT DISTINCT db_name FROM ${TABLE}`);
    const names = rows.map((r) => safeDbName(r.db_name)).filter(Boolean);
    const base = process.env.OPTIONS_MYSQL_DATABASE || "options_pnl_report";
    // The admin's book is included even before anyone is registered, so the
    // workers keep running exactly as they did on an install that has not
    // been given users yet.
    return names.length ? [...new Set([base, ...names])] : [base];
  } catch {
    return [process.env.OPTIONS_MYSQL_DATABASE || "options_pnl_report"];
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
      ? { user: row.username, db: row.db, admin: row.admin }
      : null;
  }

  const envUser = process.env.AUTH_USERNAME;
  const envPass = process.env.AUTH_PASSWORD;
  if (!envUser || !envPass) return null;
  if (name !== envUser || String(password ?? "") !== envPass) return null;
  return { user: envUser, db: databaseFor(envUser, true), admin: true };
}
