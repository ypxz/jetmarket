import { NextResponse } from "next/server";
import { sessionCookie, signSession, verifyMagicLink } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? undefined;
  const userId = verifyMagicLink(token);
  if (!userId || !token) {
    return NextResponse.redirect(new URL("/sign-in?error=invalid-token", url.origin));
  }
  const user = await (await getRepo()).getUser(userId);
  if (!user) {
    return NextResponse.redirect(new URL("/sign-in?error=invalid-token", url.origin));
  }
  // `next` must be a site-relative path — an absolute URL would ride the
  // session cookie to an attacker domain (open redirect).
  const rawNext = url.searchParams.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
  const res = NextResponse.redirect(new URL(next, url.origin));
  res.cookies.set(sessionCookie, signSession(user.id, user.sessionVersion), {
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
