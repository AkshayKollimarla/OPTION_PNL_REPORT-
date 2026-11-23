// The database this request belongs to.
//
// Each user works in an identical, independent copy of the schema -- the
// admin in options_pnl_report, everyone else in options_pnl_report_<name>.
// Isolation is therefore structural: there are no shared rows to filter, so
// no query can return someone else's trade by being written carelessly, and
// no route has to be audited to be sure it does not.
//
// Which copy is decided HERE, once, from the header middleware sets out of
// the signed session cookie -- never from anything a caller passes in. The
// default export keeps the shape of the mysql2 pool it replaced, so the
// thirty-odd routes and the libraries under them are unchanged: they still
// `import pool from "./options-db"` and still call pool.query. What changed
// is that the pool is chosen at the moment of the call rather than at import.
//
// next/headers is imported STATICALLY and on purpose. It resolves only
// inside Next's own build, so this file cannot be loaded by a plain Node
// script -- the machinery that can is in lib/db-pools.js, which this wraps
// and re-exports. Installing the lookup from instrumentation.js was tried
// instead, to keep this file loadable everywhere, and it silently failed:
// Next bundles the instrumentation hook separately from the app router, so
// the route handlers read a different copy of the module variable, found no
// lookup, and served every user the admin's book. Imported here, it is in
// the same bundle as the handler that needs it.
//
// Outside a request -- the background workers, which run on a timer and
// belong to nobody -- the default is the admin's database. The workers do
// not rely on that: they name the database they mean, one at a time, through
// runWithDb, so a second user's open strategies are watched too.

import { headers } from "next/headers";
import {
  poolFor, runWithDb, resolveDatabase, oncePerDb as oncePerDbKeyed,
  closeAllPools, DEFAULT_DB,
} from "./db-pools.js";

export { poolFor, runWithDb, DEFAULT_DB };

/** What this request's session says, or null when there is no request. */
function fromRequest() {
  try {
    // Set by middleware from the signed cookie, and deleted there from
    // whatever the client sent under the same name.
    return headers().get("x-dash-db");
  } catch {
    // No request in scope: a worker tick, or a call while the module loads.
    return null;
  }
}

export const currentDatabase = () => resolveDatabase(fromRequest());
export const currentPool = () => poolFor(currentDatabase());

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
