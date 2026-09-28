import { NextResponse } from "next/server";
import { sessionCookie, verifySession } from "@/lib/auth";
import { getRepo } from "@/lib/repo";

export async function POST(req: Request) {
  // Server-side revocation: bumping session_version invalidates every
  // outstanding session for this user, not just the cookie being cleared —
  // a stolen cookie keeps working after a victim's logout otherwise (QA-108).
  const cookie = req.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${sessionCookie}=([^;]*)`).exec(cookie);
  const sess = verifySession(m?.[1]);
  if (sess) {
    const repo = await getRepo();
    await repo.bumpSessionVersion(sess.userId);
  }
  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(sessionCookie, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
