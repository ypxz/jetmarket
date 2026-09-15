import { NextResponse } from "next/server";
import { sessionCookie, verifySession } from "@/lib/auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? undefined;
  const userId = verifySession(token);
  if (!userId || !token) {
    return NextResponse.redirect(new URL("/sign-in?error=invalid-token", url.origin));
  }
  const res = NextResponse.redirect(new URL(url.searchParams.get("next") ?? "/", url.origin));
  res.cookies.set(sessionCookie, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
