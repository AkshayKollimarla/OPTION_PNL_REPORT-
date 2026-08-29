import { NextResponse } from "next/server";

export function middleware(request) {
  const session = request.cookies.get("session_token");
  const secret  = process.env.AUTH_SECRET;

  if (!session || session.value !== secret) {
    // Behind a reverse proxy, request.url reports the origin Next is bound
    // to (http://localhost:3000) rather than the address the browser used,
    // so redirecting to it bounces the visitor to their own machine. The
    // forwarded headers the proxy sets are the only reliable source of the
    // public origin; fall back to request.url when running direct.
    const host  = request.headers.get("x-forwarded-host") || request.headers.get("host");
    const proto = request.headers.get("x-forwarded-proto") || "http";
    const base  = host ? `${proto}://${host}` : request.url;
    return NextResponse.redirect(new URL("/login", base));
  }
  return NextResponse.next();
}

export const config = {
  // Protect everything except the login page, auth API, and Next.js internals
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon\.ico).*)",
  ],
};
