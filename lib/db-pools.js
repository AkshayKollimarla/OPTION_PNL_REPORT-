// Which databases a request may read, and the pools that reach them.
//
// This app keeps its data in TWO databases, on two separate connection
// profiles with two separate sets of environment variables:
//
//   options   OPTIONS_MYSQL_*  options_pnl_report   the options book, the
//                                                   accounts, the auto-close
//                                                   jobs, the price alerts
//   bot       MYSQL_*          trading_dashboard    bot_entries: the grid
//                                                   bot's own entries, which
//                                                   the Dashboard, Summary
//                                                   Report, Entry Fields and
//                                                   Analysis pages are built
//                                                   from
//
// Both have to be partitioned per user or the second one leaks everything the
// first one protects. Making only the options side per-user is exactly what
// happened first, and a new user could still read every bot entry on the box.
//
// So what travels in the session is a SLUG -- the user, not a database.
// Carrying one database name worked while there was one database and breaks
// the moment there are two, because the same user is options_pnl_report_x in
// one realm and trading_dashboard_x in the other. Each realm derives its own
// name from the slug, and a realm added later gets partitioned by writing one
// line in PROFILES rather than by remembering to.
//
// Deliberately free of anything Next-specific, so the rules can be tested by
// a plain Node script. lib/options-db.js and lib/db.js wrap this with the one
// thing that cannot live here: reading the current request.

import mysql from "mysql2/promise";
import { AsyncLocalStorage } from "node:async_hooks";

export const PROFILES = {
  options: { env: "OPTIONS_MYSQL", base: "options_pnl_report" },
  bot:     { env: "MYSQL",         base: "trading_dashboard"  },
};

const setting = (realm, key, fallback) => {
  const p = PROFILES[realm];
  if (!p) throw new Error(`No such database profile: ${realm}`);
  return process.env[`${p.env}_${key}`] || fallback;
};

/** The admin's database in this realm -- the one that already holds the data. */
export const baseDatabase = (realm) => setting(realm, "DATABASE", PROFILES[realm]?.base);

/**
 * A slug safe to build a database name out of.
 *
 * The empty string is the ADMIN and is valid: they work in the base database,
 * under its original name, so nothing had to be moved to introduce users.
 * Anything that is not a bare lowercase identifier is not a slug at all --
 * null, so the caller can tell it apart from the admin's "" rather than
 * silently treating a malformed one as the owner.
 */
export const SAFE_SLUG = /^[a-z0-9_]{1,32}$/;
export function safeSlug(slug) {
  if (slug === "" || slug === null || slug === undefined) return slug === "" ? "" : null;
  const s = String(slug);
  return SAFE_SLUG.test(s) ? s : null;
}

/** Turn a username into the slug it works under. */
export const slugFor = (username) =>
  String(username || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);

/** Which database this slug reads in this realm. */
export function databaseFor(realm, slug) {
  const base = baseDatabase(realm);
  const s = safeSlug(slug);
  return s ? `${base}_${s}` : base;
}

// Cached on the global, not in a module variable. Next builds the app router,
// the instrumentation hook and the middleware as separate bundles, each with
// its OWN copy of every module it imports -- so a module-level Map would
// become one pool registry per bundle, each opening its own connections to
// the same databases.
//
// That is not a theory. The request lookup was first installed from
// instrumentation.js into a module variable, route handlers read a different
// copy of it, found it empty, and served every user the admin's book.
const CACHE = "_dashMysqlPools_v4";
const pools = global[CACHE] || (global[CACHE] = new Map());

export function poolFor(realm, slug) {
  const database = databaseFor(realm, slug);
  const key = `${realm}:${database}`;
  let p = pools.get(key);
  if (!p) {
    p = mysql.createPool({
      host:     setting(realm, "HOST", "localhost"),
      port:     Number(setting(realm, "PORT", 3306)),
      user:     setting(realm, "USER", "root"),
      password: process.env[`${PROFILES[realm].env}_PASSWORD`] || "",
      database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      decimalNumbers: true,
      dateStrings: true,   // keep DATE/DATETIME as "YYYY-MM-DD" strings, never Date objects
    });
    pools.set(key, p);
  }
  return p;
}

export const closeAllPools = () => Promise.all([...pools.values()].map((p) => p.end()));

// Shared for the same reason the pools are: a worker that enters a context in
// one bundle and a library that reads it in another must see the same store.
const als = global.__dashSlugAls || (global.__dashSlugAls = new AsyncLocalStorage());

/** Run `fn` as this user, for every realm underneath it. */
export function runWithSlug(slug, fn) {
  return als.run(safeSlug(slug) ?? "", fn);
}

/**
 * The slug a worker has named, or null when none has.
 *
 * Checked against undefined rather than for truthiness: the admin's slug is
 * the empty string, so "" means the admin and undefined means nobody said.
 */
export function namedSlug() {
  const s = als.getStore();
  return s === undefined ? null : s;
}

/**
 * Whose data to read, given whatever the current request says.
 *
 * A worker's explicit slug wins, because naming it means it. Then the
 * request. Then the admin, which is where a module-level call lands and is
 * the behaviour this had before there were users at all.
 */
export function resolveSlug(fromRequest) {
  const named = namedSlug();
  if (named !== null) return named;
  return safeSlug(fromRequest) ?? "";
}

/**
 * A setup step that must run once per DATABASE, not once per process.
 *
 * Several tables here are created and migrated on first use, each memoised
 * so the DDL is not re-sent on every request. With one database that was
 * right. With one per user it means the step runs for whichever user asked
 * first and is skipped for everyone else -- leaving the second user's book
 * missing the very table the call was there to guarantee.
 *
 * Keyed by database, and by the function itself so a hot reload in
 * development re-runs it exactly as the single-database version did. A
 * failure drops the entry so the next caller retries rather than inheriting
 * a rejected promise for the life of the process.
 */
export function oncePerDb(store, db, fn) {
  const hit = store.get(db);
  if (hit && hit.fn === fn) return hit.promise;
  const promise = Promise.resolve().then(fn).catch((e) => { store.delete(db); throw e; });
  store.set(db, { fn, promise });
  return promise;
}
