// The session cookie: who is signed in, in a form a browser cannot rewrite.
//
// It used to be AUTH_SECRET verbatim -- one shared constant meaning "someone
// signed in". That was enough while there was only ever one someone. With
// more than one user the cookie has to NAME its user, and a name the browser
// holds is a name the browser can edit: anyone could have typed the admin's
// username into their own cookie and read the admin's book.
//
// So the cookie is `payload.signature`, signed with AUTH_SECRET. The payload
// is readable -- it is not a secret, it is a claim -- and the signature is
// what makes the claim stick.
//
// Web Crypto rather than node:crypto, because this is verified in
// middleware, which Next 14 runs on the Edge runtime where node:crypto does
// not exist. Web Crypto is present in both, so there is one implementation
// rather than two that can drift.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const str = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(str, (c) => c.charCodeAt(0));
}

const keyFor = (secret) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]);

/**
 * A signed cookie value for this user.
 *
 * The database travels in the payload rather than being looked up per
 * request: middleware is the only place that knows who is asking, and it
 * runs on the Edge runtime, which has no database driver. Signed, so it is
 * as trustworthy as the username beside it.
 */
export async function signSession({ user, db, admin = false, days = 7 }, secret) {
  if (!user || !secret) throw new Error("A user and a secret are required.");
  const body = b64url(enc.encode(JSON.stringify({
    u: user, d: db || "", a: admin ? 1 : 0, e: Date.now() + days * 86_400_000,
  })));
  const sig = await crypto.subtle.sign("HMAC", await keyFor(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

/**
 * The user a cookie names, or null for anything that does not verify.
 *
 * Null covers every failure for the same reason: a cookie that is missing,
 * truncated, forged, for another secret, or simply expired all mean the same
 * thing to the caller -- this request has no user -- and distinguishing them
 * in the answer tells an attacker which part they got wrong.
 */
export async function readSession(token, secret) {
  if (!token || !secret) return null;
  const dot = String(token).lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  try {
    const ok = await crypto.subtle.verify("HMAC", await keyFor(secret), unb64url(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(dec.decode(unb64url(body)));
    if (!p || typeof p.u !== "string" || !p.u) return null;
    if (!Number.isFinite(p.e) || Date.now() > p.e) return null;
    return { user: p.u, db: typeof p.d === "string" ? p.d : "", admin: p.a === 1 };
  } catch {
    // Malformed base64, malformed JSON, a signature of the wrong length --
    // all of it is "not a session".
    return null;
  }
}

/**
 * A database name safe to connect to.
 *
 * The name arrives from a signed cookie, so it is already the server's own
 * word -- this is the second lock. A name is a bare identifier or it is not
 * used at all, which keeps anything that could be read as SQL out of a
 * connection string even if the first lock ever failed.
 */
export const SAFE_DB = /^[A-Za-z0-9_]{1,64}$/;
export const safeDbName = (name) => (SAFE_DB.test(String(name || "")) ? String(name) : null);
