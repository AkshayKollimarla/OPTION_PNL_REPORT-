import { NextResponse } from "next/server";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

/**
 * Who this browser is signed in as.
 *
 * Read from the headers middleware set out of the signed cookie, not from
 * anything the page asked for. Nothing secret comes back -- a name and a
 * role -- but the page showing the wrong name would be worse than showing
 * none, since the whole point of it is to say whose book is on screen.
 */
export async function GET() {
  const h = headers();
  const user = h.get("x-dash-user");
  if (!user) return NextResponse.json({ user: null }, { status: 200 });
  return NextResponse.json({
    user,
    admin: h.get("x-dash-admin") === "1",
  });
}
