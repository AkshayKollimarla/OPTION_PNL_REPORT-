// The bot's own database -- bot_entries -- for whoever is asking.
//
// This is the other half of the partition. The Dashboard, Summary Report,
// Entry Fields and Analysis pages are all built from this one table, through
// seven routes that import this pool, and for a while it was the only thing
// left shared: a new user's options book was correctly empty while every bot
// entry on the box was still his to read.
//
// Same wrapper, same rules, different realm. See lib/db-pools.js for why the
// session carries a user and not a database name, and lib/options-db.js for
// why next/headers is imported here rather than installed from elsewhere.

import { headers } from "next/headers";
import {
  poolFor, resolveSlug, databaseFor, baseDatabase,
  oncePerDb as oncePerDbKeyed, closeAllPools,
} from "./db-pools.js";

const REALM = "bot";

function fromRequest() {
  try {
    return headers().get("x-dash-slug");
  } catch {
    return null;
  }
}

export const currentSlug = () => resolveSlug(fromRequest());
export const currentDatabase = () => databaseFor(REALM, currentSlug());
export const currentPool = () => poolFor(REALM, currentSlug());
export const DEFAULT_DB = baseDatabase(REALM);

export const oncePerDb = (store, fn) => oncePerDbKeyed(store, currentDatabase(), fn);

const pool = {
  query:         (...args) => currentPool().query(...args),
  execute:       (...args) => currentPool().execute(...args),
  getConnection: (...args) => currentPool().getConnection(...args),
  end:           closeAllPools,
};

export default pool;
