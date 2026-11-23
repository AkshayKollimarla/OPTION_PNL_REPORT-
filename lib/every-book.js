// Running a background pass over every user's book.
//
// The workers belong to nobody. They are timers, not requests, so there is no
// session to tell them whose database to look in -- and with a database per
// user, "the" database is no longer a question with one answer. A pass that
// read only the default one would watch the admin's open strategies and
// quietly ignore everyone else's: no alerts, and no auto-close, for a
// position that is just as real.
//
// So each pass is run once per database, named explicitly through runWithDb.
//
// One at a time rather than all at once. These passes place orders and send
// messages; running them concurrently would have two of them contending for
// the same venue rate limit, and Deribit allows one token per API key, which
// the auto-close workers already have to be careful about between themselves.

// From db-pools rather than options-db: a worker has no request, so it has
// no use for the layer that reads one -- and that layer can only be loaded
// inside Next, which would make this file untestable for no gain.
import { runWithDb } from "./db-pools.js";
import { allUserDatabases } from "./users.js";

/**
 * Run `fn` once for each user's database.
 *
 * A database that throws is reported and the rest still run. One user's
 * unreachable book, missing table or venue error must not stop another
 * user's stop-loss from firing -- which is exactly what a single rejected
 * promise across a shared loop would do.
 *
 * @returns the number of databases the pass completed in
 */
export async function forEachBook(label, fn) {
  let databases;
  try {
    databases = await allUserDatabases();
  } catch (err) {
    // The user list is unreadable. Fall back to the default database, which
    // is the behaviour this had before there were users at all.
    console.error(`[${label}] could not read the user list (${err.message}); using the default book`);
    databases = [undefined];
  }

  let done = 0;
  for (const db of databases) {
    try {
      await runWithDb(db, fn);
      done++;
    } catch (err) {
      console.error(`[${label}] ${db || "default"}: ${err.message}`);
    }
  }
  return done;
}
