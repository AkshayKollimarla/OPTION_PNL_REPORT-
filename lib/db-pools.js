// One connection pool per user database, and the rules for choosing between
// them. Deliberately free of anything Next-specific: this file can be loaded
// by a plain Node script, which is what lets the choosing be tested at all.
//
// lib/options-db.js wraps this with the one thing that cannot live here --
// reading the current request's headers, which needs next/headers and so
// only resolves inside Next's own build.

import mysql from "mysql2/promise";
import { AsyncLocalStorage } from "node:async_hooks";
import { safeDbName } from "./session.js";

export const DEFAULT_DB = process.env.OPTIONS_MYSQL_DATABASE || "options_pnl_report";

// Cached on the global, not in a module variable. Next builds the app
// router, the instrumentation hook and the middleware as separate bundles,
// each with its OWN copy of every module it imports -- so a module-level Map
// here would become one pool registry per bundle, each opening its own
// connections to the same databases.
//
// That is not a theory. The request resolver was first installed from
// instrumentation.js into a module variable, and route handlers read a
// different copy of that variable, found it empty, and served every user the
// admin's book. The global is what crosses the boundary.
const CACHE = "_optionsMysqlPools_v3";
const pools = global[CACHE] || (global[CACHE] = new Map());

export function poolFor(database) {
  const db = safeDbName(database) || DEFAULT_DB;
  let p = pools.get(db);
  if (!p) {
    p = mysql.createPool({
      host:             process.env.OPTIONS_MYSQL_HOST     || "localhost",
      port:             Number(process.env.OPTIONS_MYSQL_PORT) || 3306,
      user:             process.env.OPTIONS_MYSQL_USER     || "root",
      password:         process.env.OPTIONS_MYSQL_PASSWORD || "",
      database:         db,
      waitForConnections: true,
      connectionLimit:  10,
      decimalNumbers:   true,
      dateStrings:      true,   // keep DATE/DATETIME as "YYYY-MM-DD" strings, never Date objects
    });
    pools.set(db, p);
  }
  return p;
}

export const closeAllPools = () => Promise.all([...pools.values()].map((p) => p.end()));

// Shared for the same reason the pools are: a worker that enters a context in
// one bundle and a library that reads it in another must be looking at the
// same store.
const als = global.__dashDbAls || (global.__dashDbAls = new AsyncLocalStorage());

/** Run `fn` with `db` as the current database for everything underneath it. */
export function runWithDb(db, fn) {
  return als.run(safeDbName(db) || DEFAULT_DB, fn);
}

/** The database a worker has named, or null when none has. */
export const namedDatabase = () => als.getStore() || null;

/**
 * The database to use, given whatever the current request says.
 *
 * A worker's explicit name wins, because naming it means it. Then the
 * request. Then the admin's, which is where a module-level call lands.
 */
export function resolveDatabase(fromRequest) {
  return namedDatabase() || safeDbName(fromRequest) || DEFAULT_DB;
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
