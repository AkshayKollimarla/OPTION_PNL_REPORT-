import { NextResponse } from "next/server";

// ── Login throttling ──────────────────────────────────────────────────────
// The dashboard is internet-facing and places live orders, so an unlimited
// guessing rate is the whole attack. State is in-process, which is correct
// here: PM2 runs a single fork, so every login hits this same map.
const WINDOW_MS   = 15 * 60 * 1000; // failures older than this stop counting
const MAX_FAILURES = 5;             // per window, per IP
const BLOCK_MS    = 15 * 60 * 1000; // lockout once the limit is hit
const MAX_TRACKED = 5000;           // bound the map — see prune() below

const attempts = new Map(); // ip -> { failures, windowStart, blockedUntil }

// An attacker rotating source addresses would otherwise grow this map without
// limit, and this box has under 1 GB of RAM. Drop expired entries first, then
// oldest-first if still over budget.
function prune(now) {
  for (const [ip, a] of attempts) {
    if (now - a.windowStart > WINDOW_MS && now > (a.blockedUntil || 0)) attempts.delete(ip);
  }
  if (attempts.size > MAX_TRACKED) {
    const oldest = [...attempts.entries()]
      .sort((a, b) => a[1].windowStart - b[1].windowStart)
      .slice(0, attempts.size - MAX_TRACKED);
    for (const [ip] of oldest) attempts.delete(ip);
  }
}

// Caddy APPENDS the real peer address to any X-Forwarded-For the client sent,
// so the LAST entry is the one the proxy vouches for. Reading the first entry
// instead would let an attacker rotate forged values and evade the limit
// entirely. Next binds to loopback, so nothing reaches here except via Caddy.
function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request) {
  const now = Date.now();
  const ip  = clientIp(request);

  if (attempts.size > MAX_TRACKED) prune(now);

  const rec = attempts.get(ip);
  if (rec?.blockedUntil && now < rec.blockedUntil) {
    const retryAfter = Math.ceil((rec.blockedUntil - now) / 1000);
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }

  const { username, password } = body;

  if (
    username !== process.env.AUTH_USERNAME ||
    password !== process.env.AUTH_PASSWORD
  ) {
    // Start a fresh window if the previous one has aged out, so occasional
    // typos months apart never accumulate into a lockout.
    const a = (rec && now - rec.windowStart < WINDOW_MS)
      ? rec
      : { failures: 0, windowStart: now, blockedUntil: 0 };
    a.failures += 1;
    if (a.failures >= MAX_FAILURES) a.blockedUntil = now + BLOCK_MS;
    attempts.set(ip, a);

    const left = MAX_FAILURES - a.failures;
    return NextResponse.json(
      {
        error: a.blockedUntil
          ? `Too many failed attempts. Try again in ${Math.ceil(BLOCK_MS / 60000)} minutes.`
          : `Invalid username or password.${left <= 2 ? ` ${left} attempt(s) remaining.` : ""}`,
      },
      { status: a.blockedUntil ? 429 : 401 }
    );
  }

  attempts.delete(ip); // clean slate on success

  const res = NextResponse.json({ ok: true });
  res.cookies.set("session_token", process.env.AUTH_SECRET, {
    httpOnly: true,
    sameSite: "strict",
    // Served over HTTPS in production; browsers still accept Secure cookies
    // on http://localhost, so local development is unaffected.
    secure: true,
    path: "/",
    maxAge: 7 * 24 * 60 * 60, // 7 days
  });
  return res;
}
