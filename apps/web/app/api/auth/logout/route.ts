import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/api";
import { sessionCookie, verifySession } from "@/lib/auth";
import { appOrigin } from "@/lib/origin";
import { getRepo } from "@/lib/repo";

export async function POST(req: Request) {
  // Server-side revocation: bumping session_version invalidates every
  // outstanding session for this user, not just the cookie being cleared —
  // a stolen cookie keeps working after a victim's logout otherwise (QA-108).
  const cookie = req.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${sessionCookie}=([^;]*)`).exec(cookie);
  const sess = verifySession(m?.[1]);
  if (sess && rateLimit(`auth-logout:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    const repo = await getRepo();
    await repo.bumpSessionVersion(sess.userId);
  }
  // req.url derives from Host — never redirect to it. APP_URL is the only
  // trusted origin in production (QA-292); dev keeps the request origin.
  const res = NextResponse.redirect(new URL("/", appOrigin(req)));
  res.cookies.set(sessionCookie, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
