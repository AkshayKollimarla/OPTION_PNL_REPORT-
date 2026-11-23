// The options book, for whoever is asking.
//
// Each user works in an identical, independent copy of the schema -- the
// admin in options_pnl_report, everyone else in options_pnl_report_<slug>.
// Isolation is structural: there are no shared rows to filter, so no query
// can return someone else's trade by being written carelessly, and no route
// had to be audited to be sure it does not. The routes are unchanged -- they
// still `import pool from "./options-db"` and call pool.query -- except that
// the pool is now chosen at the moment of the call.
//
// lib/db.js is the same wrapper over the OTHER database, the one holding
// bot_entries. Both must exist: partitioning only this one is what let a new
// user read every bot entry on the box while his options book sat correctly
// empty.
//
// next/headers is imported STATICALLY and on purpose. It resolves only
// inside Next's own build, so this file cannot be loaded by a plain Node
// script -- the machinery that can is in lib/db-pools.js, which this wraps.
// Installing the lookup from instrumentation.js was tried instead, to keep
// this file loadable everywhere, and it silently failed: Next bundles the
// instrumentation hook separately from the app router, so route handlers
// read a different copy of the module variable, found no lookup, and served
// every user the admin's book.
//
// Outside a request -- the background workers, which run on a timer and
// belong to nobody -- the default is the admin. The workers do not rely on
// that: they name the user they mean, one at a time, through runWithSlug.

import { headers } from "next/headers";
import {
  poolFor, runWithSlug, resolveSlug, databaseFor, baseDatabase,
  oncePerDb as oncePerDbKeyed, closeAllPools,
} from "./db-pools.js";

export { poolFor, runWithSlug };

const REALM = "options";

/** What this request's session says, or null when there is no request. */
function fromRequest() {
  try {
    // Set by middleware from the signed cookie, and deleted there from
    // whatever the client sent under the same name.
    return headers().get("x-dash-slug");
  } catch {
    // No request in scope: a worker tick, or a call while the module loads.
    return null;
  }
}

export const currentSlug = () => resolveSlug(fromRequest());
export const currentDatabase = () => databaseFor(REALM, currentSlug());
export const currentPool = () => poolFor(REALM, currentSlug());
export const DEFAULT_DB = baseDatabase(REALM);

/** See db-pools.js. Keyed on the database this call belongs to. */
export const oncePerDb = (store, fn) => oncePerDbKeyed(store, currentDatabase(), fn);

// The same surface the mysql2 pool offered, resolved per call.
const pool = {
  query:         (...args) => currentPool().query(...args),
  execute:       (...args) => currentPool().execute(...args),
  getConnection: (...args) => currentPool().getConnection(...args),
  // Closing "the pool" now means closing all of them, which is what the one
  // caller of this -- a script finishing up -- actually wants.
  end:           closeAllPools,
};

export default pool;
