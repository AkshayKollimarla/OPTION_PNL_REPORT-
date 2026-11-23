import { NextResponse } from "next/server";
import { readSession, safeDbName } from "./lib/session";

/**
 * Who is asking, and which book they are allowed to see.
 *
 * Both answers are decided here and nowhere else. The session cookie is
 * signed, so the username and database inside it are the server's own word
 * rather than the browser's, and they are passed down to the route handlers
 * as request headers.
 *
 * Those headers are DELETED from every incoming request first. A header is
 * the client's to write: without this, anyone could have sent
 * `x-dash-db: options_pnl_report` and read the admin's book straight out of
 * their own session. They are set from the cookie or they are not set at all.
 *
 * The matcher covers everything but Next's own static output, including the
 * login page, so there is no path on which the strip is skipped.
 */
export async function middleware(request) {
  const { pathname } = request.nextUrl;

  const headers = new Headers(request.headers);
  headers.delete("x-dash-user");
  headers.delete("x-dash-db");
  headers.delete("x-dash-admin");

  // Signing in, and signing out, cannot require being signed in.
  const open = pathname.startsWith("/login") || pathname.startsWith("/api/auth");

  const session = await readSession(
    request.cookies.get("session_token")?.value,
    process.env.AUTH_SECRET
  );

  if (!session) {
    if (open) return NextResponse.next({ request: { headers } });
    // Behind a reverse proxy, request.url reports the origin Next is bound
    // to (http://localhost:3000) rather than the address the browser used,
    // so redirecting to it bounces the visitor to their own machine. The
    // forwarded headers the proxy sets are the only reliable source of the
    // public origin; fall back to request.url when running direct.
    const host  = request.headers.get("x-forwarded-host") || request.headers.get("host");
    const proto = request.headers.get("x-forwarded-proto") || "http";
    const base  = host ? `${proto}://${host}` : request.url;
    const res = NextResponse.redirect(new URL("/login", base));
    // A cookie that no longer verifies -- expired, or signed with a secret
    // that has since changed -- would otherwise be sent on every request
    // forever, redirecting each time.
    res.cookies.set("session_token", "", { path: "/", maxAge: 0 });
    return res;
  }

  headers.set("x-dash-user", session.user);
  // Empty rather than absent for a session with no database recorded: the
  // pool falls back to the default, which is the admin's book, and only an
  // admin session is ever issued without one.
  headers.set("x-dash-db", safeDbName(session.db) || "");
  headers.set("x-dash-admin", session.admin ? "1" : "0");

  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except Next's own static output. The login page is included
  // deliberately -- it is let through inside the function, after the
  // client-supplied identity headers have been stripped.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
