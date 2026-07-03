import { NextResponse } from "next/server";

export function middleware(request) {
  const session = request.cookies.get("session_token");
  const secret  = process.env.AUTH_SECRET;

  if (!session || session.value !== secret) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  // Protect everything except the login page, auth API, and Next.js internals
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon\\.ico).*)",
  ],
};
